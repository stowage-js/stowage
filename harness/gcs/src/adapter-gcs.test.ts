import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "vitest";

import type { GcsSigningStorage } from "../../../packages/adapter-gcs/src/index.ts";
import { bucketOrFail, bucketStorage, scheduledBucket } from "./environment.ts";

// Spec 14.4: promises of `adapter-gcs` that the suite does not assert and only the real
// bucket shows. fake-gcs-server honors no response override, carries no CORS rule and checks
// no signature (ADR 0034), so these run in the scheduled job against the bucket alone.
const scheduled = scheduledBucket();

/** The one origin the bucket's CORS rule allows (ADR 0034). */
const allowedOrigin = "https://conformance.stowage.invalid";

/** Past the second the expired URL signs for, as `presign/expired-url` waits it out. */
const pastTheLifetime = 2000;

const prefix = `stowage-harness/${randomUUID()}/`;

/** Characters a key may hold that a signed URL carries encoded, segment by segment (spec 9.4). */
const encodedPrefix = `${prefix}a b#c?d%e+f'(g)*!/`;

const utf8 = new TextEncoder();

describe.skipIf(scheduled === undefined)("adapter-gcs against the bucket", () => {
  // The bucket's lifecycle rule removes what a run leaves after a day (ADR 0034), and a run
  // leaves nothing where it can help it.
  afterAll(async () => {
    const report = await storage().deleteAll(prefix);

    if (report.failed.length > 0) {
      throw new AggregateError(report.failed, "Failed to clean up GCS test objects");
    }
  });

  test("a presigned `GET` answers with the two response overrides", async () => {
    const key = `${prefix}overrides.txt`;
    const overrides = {
      "content-type": "application/x-stowage-override",
      "content-disposition": `attachment; filename="override.txt"; filename*=UTF-8''gr%C3%BC%C3%9Fe.txt`,
    };

    await storage().put(key, "the body the overrides describe", { contentType: "text/plain" });

    const response = await fetch(
      await storage().presignGet(key, {
        expiresIn: 300,
        responseContentType: overrides["content-type"],
        responseContentDisposition: overrides["content-disposition"],
      }),
    );

    await response.arrayBuffer();

    // Each override beside the header it came back as, so that one ignored override reads
    // as a failure of its own rather than as a status that looked fine.
    expect({
      status: response.status,
      ...Object.fromEntries(
        Object.keys(overrides).map((name) => [name, response.headers.get(name)]),
      ),
    }).toEqual({ status: 200, ...overrides });
  });

  // ADR 0035: a page that uploads through an expired URL reads the refusal's status only
  // where the `400` carries the CORS headers of the rule.
  test("the `400` for an expired presigned `PUT` carries the CORS headers of the rule", async () => {
    const key = `${prefix}expired-put.txt`;
    const body = utf8.encode("an upload after the URL expired");
    const { url, headers } = await storage().presignPut(key, {
      expiresIn: 1,
      contentType: "text/plain",
      contentLength: body.byteLength,
    });
    const preflight = await fetch(url, {
      method: "OPTIONS",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": "PUT",
        "access-control-request-headers": Object.keys(headers).join(","),
      },
    });

    await preflight.arrayBuffer();
    expect({
      status: preflight.status,
      origin: preflight.headers.get("access-control-allow-origin"),
    }).toEqual({ status: 200, origin: allowedOrigin });

    await new Promise<void>((resolve) => void setTimeout(resolve, pastTheLifetime));

    const upload = await fetch(url, {
      method: "PUT",
      headers: { ...headers, origin: allowedOrigin },
      body,
    });
    const answer = await upload.text();

    expect({
      status: upload.status,
      code: /<Code>(?<code>[^<]*)<\/Code>/u.exec(answer)?.groups?.["code"],
      origin: upload.headers.get("access-control-allow-origin"),
    }).toEqual({ status: 400, code: "ExpiredToken", origin: allowedOrigin });
  });

  // The suite's presign cases sign keys that need no encoding; spec 9.4 encodes a key segment
  // by segment in a signed URL, and the canonical request `signBlob` signs covers each one.
  test("URLs signed through `signBlob` for a key that travels encoded are served", async () => {
    const key = `${encodedPrefix}grüße/日本.txt`;
    const body = utf8.encode("written and read through URLs `signBlob` signed");
    const { url, headers } = await storage().presignPut(key, {
      expiresIn: 300,
      contentType: "text/plain",
      contentLength: body.byteLength,
    });
    const upload = await fetch(url, { method: "PUT", headers, body });

    await upload.arrayBuffer();

    const download = await fetch(await storage().presignGet(key, { expiresIn: 300 }));

    expect({
      upload: upload.status,
      download: download.status,
      body: await download.text(),
    }).toEqual({
      upload: 200,
      download: 200,
      body: "written and read through URLs `signBlob` signed",
    });
    expect(await storage().stat(key)).toMatchObject({ key, contentType: "text/plain" });
  });
});

function storage(): GcsSigningStorage {
  return bucketStorage(bucketOrFail(scheduled));
}
