import type { HeaderField } from "./sign.ts";

/** What one Blob Batch carries at most, and so what spec 8.1 sends one request per. */
export const subrequestsPerBatch = 256;

/** A request carried inside a Blob Batch, which sends no body of its own. */
export interface Subrequest {
  readonly method: string;
  /** Encoded, as its request line carries it. */
  readonly path: string;
  /** What it carries, `authorization` among it. */
  readonly headers: readonly HeaderField[];
}

/** One HTTP response inside the answer, under the `Content-ID` of the subrequest it answers. */
export interface Subresponse {
  readonly contentId: string;
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

const utf8 = new TextEncoder();

const statusLine = /^HTTP\/1\.[01] (?<status>\d{3})/u;
const boundaryParameter = /;\s*boundary=(?:"(?<quoted>[^"]+)"|(?<bare>[^;\s]+))/iu;
const blankLine = /\r?\n\r?\n/u;
const lineBreak = /\r?\n/u;

export function batchBoundary(): string {
  return `batch_${crypto.randomUUID()}`;
}

export function batchContentType(boundary: string): string {
  return `multipart/mixed; boundary=${boundary}`;
}

/**
 * The `multipart/mixed` body of a Blob Batch: each part a whole HTTP request with lines
 * ending in CRLF, numbered by its place in the batch as its `Content-ID`.
 */
export function batchBody(
  boundary: string,
  subrequests: readonly Subrequest[],
): Uint8Array<ArrayBuffer> {
  const parts = subrequests.map(
    (subrequest, index) =>
      `--${boundary}\r\n` +
      "Content-Type: application/http\r\n" +
      "Content-Transfer-Encoding: binary\r\n" +
      `Content-ID: ${index}\r\n\r\n` +
      `${subrequest.method} ${subrequest.path} HTTP/1.1\r\n` +
      subrequest.headers.map(([name, value]) => `${name}: ${value}\r\n`).join("") +
      "Content-Length: 0\r\n\r\n",
  );

  return utf8.encode(`${parts.join("")}--${boundary}--\r\n`);
}

/**
 * The subresponses of an answer, or nothing where the body is no `multipart/mixed` of
 * HTTP responses under the boundary its `Content-Type` names.
 */
export function readSubresponses(
  contentType: string | null,
  body: string,
): readonly Subresponse[] | undefined {
  const groups = boundaryParameter.exec(contentType ?? "")?.groups;
  const boundary = groups?.["quoted"] ?? groups?.["bare"];

  if (boundary === undefined) return undefined;

  const [, ...parts] = body.split(`--${boundary}`);
  const close = parts.pop();

  if (close?.startsWith("--") !== true) return undefined;

  const subresponses: Subresponse[] = [];

  for (const part of parts) {
    const subresponse = readPart(part);

    if (subresponse === undefined) return undefined;

    subresponses.push(subresponse);
  }

  return subresponses;
}

function readPart(part: string): Subresponse | undefined {
  const [mime, message] = splitHead(part.replace(/^\r?\n/u, ""));
  const contentId = headersOf(mime)?.get("content-id");

  if (contentId === null || contentId === undefined || message === undefined) return undefined;

  const [head, body = ""] = splitHead(message);
  const [line = "", ...fields] = head.split(lineBreak);
  const status = statusLine.exec(line)?.groups?.["status"];
  const headers = headersOf(fields.join("\n"));

  if (status === undefined || headers === undefined) return undefined;

  return { contentId, status: Number(status), headers, body: body.replace(/\r?\n$/u, "") };
}

function splitHead(text: string): [head: string, rest: string | undefined] {
  const match = blankLine.exec(text);

  if (match === null) return [text, undefined];

  return [text.slice(0, match.index), text.slice(match.index + match[0].length)];
}

function headersOf(head: string): Headers | undefined {
  const headers = new Headers();

  for (const line of head.split(lineBreak)) {
    if (line === "") continue;

    const colon = line.indexOf(":");

    if (colon <= 0) return undefined;

    try {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    } catch {
      return undefined;
    }
  }

  return headers;
}
