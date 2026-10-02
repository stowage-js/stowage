import type { ServerAlteration } from "./server-alterations.ts";

function withoutLength(answer: Response): Headers {
  const headers = new Headers(answer.headers);

  headers.delete("content-length");

  return headers;
}

/** `Bun.serve` and `Deno.serve`. */
export const lengthZeroOnHead: ServerAlteration = {
  case: "serve/head",
  differs:
    "a `HEAD` the layer answered without a body and without `Content-Length` carries `Content-Length: 0`",
  restore: (method, answer) =>
    method === "HEAD" && answer.headers.get("content-length") === "0"
      ? withoutLength(answer)
      : undefined,
};

/** `Bun.serve`, which measures a body it holds whole before the headers are written. */
export const lengthOfCompleteBody: ServerAlteration = {
  case: "serve/whole",
  differs:
    "a `200` whose body is complete before the headers are written, as the 16 bytes of the case are, carries `Content-Length`",
  restore: (method, answer) =>
    method === "GET" && answer.status === 200 && answer.headers.has("content-length")
      ? withoutLength(answer)
      : undefined,
};

const contentRangePattern = /^bytes (\d+)-(\d+)\//u;

/** `workerd`, which sends every body that is a `ReadableStream` chunked. */
export const noLengthOnStream: ServerAlteration = {
  case: "serve/range",
  differs:
    "an answer whose body is a stream, a `206` among them, goes chunked and without `Content-Length`",
  restore: (_method, answer) => {
    const [, start, last] =
      contentRangePattern.exec(answer.headers.get("content-range") ?? "") ?? [];

    if (answer.status !== 206 || answer.headers.has("content-length")) return undefined;
    if (start === undefined || last === undefined) return undefined;

    // Spec 10.3: the layer sends the length of the range its `Content-Range` names.
    const headers = new Headers(answer.headers);

    headers.set("content-length", String(Number(last) - Number(start) + 1));

    return headers;
  },
};
