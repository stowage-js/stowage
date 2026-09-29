import type { ObjectStat } from "@stowage/core";

import type { GcsConfiguration } from "./configuration.ts";
import { describeResource, readResource } from "./description.ts";
import { send, uploadPath } from "./request.ts";

export interface ObjectWrite {
  readonly key: string;
  readonly contentType: string;
  readonly signal?: AbortSignal;
}

const utf8 = new TextEncoder();

/**
 * Spec 9.6: held bytes go as one `uploadType=multipart` request, whose first part is the
 * object's resource and whose second is the bytes. `put` resolves with the object the
 * answer describes, so no `stat` follows.
 */
export async function putBytes(
  configuration: GcsConfiguration,
  write: ObjectWrite,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<ObjectStat> {
  const boundary = `stowage-${crypto.randomUUID()}`;
  const response = await send(configuration, {
    method: "POST",
    operation: "put",
    key: write.key,
    path: uploadPath(configuration),
    query: [["uploadType", "multipart"]],
    headers: [["content-type", `multipart/related; boundary=${boundary}`]],
    body: multipartBody(boundary, write, bytes),
    signal: write.signal,
  });
  const resource = await readResource(configuration.bucket, write.key, "put", response);

  return describeResource(configuration.bucket, write.key, "put", response, resource);
}

/**
 * The `multipart/related` body of RFC 2387. The boundary is random per request: a body
 * that held it would end its part early, and 122 random bits make that no concern.
 */
function multipartBody(
  boundary: string,
  write: ObjectWrite,
  bytes: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const resource = JSON.stringify({ name: write.key, contentType: write.contentType });
  const head = utf8.encode(
    [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      resource,
      `--${boundary}`,
      `Content-Type: ${write.contentType}`,
      "",
      "",
    ].join("\r\n"),
  );
  const tail = utf8.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.byteLength + bytes.byteLength + tail.byteLength);

  body.set(head, 0);
  body.set(bytes, head.byteLength);
  body.set(tail, head.byteLength + bytes.byteLength);

  return body;
}
