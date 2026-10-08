import {
  Controller,
  Get,
  type INestApplication,
  Inject,
  Module,
  Put,
  Req,
  Res,
  type Type,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { memoryStorage } from "@stowage/adapter-memory";
import type { Storage } from "@stowage/core";
import { acceptUpload, serveObject } from "@stowage/http";
import { afterEach, describe, expect, test } from "vitest";

import { sendResponse, StorageModule, webRequestOf } from "./index.ts";

const files = Symbol("files");

/** What a handler threw before it answered, which NestJS answers with a `500` of its own. */
const thrown: unknown[] = [];

/**
 * A controller as an application writes it, `@Inject(files)` on the constructor and
 * `@Req()` and `@Res()` on each handler, with NestJS's decorator functions called directly.
 * Each handler reads the same on both platforms.
 */
class FilesController {
  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  async serve(req: unknown, res: unknown): Promise<void> {
    await sendResponse(res, await serveObject(this.#storage, "file", webRequestOf(req, res)));
  }

  async upload(req: unknown, res: unknown): Promise<void> {
    let request: Request;

    try {
      request = webRequestOf(req, res);
    } catch (failure) {
      thrown.push(failure);
      throw failure;
    }

    await sendResponse(res, await acceptUpload(this.#storage, "file", request, { maxSize: 64 }));
  }
}

Controller()(FilesController);
Inject(files)(FilesController, undefined, 0);

for (const [name, mapping] of [
  ["serve", Get("file")],
  ["upload", Put("file")],
] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(FilesController.prototype, name);

  if (descriptor === undefined) throw new Error(`No handler \`${name}\``);

  mapping(FilesController.prototype, name, descriptor);
  Req()(FilesController.prototype, name, 0);
  Res()(FilesController.prototype, name, 1);
}

function applicationModuleOf(storage: Storage): Type {
  // oxlint-disable-next-line no-extraneous-class -- NestJS reads a module from its metadata alone
  class ApplicationModule {}

  Module({
    imports: [StorageModule.forRoot({ provide: files, storage })],
    controllers: [FilesController],
  })(ApplicationModule);

  return ApplicationModule;
}

interface Platform {
  readonly name: string;
  /** The application with its default body parsers, or with none where `bodyParser` is false. */
  create(root: Type, bodyParser: boolean): Promise<INestApplication>;
}

const platforms: readonly Platform[] = [
  {
    name: "Express",
    create: async (root, bodyParser) =>
      await NestFactory.create(root, new ExpressAdapter(), { bodyParser, logger: false }),
  },
  {
    name: "Fastify",
    create: async (root, bodyParser) => {
      const adapter = new FastifyAdapter();

      // Spec 16: the parser that leaves every payload unread, after Fastify's own.
      if (!bodyParser) {
        adapter.getInstance().removeAllContentTypeParsers();
        adapter.getInstance().addContentTypeParser("*", (_req, _payload, done) => done(null));
      }

      return await NestFactory.create(root, adapter, { bodyParser, logger: false });
    },
  },
];

const running: INestApplication[] = [];

afterEach(async () => {
  thrown.length = 0;
  await Promise.all(running.splice(0).map(async (app) => await app.close()));
});

async function started(platform: Platform, storage: Storage, bodyParser = false): Promise<string> {
  const app = await platform.create(applicationModuleOf(storage), bodyParser);

  running.push(app);
  await app.listen(0, "127.0.0.1");

  return `${await app.getUrl()}/file`.replace("[::1]", "127.0.0.1");
}

describe.each(platforms)("on $name", (platform) => {
  test("a handler answers through `serveObject`", async () => {
    const storage = memoryStorage();

    await storage.put("file", "stowage", { contentType: "text/plain" });

    const answer = await fetch(await started(platform, storage));

    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/plain");
    expect(await answer.text()).toBe("stowage");
  });

  // Spec 10.3: the framework routes `HEAD` to the `GET` handler, and the bridge sends no body.
  test("`HEAD` reaches the handler as `HEAD` and is answered without a body", async () => {
    const storage = memoryStorage();

    await storage.put("file", "stowage", { contentType: "text/plain" });

    const answer = await fetch(await started(platform, storage), { method: "HEAD" });

    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("text/plain");
    expect(answer.headers.get("content-length")).toBe("7");
    expect(await answer.text()).toBe("");
  });

  test("an upload streams into `acceptUpload` without a body parser", async () => {
    const storage = memoryStorage();
    const answer = await fetch(await started(platform, storage), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: '{"stowage":true}',
    });

    expect(answer.status).toBe(201);
    expect(await (await storage.get("file")).text()).toBe('{"stowage":true}');
  });

  // Spec 11, ADR 0051: a body the default parsers read is the caller's programmer error,
  // not an empty object to store.
  test("a body NestJS's default parsers read makes `webRequestOf` throw the bridge's `TypeError`", async () => {
    const storage = memoryStorage();
    const answer = await fetch(await started(platform, storage, true), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: '{"stowage":true}',
    });

    expect(answer.status).toBe(500);
    expect(thrown).toEqual([expect.any(TypeError)]);
    expect(String(thrown[0])).toMatch(/was read before `toWebRequest`/u);
    await expect(storage.stat("file")).rejects.toMatchObject({ code: "NotFound" });
  });
});

describe("telling the platforms apart", () => {
  test("`sendResponse` hijacks a Fastify reply before it writes into its `raw`", async () => {
    const calls: string[] = [];
    const raw = {
      statusCode: 0,
      writableEnded: false,
      writableFinished: false,
      destroyed: false,
      setHeader: () => calls.push("setHeader"),
      write: () => true,
      end: () => calls.push("end"),
      destroy: () => {},
      on: () => {},
    };
    const hijack = (): void => void calls.push("hijack");

    await sendResponse({ raw, hijack }, new Response(null, { status: 204 }));

    expect(calls.filter((call) => call === "hijack")).toHaveLength(1);
    expect(calls[0]).toBe("hijack");
    expect(raw.statusCode).toBe(204);
  });

  test.each([
    ["nothing", undefined],
    ["a plain object", {}],
    ["a reply without `hijack`", { raw: {} }],
  ])("`webRequestOf` refuses %s as a request with a `TypeError`", (_name, value) => {
    expect(() => webRequestOf(value, value)).toThrow(TypeError);
  });

  test("`sendResponse` refuses what is neither an Express response nor a Fastify reply", async () => {
    await expect(sendResponse({}, new Response(null))).rejects.toThrow(TypeError);
  });
});
