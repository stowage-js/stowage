import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import {
  acceptUpload,
  type NodeRequest,
  type NodeResponse,
  serveObject,
  toWebRequest,
  writeResponse,
} from "./index.ts";
import { holdingStorage, statOf, storedObject, streamOf, stubStorage } from "./stubs.ts";

/**
 * A request whose body a test hands over event by event, recording `pause` and `resume`. As
 * on Node, chunks and the end wait until a `data` listener asks for them.
 */
class StreamingRequest implements NodeRequest {
  readonly url = "/uploads/report";
  readonly headers = { host: "example.test" };
  readonly socket = {};
  readableDidRead = false;
  paused = false;
  resumed = false;
  readonly method: string;
  private readonly listeners = new Map<string, ((value: never) => void)[]>();
  private readonly unread: Uint8Array[] = [];
  private endUnread = false;

  constructor(method = "PUT") {
    this.method = method;
  }

  on(event: "data", listener: (chunk: Uint8Array) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: string, listener: (value: never) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);

    if (event === "data") {
      for (const chunk of this.unread.splice(0)) this.emit("data", chunk);
      if (this.endUnread) this.emit("end");
    }

    return this;
  }

  pause(): this {
    this.paused = true;

    return this;
  }

  resume(): this {
    this.paused = false;
    this.resumed = true;

    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  emit(event: "data", chunk: Uint8Array): void;
  emit(event: "end"): void;
  emit(event: "error", error: Error): void;
  emit(event: string, value?: unknown): void {
    if (event !== "error" && this.listenerCount("data") === 0) {
      if (value instanceof Uint8Array) this.unread.push(value);
      else this.endUnread = true;
      return;
    }

    // oxlint-disable-next-line no-unsafe-type-assertion -- each overload above pairs an event with its value
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }
}

/** A response that records what the bridge does to it, and that a test closes at will. */
class RecordedResponse implements NodeResponse {
  statusCode = 200;
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
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
    this.destroyed = true;
    this.emit("close");

    return this;
  }

  /** What Node does to a response whose client left: it is destroyed, then closes. */
  disconnect(): void {
    this.destroyed = true;
    this.emit("close");
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

    res.disconnect();

    expect(request.signal.aborted).toBe(true);
  });

  test("aborts its signal for a `res` that closed before it was called", () => {
    const res = new RecordedResponse();

    res.disconnect();

    expect(toWebRequest(nodeRequest(), res).signal.aborted).toBe(true);
  });

  test("leaves its signal alone once `res` has finished", () => {
    const res = new RecordedResponse();
    const request = toWebRequest(nodeRequest(), res);

    res.end();

    expect(request.signal.aborted).toBe(false);
  });

  test("leaves its signal alone once the request body has ended", async () => {
    const req = new StreamingRequest();
    const request = toWebRequest(req, new RecordedResponse());
    const read = request.text();

    req.emit("data", bytes("x"));
    req.emit("end");

    expect(await read).toBe("x");
    expect(request.signal.aborted).toBe(false);
  });

  test("throws a `TypeError` for a `req` whose body was already read", () => {
    expect(() =>
      toWebRequest(nodeRequest({ readableDidRead: true }), new RecordedResponse()),
    ).toThrow(TypeError);
  });
});

describe("the body of `toWebRequest`", () => {
  test.each(["GET", "HEAD"])("is `null` for `%s`", (method) => {
    expect(toWebRequest(new StreamingRequest(method), new RecordedResponse()).body).toBeNull();
  });

  test.each(["PUT", "POST", "DELETE", "PATCH", "OPTIONS"])(
    "streams the body of `req` for `%s`",
    async (method) => {
      const req = new StreamingRequest(method);
      const read = toWebRequest(req, new RecordedResponse()).text();

      req.emit("data", bytes("one "));
      req.emit("data", bytes("two"));
      req.emit("end");

      expect(await read).toBe("one two");
    },
  );

  test("leaves `req` without a `data` listener until the body is read", async () => {
    const req = new StreamingRequest();
    const body = toWebRequest(req, new RecordedResponse()).body;

    // Node discards a body no `data` listener asked for once the response has ended, so a
    // refusal the layer answers unread leaves the connection free for the next request.
    expect(req.listenerCount("data")).toBe(0);

    const read = body?.getReader().read();

    await settle();

    expect(req.listenerCount("data")).toBe(1);

    req.emit("data", bytes("one"));
    await read;
  });

  test("pauses `req` once a chunk is handed over, and resumes it at the next read", async () => {
    const req = new StreamingRequest();
    const reader = toWebRequest(req, new RecordedResponse()).body?.getReader();
    const first = reader?.read();

    await settle();
    req.emit("data", bytes("one"));

    expect(req.paused).toBe(true);
    expect(new TextDecoder().decode((await first)?.value)).toBe("one");

    void reader?.read();
    await settle();

    expect(req.paused).toBe(false);
  });

  test("fails with the error of `req`", async () => {
    const req = new StreamingRequest();
    const failure = new Error("aborted");
    const read = toWebRequest(req, new RecordedResponse()).text();

    req.emit("data", bytes("one"));
    req.emit("error", failure);

    await expect(read).rejects.toBe(failure);
  });

  test("fails before its signal aborts once `res` closes while the body is unread", async () => {
    const req = new StreamingRequest();
    const res = new RecordedResponse();
    // An adapter stops reading at the signal, as `pipeTo` does, and rejects with its reason.
    const storage = stubStorage({
      put: async (_key, body, options) => {
        if (!(body instanceof ReadableStream)) throw new Error("The layer handed `put` no stream");

        await body.pipeTo(new WritableStream(), { signal: options?.signal });

        return statOf();
      },
    });
    const answered = acceptUpload(storage, "a", toWebRequest(req, res), { maxSize: 1024 });

    req.emit("data", bytes("one"));
    await settle();
    // Node closes the response of a reset connection before the request emits its error,
    // and the layer answers a body that failed with `400`, an abort by throwing it on.
    res.disconnect();

    expect((await answered).status).toBe(400);
  });

  test("lets `req` flow once `writeResponse` ended a response that left the body unread", async () => {
    const req = new StreamingRequest();
    const res = new RecordedResponse();

    toWebRequest(req, res);
    await writeResponse(res, new Response(null, { status: 413 }));

    expect(req.resumed).toBe(true);
    expect(req.listenerCount("data")).toBe(0);
  });

  test.each([null, "refused"])(
    "drains a partially read body whose reader was released, with response body %s",
    async (responseBody) => {
      const req = new StreamingRequest();
      const res = new RecordedResponse();
      const body = toWebRequest(req, res).body;
      const reader = body?.getReader();
      const first = reader?.read();

      await settle();
      req.emit("data", bytes("one"));
      await first;
      reader?.releaseLock();

      expect(req.paused).toBe(true);

      await writeResponse(res, new Response(responseBody, { status: 413 }));
      req.emit("data", bytes("two"));
      req.emit("end");

      expect(req.paused).toBe(false);
      await expect(body?.getReader().read()).resolves.toEqual({ done: true, value: undefined });
    },
  );

  test("leaves `req` paused where the body is still being read as the response ends", async () => {
    const req = new StreamingRequest();
    const res = new RecordedResponse();
    const reader = toWebRequest(req, res).body?.getReader();
    const first = reader?.read();

    await settle();
    req.emit("data", bytes("one"));
    await first;
    await writeResponse(res, new Response(null, { status: 202 }));

    expect(req.paused).toBe(true);

    const second = reader?.read();

    await settle();
    req.emit("data", bytes("two"));
    req.emit("end");

    expect(new TextDecoder().decode((await second)?.value)).toBe("two");
    await expect(reader?.read()).resolves.toEqual({ done: true, value: undefined });
  });

  test("resumes `req` once the body is canceled and drops what follows", async () => {
    const req = new StreamingRequest();
    const reader = toWebRequest(req, new RecordedResponse()).body?.getReader();
    const first = reader?.read();

    await settle();
    req.emit("data", bytes("one"));
    await first;

    expect(req.paused).toBe(true);

    await reader?.cancel();
    req.emit("data", bytes("two"));
    req.emit("end");

    expect(req.paused).toBe(false);
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
    res.disconnect();
    await written;

    expect(canceled()).toBe(true);
    expect(res.writableEnded).toBe(false);
  });

  test("resolves once the client disconnects and the body fails at the signal", async () => {
    const res = new RecordedResponse();
    const { signal } = toWebRequest(nodeRequest(), res);
    // The stream of `get` fails at the request's signal, as `fetch` fails its body.
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(bytes("one"));
        signal.addEventListener("abort", () => controller.error(signal.reason));
      },
    });
    const written = writeResponse(res, new Response(body));

    await settle();
    res.disconnect();

    await expect(written).resolves.toBeUndefined();
    expect(res.destroyedWith).toBeUndefined();
  });

  test("cancels the body while it waits for `drain` and the client disconnects", async () => {
    const res = new RecordedResponse();
    const { body, controller, canceled } = controlledBody();

    res.accepts = false;
    const written = writeResponse(res, new Response(body));

    controller.enqueue(bytes("one"));
    await settle();
    res.disconnect();
    await written;

    expect(canceled()).toBe(true);
  });

  test("cancels the body of a response whose client disconnected before it was written", async () => {
    const res = new RecordedResponse();
    const { body, canceled } = controlledBody();

    toWebRequest(nodeRequest(), res);
    res.disconnect();
    await writeResponse(res, new Response(body));

    expect(canceled()).toBe(true);
    expect(res.chunks).toEqual([]);
  });

  // A `res` that closed already emits no `close` that a listener added now would hear, and
  // a `write` to it answers `false` with no `drain` to follow.
  test.each([
    ["without `toWebRequest`", (): void => {}],
    [
      "with `toWebRequest` after the close",
      (res: RecordedResponse): void => {
        toWebRequest(nodeRequest(), res);
      },
    ],
  ])("cancels the body of a `res` that closed before it was written, %s", async (_, before) => {
    const res = new RecordedResponse();
    const { body, canceled } = controlledBody();

    res.accepts = false;
    res.disconnect();
    before(res);
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
      get: async () =>
        storedObject(statOf({ contentType: "text/plain", size: 9 }), streamOf("the bytes")),
      stat: async () => statOf({ contentType: "text/plain", size: 9 }),
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
    expect(get.headers.get("content-length")).toBe("9");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe("9");
    expect(head.headers.get("etag")).toBe('"0123abcd"');
  });

  test("cancels the body for a client that left before the answer was written", async () => {
    const { body, canceled } = controlledBody();
    let written: Promise<void> | undefined;
    const arrived = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();

    server = createServer((_req, res) => {
      arrived.resolve();
      res.on("close", () => {
        written = writeResponse(res, new Response(body));
        closed.resolve();
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));

    const address = server.address();

    if (address === null || typeof address === "string") throw new Error("No TCP port to reach");

    const client = new AbortController();
    const answered = fetch(`http://127.0.0.1:${address.port}/`, { signal: client.signal });

    await arrived.promise;
    client.abort();
    await answered.catch(() => {});
    await closed.promise;
    await written;

    expect(canceled()).toBe(true);
  });
});

/**
 * Writes `sent` as it is, lets `then` end the socket, and resolves with what the server
 * wrote back once the socket closed.
 */
const sendRaw = async (
  port: number,
  sent: string,
  then: (socket: Socket) => void | Promise<void>,
): Promise<string> =>
  await new Promise<string>((resolve) => {
    let received = "";
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(sent);
      void then(socket);
    });

    socket.on("error", () => {});
    socket.on("data", (chunk: Uint8Array) => void (received += new TextDecoder().decode(chunk)));
    socket.on("close", () => resolve(received));
  });

const textOf = (held: Uint8Array | undefined): string | undefined =>
  held === undefined ? undefined : new TextDecoder().decode(held);

// Spec 14.8: `fetch` cannot send a body that contradicts its `Content-Length`, nor fail one
// partway, so these are sent over a socket of their own. Node answers such a request with a
// `400` of its own and closes the connection, so what the layer answered is read on the
// server's side. A body that runs past its `Content-Length` cannot reach the layer through
// `node:http`, which reads the bytes after it as the next request; `acceptUpload`'s own
// tests send that one as a web `Request`.
describe("an upload over a raw socket", () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
  });

  /**
   * A server storing a `PUT` under `a`, which holds `before`. `arrived` resolves once the
   * request reached the layer, `answered` with what the layer answered it.
   */
  const listen = async (): Promise<{
    readonly port: number;
    readonly held: Map<string, Uint8Array>;
    readonly arrived: Promise<void>;
    readonly answered: Promise<Response>;
  }> => {
    const storage = holdingStorage({ held: { a: "before" } });
    const arrived = Promise.withResolvers<void>();
    const answered = Promise.withResolvers<Response>();

    server = createServer((req, res) => {
      const answer = acceptUpload(storage, "a", toWebRequest(req, res), { maxSize: 1024 });

      arrived.resolve();
      answer.then(answered.resolve, answered.reject);
      void answer.then(
        async (response) => await writeResponse(res, response),
        () => res.destroy(),
      );
    });

    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));

    const address = server.address();

    if (address === null || typeof address === "string") throw new Error("No TCP port to reach");

    return {
      port: address.port,
      held: storage.held,
      arrived: arrived.promise,
      answered: answered.promise,
    };
  };

  test("a body that ends short of its `Content-Length` answers `400` and leaves the key as it was", async () => {
    const { port, held, answered } = await listen();

    await sendRaw(
      port,
      "PUT /a HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\n01234",
      (socket) => void socket.end(),
    );

    expect((await answered).status).toBe(400);
    expect(textOf(held.get("a"))).toBe("before");
  });

  test("a body that fails while it is read answers `400` and leaves the key as it was", async () => {
    const { port, held, arrived, answered } = await listen();

    await sendRaw(
      port,
      "PUT /a HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n01234\r\n",
      async (socket) => {
        // The reset follows the first chunk once the layer reads the body.
        await arrived;
        await settle();
        socket.resetAndDestroy();
      },
    );

    expect((await answered).status).toBe(400);
    expect(textOf(held.get("a"))).toBe("before");
  });

  test("a body refused by its `Content-Length` is discarded, and the next request answered", async () => {
    const { port, answered } = await listen();
    const refused = `PUT /a HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4194304\r\n\r\n${"x".repeat(4194304)}`;
    const next =
      "PUT /a HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";
    const received = await sendRaw(port, refused + next, () => {});

    expect((await answered).status).toBe(413);
    expect(received.match(/^HTTP\/1\.1 \d+/gmu)).toEqual(["HTTP/1.1 413", "HTTP/1.1 201"]);
  });

  test("a body that matches its `Content-Length` is stored", async () => {
    const { port, held, answered } = await listen();

    await sendRaw(
      port,
      "PUT /a HTTP/1.1\r\nHost: localhost\r\nContent-Length: 5\r\nConnection: close\r\n\r\n01234",
      () => {},
    );

    expect((await answered).status).toBe(201);
    expect(textOf(held.get("a"))).toBe("01234");
  });
});
