import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import type { S3AdapterOptions } from "../../../packages/adapter-s3/src/index.ts";
import {
  acceptUpload,
  presignUpload,
  redirectToObject,
  serveObject,
} from "../../../packages/http/src/index.ts";
import { nodeBridge, type ServedTarget, servedTarget } from "./http.ts";

vi.mock("../../../packages/http/src/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/http/src/index.ts")>()),
  serveObject: vi.fn<typeof serveObject>(async () => new Response("served")),
  redirectToObject: vi.fn<typeof redirectToObject>(async () => new Response("redirected")),
  acceptUpload: vi.fn<typeof acceptUpload>(async (_storage, _key, request) => {
    // The route hands the body to the layer, which a test reads back through the answer.
    return new Response(request.body === null ? "no body" : await request.text());
  }),
  presignUpload: vi.fn<typeof presignUpload>(async () => new Response("presigned")),
}));

// The layer is mocked, so no request reaches the endpoint these name.
const storageOptions: S3AdapterOptions = {
  bucket: "stowage",
  region: "eu-central-1",
  credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
};

let served: ServedTarget;

beforeAll(async () => {
  served = await servedTarget(nodeBridge, storageOptions);
});

afterAll(async () => await served.close());
beforeEach(() => vi.clearAllMocks());

test.each(["%", "%2", "%GG", "%C3%28", "%FF", "%ED%A0%80"])(
  "a malformed key %s answers 404 without serving an object",
  async (encodedKey) => {
    const url = new URL(`/serve/${encodedKey}`, served.target.url("serve", ""));
    const response = await fetch(url);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(serveObject).not.toHaveBeenCalled();
  },
);

test.each(["report.txt", "docs/report?100%.txt", "café 😀.txt", "%2F"])(
  "a valid key %s is decoded once and passed to serveObject",
  async (key) => {
    const url = served.target.url("serve", key);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("served");
    expect(serveObject).toHaveBeenCalledExactlyOnceWith(
      expect.any(Object),
      key,
      expect.objectContaining({ method: "GET", url: url.href }),
    );
  },
);

test.each(["GET", "HEAD", "POST", "PUT", "DELETE"])(
  "the redirect route hands `%s` to redirectToObject with `expiresIn: 60`",
  async (method) => {
    const url = served.target.url("redirect", "docs/report?100%.txt");
    const response = await fetch(url, { method, redirect: "manual" });

    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(redirectToObject).toHaveBeenCalledExactlyOnceWith(
      expect.any(Object),
      "docs/report?100%.txt",
      expect.objectContaining({ method, url: url.href }),
      { expiresIn: 60 },
    );
  },
);

test.each(["GET", "HEAD", "POST", "PUT", "DELETE"])(
  "the upload route hands `%s` to acceptUpload with `maxSize: 1048576`",
  async (method) => {
    const url = served.target.url("upload", "docs/report?100%.txt");
    const response = await fetch(url, { method });

    expect(response.status).toBe(200);
    await response.arrayBuffer();
    expect(acceptUpload).toHaveBeenCalledExactlyOnceWith(
      expect.any(Object),
      "docs/report?100%.txt",
      expect.objectContaining({ method, url: url.href }),
      { maxSize: 1048576 },
    );
  },
);

test("the upload route of a server started with a `maxSize` hands that one to acceptUpload", async () => {
  const started = await nodeBridge.start(storageOptions, { maxSize: Infinity });

  try {
    const response = await fetch(started.url("upload", "report.txt"), { method: "PUT" });

    await response.arrayBuffer();
    expect(acceptUpload).toHaveBeenCalledExactlyOnceWith(
      expect.any(Object),
      "report.txt",
      expect.any(Request),
      { maxSize: Infinity },
    );
  } finally {
    await started.close();
  }
});

test("the upload route hands the body of a `PUT` to acceptUpload as it was sent", async () => {
  const response = await fetch(served.target.url("upload", "report.txt"), {
    method: "PUT",
    body: "the bytes",
  });

  expect(await response.text()).toBe("the bytes");
});

test.each([
  ["the values a case sends", { contentType: "text/plain", contentLength: 11 }],
  ["values no type would let through", { contentType: "a\nb", contentLength: "11" }],
])("the presign route hands %s to presignUpload unchanged", async (_, values) => {
  const response = await fetch(served.target.url("presign", "docs/report?100%.txt"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(values),
  });

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("presigned");
  expect(presignUpload).toHaveBeenCalledExactlyOnceWith(
    expect.any(Object),
    "docs/report?100%.txt",
    { expiresIn: 60, maxSize: 1048576, ...values },
  );
});

test.each(["GET", "HEAD", "PUT", "DELETE"])(
  "the presign route answers `%s` itself with `405` and `Allow: POST`",
  async (method) => {
    const response = await fetch(served.target.url("presign", "report.txt"), { method });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    await response.arrayBuffer();
    expect(presignUpload).not.toHaveBeenCalled();
  },
);

test.each(["{", "null", "[]"])(
  "the presign route answers the body %s, no JSON object, with `400`",
  async (body) => {
    const response = await fetch(served.target.url("presign", "report.txt"), {
      method: "POST",
      body,
    });

    expect(response.status).toBe(400);
    await response.arrayBuffer();
    expect(presignUpload).not.toHaveBeenCalled();
  },
);
