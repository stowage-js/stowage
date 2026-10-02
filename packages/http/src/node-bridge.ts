// ADR 0046: the bridge is typed against these interfaces rather than `node:http`, so the
// package imports no `node:` module, needs no `@types/node` and loads on `workerd`.

export interface NodeRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: object;
  readonly readableDidRead: boolean;
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  pause(): unknown;
  resume(): unknown;
}

export interface NodeResponse {
  statusCode: number;
  readonly writableEnded: boolean;
  readonly writableFinished: boolean;
  setHeader(name: string, value: string | readonly string[]): unknown;
  write(chunk: Uint8Array): boolean;
  end(): unknown;
  destroy(error?: Error): unknown;
  on(event: "drain" | "close", listener: () => void): unknown;
}

/**
 * What `toWebRequest` learned about the exchange a response belongs to, which no member of
 * `NodeResponse` carries: the method, so that `writeResponse` sends no body to a `HEAD`,
 * and whether the client left before the answer was written.
 */
interface Exchange {
  readonly method: string;
  disconnected: boolean;
}

const exchanges = new WeakMap<NodeResponse, Exchange>();

/**
 * The web `Request` for a Node request. Its body streams `req` with backpressure for any
 * method but `GET` and `HEAD`. Its signal aborts once `res` closes before it has finished,
 * which is a client disconnecting; the request's own `close` is no such signal, since Node
 * emits it as soon as the body is read. A `req` whose body was already read is a
 * `TypeError` (ADR 0051).
 */
export function toWebRequest(req: NodeRequest, res: NodeResponse): Request {
  // A body parser in front, `express.json()` or NestJS's default among them, would leave
  // the layer an empty body to store.
  if (req.readableDidRead) {
    throw new TypeError("The body of `req` was read before `toWebRequest`, by a body parser or so");
  }

  const method = req.method ?? "GET";
  const exchange: Exchange = { method, disconnected: false };
  const controller = new AbortController();
  const body = method === "GET" || method === "HEAD" ? undefined : streamedBody(req);

  exchanges.set(res, exchange);
  res.on("close", () => {
    if (res.writableFinished) return;

    exchange.disconnected = true;
    // Node closes the response of a reset connection before `req` emits its error, and
    // the abort would reach `put` before the failed body, which `acceptUpload` answers
    // with `400` where it throws an abort on.
    body?.fail(new Error("The connection closed before the request body ended"));
    controller.abort();
  });

  // Node and Deno take a stream as a body only with `duplex`, which the lib does not
  // declare, so the init is no literal that the compiler would check for it.
  const init = {
    method,
    headers: headersOf(req.headers),
    signal: controller.signal,
    body: body?.stream ?? null,
    duplex: "half",
  };

  return new Request(urlOf(req), init);
}

interface StreamedBody {
  readonly stream: ReadableStream<Uint8Array>;
  /** Errors the stream, unless it ended, failed or was canceled already. */
  fail(reason: Error): void;
}

/** The body of `req`, which is paused while a chunk waits unread and resumed as it is read. */
function streamedBody(req: NodeRequest): StreamedBody {
  let settled = false;
  let opened: ReadableStreamDefaultController<Uint8Array> | undefined;

  const fail = (reason: Error): void => {
    if (settled) return;

    settled = true;
    opened?.error(reason);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      opened = controller;

      req.on("data", (chunk) => {
        if (settled) return;

        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 0) <= 0) req.pause();
      });
      req.on("end", () => {
        if (settled) return;

        settled = true;
        controller.close();
      });
      req.on("error", fail);
    },
    pull() {
      req.resume();
    },
    cancel() {
      settled = true;
      // Node reads the next request on the connection only once this one's body is read,
      // so the rest is let flow and dropped.
      req.resume();
    },
  });

  return { stream, fail };
}

// No function of the layer reads the URL, so it carries nothing the layer depends on, and a
// `Host` the client chose cannot change what is answered.
function urlOf(req: NodeRequest): string {
  const scheme = isEncrypted(req.socket) ? "https" : "http";
  const host = req.headers["host"];
  const authority = (typeof host === "string" ? host : host?.[0]) ?? "localhost";

  return `${scheme}://${authority}${req.url ?? "/"}`;
}

/** A `TLSSocket` says so through `encrypted`, which a plain socket does not carry. */
function isEncrypted(socket: object): boolean {
  return "encrypted" in socket && socket.encrypted === true;
}

function headersOf(fields: NodeRequest["headers"]): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(fields)) {
    // HTTP/2 hands over its pseudo-headers beside the others, and no `Headers` takes them.
    if (value === undefined || name.startsWith(":")) continue;

    for (const each of typeof value === "string" ? [value] : value) headers.append(name, each);
  }

  return headers;
}

/**
 * Writes the status, the headers and the body of `response` to `res`, chunk by chunk and
 * waiting for `drain`. A client disconnecting cancels the body and resolves; a body that
 * errors destroys `res`, so the client sees an incomplete answer rather than a complete
 * short one, and rejects with that error.
 */
export async function writeResponse(res: NodeResponse, response: Response): Promise<void> {
  res.statusCode = response.status;

  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") res.setHeader(name, value);
  }

  // `Headers` joins every other field into one value, and `Set-Cookie` cannot be joined.
  const cookies = response.headers.getSetCookie();

  if (cookies.length > 0) res.setHeader("set-cookie", cookies);

  const body = response.body;
  const exchange = exchanges.get(res);

  if (exchange?.disconnected === true) {
    await body?.cancel();
    return;
  }

  // A `304` carries no body already: the Fetch standard gives that status a null body.
  if (body === null || exchange?.method === "HEAD") {
    res.end();
    await body?.cancel();
    return;
  }

  await pipe(body, res);
}

/** How far `pipe` got, which the listeners on `res` read and write as the body streams. */
interface Piping {
  /** Set once the client disconnected and the body was canceled for it. */
  canceled?: Promise<void>;
  /** Set once the body ended or failed, after which a `close` is no disconnect. */
  settled: boolean;
  wake?: () => void;
}

async function pipe(body: ReadableStream<Uint8Array>, res: NodeResponse): Promise<void> {
  const reader = body.getReader();
  const piping: Piping = { settled: false };

  res.on("drain", () => piping.wake?.());
  res.on("close", () => {
    if (res.writableFinished || piping.settled) return;

    // The pending read resolves as done once the reader is canceled, and the cancel
    // reaches the provider's request behind the stream of `get`.
    piping.canceled = reader.cancel();
    piping.wake?.();
  });

  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one chunk after the other is the point
      const chunk = await reader.read();

      if (piping.canceled !== undefined) break;

      if (chunk.done) {
        piping.settled = true;
        res.end();
        return;
      }

      if (!res.write(chunk.value)) {
        // oxlint-disable-next-line no-await-in-loop -- the next chunk waits for the client
        await new Promise<void>((resolve) => void (piping.wake = resolve));
        piping.wake = undefined;
      }
    }
  } catch (failure) {
    piping.settled = true;
    res.destroy(failure instanceof Error ? failure : undefined);
    throw failure;
  }

  await piping.canceled;
}
