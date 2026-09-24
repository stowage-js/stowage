import { randomUUID } from "node:crypto";
import { connect as connectTcp } from "node:net";
import { text } from "node:stream/consumers";
import { connect as connectTls } from "node:tls";

import { afterAll, describe, expect, test } from "vitest";

import {
  type AnsweredRequest,
  readAnswerDocument,
  textOf,
} from "../../../packages/adapter-s3/src/answer-document.ts";
import { encodePath } from "../../../packages/adapter-s3/src/canonical.ts";
import {
  readConfiguration,
  type S3Configuration,
} from "../../../packages/adapter-s3/src/configuration.ts";
import { resolveCredentials } from "../../../packages/adapter-s3/src/credentials.ts";
import { sha256Hex } from "../../../packages/adapter-s3/src/hash.ts";
import { s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import { isStorageError } from "../../../packages/core/src/index.ts";
import { pathOf, send } from "../../../packages/adapter-s3/src/request.ts";
import { signRequest } from "../../../packages/adapter-s3/src/sign.ts";
import { escapeXml } from "../../../packages/adapter-s3/src/xml.ts";
import { endpointOrFail, scheduledStorage } from "./environment.ts";
import { firstRunSuite, probeNames } from "./first-run.ts";

/* oxlint-disable vitest/valid-title -- the titles are the names the spec 12 report reads,
   kept once in `first-run.ts` for both */

// Spec 12: what no documentation settled, asked of the endpoint by the scheduled run. The
// requests go through the adapter's own signing and failure mapping wherever the adapter
// can send them, so that what is observed is what a caller of `adapter-s3` meets.
const scheduled = scheduledStorage() !== undefined;

const utf8 = new TextEncoder();

const mebibyte = 1024 * 1024;
const gibibyte = 1024 * mebibyte;

/** The source `CopyObject` takes in one request on AWS, and a mebibyte past it. */
const aboveTheCopyLimit = 5 * gibibyte + mebibyte;

/** Parts the size of which keeps the upload of `aboveTheCopyLimit` at 81 requests. */
const largePartSize = 64 * mebibyte;

const largeObjectTimeout = 40 * 60_000;

describe.skipIf(!scheduled)(firstRunSuite, () => {
  const prefix = `first-run-${randomUUID()}/`;
  const startedUploads: { key: string; uploadId: string }[] = [];

  afterAll(async () => {
    await Promise.all(
      startedUploads.map(async ({ key, uploadId }) => await abortUpload(key, uploadId)),
    );
    await s3Storage(endpointOrFail()).deleteAll(prefix);
  });

  async function startUpload(key: string): Promise<string> {
    const response = await send(endpointConfiguration(), {
      method: "POST",
      operation: "put",
      key,
      query: [["uploads", ""]],
    });
    const document = await readAnswerDocument(
      answered(key, "the start of the upload"),
      response,
      "InitiateMultipartUploadResult",
    );
    const uploadId = textOf(document, "UploadId") ?? "";

    startedUploads.push({ key, uploadId });

    return uploadId;
  }

  async function sendPart(key: string, uploadId: string, number: number): Promise<string> {
    const response = await send(endpointConfiguration(), {
      method: "PUT",
      operation: "put",
      key,
      query: [
        ["partNumber", String(number)],
        ["uploadId", uploadId],
      ],
      body: new Uint8Array(1),
    });

    await response.body?.cancel();

    return response.headers.get("etag") ?? "";
  }

  async function completeUpload(
    key: string,
    uploadId: string,
    parts: readonly { number: number; etag: string }[],
  ): Promise<void> {
    const listed = parts
      .map(
        ({ number, etag }) =>
          `<Part><PartNumber>${number}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`,
      )
      .join("");
    const response = await send(endpointConfiguration(), {
      method: "POST",
      operation: "put",
      key,
      query: [["uploadId", uploadId]],
      headers: [["content-type", "application/xml"]],
      body: utf8.encode(
        `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${listed}</CompleteMultipartUpload>`,
      ),
    });

    // A completion may carry its failure inside a `200` (spec 7.2), which is where the
    // adapter reads it too.
    await readAnswerDocument(
      answered(key, "the completion of the upload"),
      response,
      "CompleteMultipartUploadResult",
    );
  }

  async function abortUpload(key: string, uploadId: string): Promise<void> {
    await send(endpointConfiguration(), {
      method: "DELETE",
      operation: "put",
      key,
      query: [["uploadId", uploadId]],
    }).then(
      async (response) => await response.body?.cancel(),
      () => {},
    );
  }

  function answered(key: string, subject: string): AnsweredRequest {
    return { bucket: endpointConfiguration().bucket, operation: "put", key, subject };
  }

  // The adapter never sends a part below 5 MiB but the last, so the provider is asked
  // directly, through the adapter's signing, for the answer spec 7.9 maps.
  test(probeNames.entityTooSmall, async () => {
    const key = `${prefix}entity-too-small.bin`;
    const uploadId = await startUpload(key);
    const parts = [
      { number: 1, etag: await sendPart(key, uploadId, 1) },
      { number: 2, etag: await sendPart(key, uploadId, 2) },
    ];

    await expect(completeUpload(key, uploadId, parts)).rejects.toMatchObject({
      code: "InvalidRequest",
      providerCode: "EntityTooSmall",
    });
  });

  test(probeNames.invalidPart, async () => {
    const key = `${prefix}invalid-part.bin`;
    const uploadId = await startUpload(key);

    await sendPart(key, uploadId, 1);

    await expect(
      completeUpload(key, uploadId, [{ number: 1, etag: `"${"0".repeat(32)}"` }]),
    ).rejects.toMatchObject({ code: "InvalidRequest", providerCode: "InvalidPart" });
  });

  // `fetch` hands no body out for a `HEAD` whatever the provider sent, so the answer is
  // read off the connection itself: whatever follows the head was sent as a body.
  test(probeNames.headWithoutBody, async () => {
    const key = `${prefix}head.txt`;

    await s3Storage(endpointOrFail()).put(key, "the body a `HEAD` leaves out");

    const present = await rawHead(endpointConfiguration(), key);
    const absent = await rawHead(endpointConfiguration(), `${prefix}absent.txt`);

    expect({ status: present.status, body: present.body }).toEqual({ status: 200, body: "" });
    expect({ status: absent.status, body: absent.body }).toEqual({ status: 404, body: "" });
  });

  test(probeNames.responseOverrides, async () => {
    const storage = s3Storage(endpointOrFail());
    const key = `${prefix}overrides.txt`;
    const overrides = {
      "content-type": "application/x-stowage-override",
      "content-disposition": 'attachment; filename="override.txt"',
      "cache-control": "no-store",
      expires: "Wed, 21 Oct 2037 07:28:00 GMT",
    };

    await storage.put(key, "the body the overrides describe", { contentType: "text/plain" });

    const response = await fetch(
      await storage.presignGet(key, {
        expiresIn: 300,
        responseContentType: overrides["content-type"],
        responseContentDisposition: overrides["content-disposition"],
        responseCacheControl: overrides["cache-control"],
        responseExpires: overrides.expires,
      }),
    );

    await response.arrayBuffer();

    // Each override beside the header it came back as, so that one ignored override
    // reads as a failure of its own rather than as a status that looked fine.
    expect({
      status: response.status,
      ...Object.fromEntries(
        Object.keys(overrides).map((name) => [name, response.headers.get(name)]),
      ),
    }).toEqual({ status: 200, ...overrides });
  });

  // Spec 7.8: v0.1 does not fall back to `UploadPartCopy`, so above the provider's limit
  // `copy` rejects with the provider's error. A provider that copies it anyway breaks no
  // promise, and the run says which of the two it met.
  test(
    probeNames.copyAboveLimit,
    async ({ task }) => {
      const storage = s3Storage({ ...endpointOrFail(), multipart: { partSize: largePartSize } });
      const source = `${prefix}above-the-copy-limit.bin`;

      await storage.put(source, zeroes(aboveTheCopyLimit));

      try {
        const copied = await storage.copy(source, `${prefix}copied.bin`);

        expect(copied.size).toBe(aboveTheCopyLimit);
        task.meta.observed = `copied ${aboveTheCopyLimit} bytes in one request`;
      } catch (thrown) {
        if (!isStorageError(thrown) || thrown.status === undefined) throw thrown;

        task.meta.observed =
          `refused as \`${thrown.code}\`, ${thrown.status} \`${thrown.providerCode}\`: ` +
          thrown.message;
      }
    },
    largeObjectTimeout,
  );
});

const endpointConfiguration = (): S3Configuration => readConfiguration(endpointOrFail());

function zeroes(size: number): ReadableStream<Uint8Array> {
  let pulled = 0;

  return new ReadableStream({
    pull(controller) {
      if (pulled >= size) return controller.close();

      const chunk = Math.min(mebibyte, size - pulled);

      controller.enqueue(new Uint8Array(chunk));
      pulled += chunk;
    },
  });
}

interface RawAnswer {
  readonly status: number;
  /** Everything that arrived after the blank line ending the head. */
  readonly body: string;
}

/** A `HEAD` signed as the adapter signs it, over a connection that closes after one answer. */
async function rawHead(configuration: S3Configuration, key: string): Promise<RawAnswer> {
  const path = pathOf(configuration, key);
  const payloadHash = await sha256Hex(new Uint8Array(0));
  const signed = await signRequest({
    method: "HEAD",
    host: configuration.host,
    path,
    query: [],
    headers: [["x-amz-content-sha256", payloadHash]],
    payloadHash,
    credentials: await resolveCredentials(configuration.credentials, { forceRefresh: false }),
    region: configuration.region,
    service: "s3",
    date: new Date(),
  });
  const address = new URL(`${configuration.protocol}//${configuration.host}`);
  const secure = address.protocol === "https:";
  const port = Number(address.port === "" ? (secure ? 443 : 80) : address.port);
  const socket = secure
    ? connectTls({ host: address.hostname, port, servername: address.hostname })
    : connectTcp({ host: address.hostname, port });
  const request = [
    `HEAD ${encodePath(path)} HTTP/1.1`,
    `host: ${configuration.host}`,
    ...signed.headers.map(([name, value]) => `${name}: ${value}`),
    "connection: close",
    "",
    "",
  ].join("\r\n");

  // Written and not ended: a provider may take a half-closed connection for an abandoned
  // request, and `connection: close` is what ends the exchange after the answer.
  socket.write(request);

  const answer = await text(socket);
  const headEnd = answer.indexOf("\r\n\r\n");
  const [statusLine = ""] = answer.split("\r\n");

  return {
    status: Number(statusLine.split(" ")[1]),
    body: headEnd === -1 ? answer : answer.slice(headEnd + 4),
  };
}
