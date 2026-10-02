import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, test } from "vitest";

import {
  type NodeRequest,
  type NodeResponse,
  serveObject,
  toWebRequest,
  writeResponse,
} from "./index.ts";
import { statOf, storedObject, streamOf, stubStorage } from "./stubs.ts";

/** A response that records what the bridge does to it, and that a test closes at will. */
class RecordedResponse implements NodeResponse {
  statusCode = 200;
  writableEnded = false;
  writableFinished = false;
  readonly headers = new Map<string, string | readonly string[]>();
  readonly chunks: string[] = [];
  destroyedWith: Error | "nothing" | undefined;
  /** What `write` answers, which is `false` where the client's buffer is full. */
  accepts = true;
  private readonly listeners = new Map<string, (() => void)[]>();

  setHeader(name: string, value: string | readonly string[]): this {
    this.headers.set(name, value);

    return this;
  }

  write(chunk: Uint8Array): boolean {
    this.chunks.push(new TextDecoder().decode(chunk));

    return this.accepts;
  }

  end(): this {
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit("close");

    return this;
  }

  destroy(error?: Error): this {
    this.destroyedWith = error ?? "nothing";
    this.emit("close");

    return this;
  }

  on(event: "drain" | "close", listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);

    return this;
  }

  emit(event: "drain" | "close"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

const nodeRequest = (fields: Partial<NodeRequest> = {}): NodeRequest => ({
  method: "GET",
  url: "/files/report.pdf?download=1",
  headers: { host: "example.test:8080" },
  socket: {},
  readableDidRead: false,
  on() {
    return this;
  },
  pause() {
    return this;
  },
  resume() {
    return this;
  },
  ...fields,
});

/** A body whose chunks a test hands over one by one, recording whether it was canceled. */
function controlledBody(): {
  readonly body: ReadableStream<Uint8Array>;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  readonly canceled: () => boolean;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start: (opened) => void (controller = opened),
    cancel: () => void (canceled = true),
  });

  if (controller === undefined) throw new Error("The stream started without a controller");

  return { body, controller, canceled: () => canceled };
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Lets the bridge's pending reads and writes run. */
const settle = async (): Promise<void> => await new Promise((resolve) => setTimeout(resolve, 0));

describe("`toWebRequest`", () => {
  test("carries the method and the headers of `req`", () => {
    const request = toWebRequest(
      nodeRequest({
        method: "DELETE",
        headers: { host: "example.test", "x-one": "1", accept: ["text/plain", "text/html"] },
      }),
      new RecordedResponse(),
    );

    expect(request.method).toBe("DELETE");
    expect(request.headers.get("x-one")).toBe("1");
    expect(request.headers.get("accept")).toBe("text/plain, text/html");
  });

  test("builds the URL from `Host` and `req.url` over `http:`", () => {
    expect(toWebRequest(nodeRequest(), new RecordedResponse()).url).toBe(
      "http://example.test:8080/files/report.pdf?download=1",
    );
  });

  test("builds an `https:` URL where the socket is encrypted", () => {
    const request = toWebRequest(
      nodeRequest({ socket: { encrypted: true } }),
      new RecordedResponse(),
    );

    expect(request.url).toBe("https://example.test:8080/files/report.pdf?download=1");
  });

  test("names `localhost` without a `Host` header", () => {
    expect(toWebRequest(nodeRequest({ headers: {} }), new RecordedResponse()).url).toBe(
      "http://localhost/files/report.pdf?download=1",
    );
  });

  test("aborts its signal once `res` closes before it has finished", () => {
    const res = new RecordedResponse();
    const request = toWebRequest(nodeRequest(), res);

    expect(request.signal.aborted).toBe(false);

    res.emit("close");

    expect(request.signal.aborted).toBe(true);
  });

  test("leaves its signal alone once `res` has finished", () => {
    const res = new RecordedResponse();
    const request = toWebRequest(nodeRequest(), res);

    res.end();

    expect(request.signal.aborted).toBe(false);
  });
});

describe("`writeResponse`", () => {
  test("writes the status and the headers, each `Set-Cookie` apart", async () => {
    const res = new RecordedResponse();
    const headers = new Headers({ "content-type": "text/plain", etag: '"a"' });

    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");

    await writeResponse(res, new Response(null, { status: 404, headers }));

    expect(res.statusCode).toBe(404);
    expect(Object.fromEntries(res.headers)).toEqual({
      "content-type": "text/plain",
      etag: '"a"',
      "set-cookie": ["a=1", "b=2"],
    });
  });

  test("writes the body chunk by chunk and resolves once the response has ended", async () => {
    const res = new RecordedResponse();
    const { body, controller } = controlledBody();
    const written = writeResponse(res, new Response(body));

    controller.enqueue(bytes("one"));
    await settle();

    expect(res.chunks).toEqual(["one"]);

    controller.enqueue(bytes("two"));
    controller.close();
    await written;

    expect(res.chunks).toEqual(["one", "two"]);
    expect(res.writableEnded).toBe(true);
  });

  test("waits for `drain` before it reads the next chunk", async () => {
    const res = new RecordedResponse();
    const { body, controller } = controlledBody();

    res.accepts = false;
    const written = writeResponse(res, new Response(body));

    controller.enqueue(bytes("one"));
    controller.enqueue(bytes("two"));
    await settle();

    expect(res.chunks).toEqual(["one"]);

    res.accepts = true;
    res.emit("drain");
    controller.close();
    await written;

    expect(res.chunks).toEqual(["one", "two"]);
  });

  test("writes no body for a `304`", async () => {
    const res = new RecordedResponse();

    await writeResponse(res, new Response(null, { status: 304, headers: { etag: '"a"' } }));

    expect(res.statusCode).toBe(304);
    expect(res.chunks).toEqual([]);
    expect(res.writableEnded).toBe(true);
  });

  test("writes no body for a `HEAD` request and cancels it", async () => {
    const res = new RecordedResponse();
    const { body, canceled } = controlledBody();

    toWebRequest(nodeRequest({ method: "HEAD" }), res);
    await writeResponse(res, new Response(body));

    expect(res.chunks).toEqual([]);
    expect(res.writableEnded).toBe(true);
    expect(canceled()).toBe(true);
  });

  test("cancels the body and resolves once the client disconnects", async () => {
    const res = new RecordedResponse();
    const { body, controller, canceled } = controlledBody();
    const written = writeResponse(res, new Response(body));

    controller.enqueue(bytes("one"));
    await settle();
    res.emit("close");
    await written;

    expect(canceled()).toBe(true);
    expect(res.writableEnded).toBe(false);
  });

  test("cancels the body while it waits for `drain` and the client disconnects", async () => {
    const res = new RecordedResponse();
    const { body, controller, canceled } = controlledBody();

    res.accepts = false;
    const written = writeResponse(res, new Response(body));

    controller.enqueue(bytes("one"));
    await settle();
    res.emit("close");
    await written;

    expect(canceled()).toBe(true);
  });

  test("cancels the body of a response whose client disconnected before it was written", async () => {
    const res = new RecordedResponse();
    const { body, canceled } = controlledBody();

    toWebRequest(nodeRequest(), res);
    res.emit("close");
    await writeResponse(res, new Response(body));

    expect(canceled()).toBe(true);
    expect(res.chunks).toEqual([]);
  });

  test("destroys `res` and rejects with the error of a body that fails", async () => {
    const res = new RecordedResponse();
    const { body, controller } = controlledBody();
    const failure = new Error("The provider reset the connection");
    const written = writeResponse(res, new Response(body));

    controller.enqueue(bytes("one"));
    await settle();
    controller.error(failure);

    await expect(written).rejects.toBe(failure);
    expect(res.destroyedWith).toBe(failure);
    expect(res.writableEnded).toBe(false);
  });
});

describe("over `node:http`", () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
  });

  /** `IncomingMessage` and `ServerResponse` stand for `NodeRequest` and `NodeResponse` as they are. */
  const listen = async (): Promise<URL> => {
    const storage = stubStorage({
      get: async () => storedObject(statOf({ contentType: "text/plain" }), streamOf("the bytes")),
      stat: async () => statOf({ contentType: "text/plain" }),
    });

    server = createServer((req, res) => {
      const request = toWebRequest(req, res);

      void serveObject(storage, "docs/report.txt", request).then(
        async (response) => await writeResponse(res, response),
      );
    });

    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));

    const address = server.address();

    if (address === null || typeof address === "string") throw new Error("No TCP port to reach");

    return new URL(`http://127.0.0.1:${address.port}/files/report`);
  };

  test("serves a `GET` with the body and a `HEAD` without one", async () => {
    const url = await listen();
    const get = await fetch(url);
    const head = await fetch(url, { method: "HEAD" });

    expect(get.status).toBe(200);
    expect(await get.text()).toBe("the bytes");
    expect(get.headers.get("content-type")).toBe("text/plain");
    expect(get.headers.has("content-length")).toBe(false);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("etag")).toBe('"0123abcd"');
  });
});
