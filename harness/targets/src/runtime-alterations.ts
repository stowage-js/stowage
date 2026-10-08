import type { ServerAlteration } from "./server-alterations.ts";

const contentRangePattern = /^bytes (\d+)-(\d+)\//u;

/** `workerd`, which sends every body that is a `ReadableStream` chunked. */
export const noLengthOnStream: ServerAlteration = {
  cases: ["serve/whole", "serve/head", "serve/range"],
  differs:
    "an answer whose body is a stream, a `200` and a `206` among them, goes chunked and without `Content-Length`",
  restore: async (method, answer) => {
    if (method !== "GET" || answer.headers.has("content-length")) return undefined;
    if (answer.status === 200) return await withLengthOfBody(answer);
    if (answer.status !== 206) return undefined;

    const [, start, last] =
      contentRangePattern.exec(answer.headers.get("content-range") ?? "") ?? [];

    if (start === undefined || last === undefined) return undefined;

    // Spec 10.3: the layer sends the length of the range its `Content-Range` names.
    const headers = new Headers(answer.headers);

    headers.set("content-length", String(Number(last) - Number(start) + 1));

    return headers;
  },
};

/**
 * Spec 10.3: the layer sends `size` as the length of a `200` and hands over `size` bytes,
 * so the body the client received counts what the layer declared.
 */
async function withLengthOfBody(answer: Response): Promise<Headers> {
  const headers = new Headers(answer.headers);
  const body = await answer.clone().arrayBuffer();

  headers.set("content-length", String(body.byteLength));

  return headers;
}
