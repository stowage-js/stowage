import type { Server } from "node:http";

import {
  Controller,
  Delete,
  Get,
  Inject,
  Module,
  Param,
  Post,
  Put,
  Req,
  Res,
  type Type,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";

import {
  type S3AdapterOptions,
  type S3Storage,
  s3Storage,
} from "../../../packages/adapter-s3/src/index.ts";
import { acceptUpload, redirectToObject, serveObject } from "../../../packages/http/src/index.ts";
import { sendResponse, StorageModule, webRequestOf } from "../../../packages/nestjs/src/index.ts";
import type { HttpServer, StartedServer } from "./http.ts";
import { presign, type RouteOptions, routeUrls, suiteRoutes } from "./routes.ts";

/** The injection token the application registers its storage under (spec 11). */
const storageToken = Symbol("storage");

type Answer = (storage: S3Storage, key: string, request: Request) => Promise<Response>;

/** Spec 14.8's routes, each configured as the suite fixes, `routes` aside. */
function answersOf(routes: RouteOptions): Readonly<Record<string, Answer>> {
  return {
    serve: serveObject,
    redirect: async (storage, key, request) =>
      await redirectToObject(storage, key, request, { expiresIn: 60 }),
    upload: async (storage, key, request) =>
      await acceptUpload(storage, key, request, { maxSize: routes.maxSize }),
    presign,
  };
}

/**
 * The methods spec 14.8 has the cases send to a route that hands each one to the layer, as
 * the handler each is mapped to. `HEAD` is not among them: Express and Fastify route it to
 * the `GET` handler, and the request `webRequestOf` builds keeps the method `HEAD`.
 */
const sentMethods = [
  ["get", Get],
  ["post", Post],
  ["put", Put],
  ["delete", Delete],
] as const;

/**
 * A controller for one of spec 14.8's routes as an application writes it: the storage
 * through `@Inject(token)`, each handler taking `@Req()` and `@Res()` and answering through
 * `webRequestOf` and `sendResponse`, the same on both platforms. The harness's sources keep
 * to `erasableSyntaxOnly` as the packages' do, so NestJS's decorator functions are called
 * directly, where an application writes them as decorators (ADR 0047).
 */
function controllerOf(route: string, answer: Answer): Type {
  // One handler per method, since NestJS maps each handler to one method alone.
  class RouteController {
    readonly #storage: S3Storage;

    constructor(storage: S3Storage) {
      this.#storage = storage;
    }

    async get(key: string, req: unknown, res: unknown): Promise<void> {
      await this.#answer(key, req, res);
    }

    async post(key: string, req: unknown, res: unknown): Promise<void> {
      await this.#answer(key, req, res);
    }

    async put(key: string, req: unknown, res: unknown): Promise<void> {
      await this.#answer(key, req, res);
    }

    async delete(key: string, req: unknown, res: unknown): Promise<void> {
      await this.#answer(key, req, res);
    }

    async #answer(key: string, req: unknown, res: unknown): Promise<void> {
      await sendResponse(res, await answer(this.#storage, key, webRequestOf(req, res)));
    }
  }

  Controller(route)(RouteController);
  Inject(storageToken)(RouteController, undefined, 0);

  for (const [name, mapping] of sentMethods) {
    const descriptor = Object.getOwnPropertyDescriptor(RouteController.prototype, name);

    if (descriptor === undefined) throw new Error(`No handler \`${name}\``);

    mapping(":key")(RouteController.prototype, name, descriptor);
    Param("key")(RouteController.prototype, name, 0);
    Req()(RouteController.prototype, name, 1);
    Res()(RouteController.prototype, name, 2);
  }

  return RouteController;
}

/** The application's root module, registering `storage` through `StorageModule.forRoot`. */
function applicationModuleOf(storage: S3Storage, routes: RouteOptions): Type {
  // oxlint-disable-next-line no-extraneous-class -- NestJS reads a module from its metadata alone
  class ApplicationModule {}

  Module({
    imports: [StorageModule.forRoot({ provide: storageToken, storage })],
    controllers: Object.entries(answersOf(routes)).map(([route, answer]) =>
      controllerOf(route, answer),
    ),
  })(ApplicationModule);

  return ApplicationModule;
}

/**
 * The application on `adapter` listening through `app.listen` on a free port of the loopback
 * address. Spec 16's `bodyParser: false` leaves an upload's body unread, whatever its content
 * type. Its connections close with it, since `fetch` keeps them alive and would hold `close`
 * open until they idle out.
 */
async function startedApp(
  adapter: ExpressAdapter | FastifyAdapter,
  configured: S3AdapterOptions,
  routes: RouteOptions,
): Promise<StartedServer> {
  const app = await NestFactory.create(
    applicationModuleOf(s3Storage(configured), routes),
    adapter,
    {
      bodyParser: false,
      forceCloseConnections: true,
      logger: false,
    },
  );

  await app.listen(0, "127.0.0.1");

  // oxlint-disable-next-line no-unsafe-type-assertion -- both platforms listen on `node:http`'s server
  const address = (app.getHttpServer() as Server).address();

  if (address === null || typeof address === "string") throw new Error("No TCP port to reach");

  return {
    url: routeUrls(`http://127.0.0.1:${address.port}`),
    close: async () => await app.close(),
  };
}

/** Spec 2's cell of `@stowage/nestjs` on Express. */
export const nestjsOnExpress: HttpServer = {
  name: "@stowage/nestjs on Express",
  start: async (configured, routes = suiteRoutes) =>
    await startedApp(new ExpressAdapter(), configured, routes),
};

/**
 * Spec 2's cell of `@stowage/nestjs` on Fastify. Fastify streams a body only through a
 * content type parser that leaves the payload unread (spec 16), and its own parsers for
 * JSON and plain text would read an upload of either before the handler.
 */
export const nestjsOnFastify: HttpServer = {
  name: "@stowage/nestjs on Fastify",
  start: async (configured, routes = suiteRoutes) => {
    const adapter = new FastifyAdapter();

    adapter.getInstance().removeAllContentTypeParsers();
    adapter.getInstance().addContentTypeParser("*", (_req, _payload, done) => done(null));

    return await startedApp(adapter, configured, routes);
  },
};
