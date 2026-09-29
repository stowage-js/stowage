/** A whole HTTP request carried inside a batch, which sends no body of its own. */
export interface BatchSubrequest {
  readonly method: string;
  /** Encoded, as its request line carries it. */
  readonly path: string;
  readonly headers: readonly (readonly [name: string, value: string])[];
}

const utf8 = new TextEncoder();

/** A fresh boundary for one batch body. */
export function batchBoundary(): string {
  return `batch_${crypto.randomUUID()}`;
}

/** The `Content-Type` of a batch request: `multipart/mixed` under the boundary. */
export function batchContentType(boundary: string): string {
  return `multipart/mixed; boundary=${boundary}`;
}

/**
 * Each subrequest as an `application/http` part, its place in the batch as its `Content-ID`,
 * with lines ending in CRLF.
 *
 * RFC 2046 counts the CRLF in front of a delimiter as the delimiter's, so a part ends in
 * one more than its head needs. Without it the head loses its blank line, which a strict
 * reader such as fake-gcs-server's refuses as an incomplete request.
 */
export function batchBody(
  boundary: string,
  subrequests: readonly BatchSubrequest[],
): Uint8Array<ArrayBuffer> {
  const parts = subrequests.map(
    (subrequest, index) =>
      `--${boundary}\r\n` +
      "Content-Type: application/http\r\n" +
      "Content-Transfer-Encoding: binary\r\n" +
      `Content-ID: ${index}\r\n\r\n` +
      `${subrequest.method} ${subrequest.path} HTTP/1.1\r\n` +
      subrequest.headers.map(([name, value]) => `${name}: ${value}\r\n`).join("") +
      "Content-Length: 0\r\n\r\n\r\n",
  );

  return utf8.encode(`${parts.join("")}--${boundary}--\r\n`);
}

/** One HTTP response inside the answer, under the `Content-ID` the answer gives it. */
export interface BatchSubresponse {
  readonly contentId: string;
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

/**
 * Either one subresponse per subrequest, in the order of the subrequests, or why the answer
 * cannot be read: `unreadable` names what the answer is instead, and `unanswered` is the place
 * of the first subrequest nothing answers.
 */
export type SubresponseReading =
  | { readonly subresponses: readonly BatchSubresponse[] }
  | { readonly unreadable: string }
  | { readonly unanswered: number };

const statusLine = /^HTTP\/1\.[01] (?<status>\d{3})/u;
const boundaryParameter = /;\s*boundary=(?:"(?<quoted>[^"]+)"|(?<bare>[^;\s]+))/iu;
const blankLine = /\r?\n\r?\n/u;
const lineBreak = /\r?\n/u;

/**
 * The answer's subresponses to the `subrequestCount` subrequests `batchBody` sent, each paired
 * by the `Content-ID` `echoedContentId` names: the one the provider answers it under.
 */
export function readSubresponses(
  contentType: string | null,
  body: string,
  subrequestCount: number,
  echoedContentId: (sent: string) => string,
): SubresponseReading {
  const subresponses = subresponsesOf(contentType, body);

  if (subresponses === undefined) return { unreadable: "an answer that is no batch of responses" };

  const places = new Map(
    Array.from({ length: subrequestCount }, (_, place) => [echoedContentId(String(place)), place]),
  );
  const paired: BatchSubresponse[] = [];

  for (const subresponse of subresponses) {
    const { contentId } = subresponse;
    const place = places.get(contentId);

    if (place === undefined) {
      return { unreadable: `an answer for unexpected Content-ID ${JSON.stringify(contentId)}` };
    }

    if (paired[place] !== undefined) {
      return { unreadable: `two answers for Content-ID ${JSON.stringify(contentId)}` };
    }

    paired[place] = subresponse;
  }

  for (let place = 0; place < subrequestCount; place += 1) {
    if (paired[place] === undefined) return { unanswered: place };
  }

  return { subresponses: paired };
}

/** The responses a `multipart/mixed` body holds, as they arrive, or nothing where it is none. */
function subresponsesOf(contentType: string | null, body: string): BatchSubresponse[] | undefined {
  const groups = boundaryParameter.exec(contentType ?? "")?.groups;
  const boundary = groups?.["quoted"] ?? groups?.["bare"];

  if (boundary === undefined) return undefined;

  const [, ...parts] = body.split(`--${boundary}`);
  const close = parts.pop();

  if (close?.startsWith("--") !== true) return undefined;

  const subresponses: BatchSubresponse[] = [];

  for (const part of parts) {
    const subresponse = subresponseOf(part);

    if (subresponse === undefined) return undefined;

    subresponses.push(subresponse);
  }

  return subresponses;
}

function subresponseOf(part: string): BatchSubresponse | undefined {
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
