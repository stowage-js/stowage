import { expect, test } from "vitest";

import { hmacSha256Base64, signSharedKey, stringToSign } from "./sign.ts";

/** Azurite's well-known account, whose key Microsoft publishes for the emulator. */
const emulatorAccount = "devstoreaccount1";
const emulatorKey =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

const date = new Date("2026-08-30T12:36:00Z");

// RFC 4231, test case 2: the key "Jefe", here as the base64 an account key is written in.
test("the signature is HMAC-SHA256 under the decoded key, written as base64", async () => {
  expect(await hmacSha256Base64("SmVmZQ==", "what do ya want for nothing?")).toBe(
    "W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=",
  );
});

test("a `Put Blob` signs its length, its type, the `x-ms-` headers and the resource", async () => {
  const signed = await signSharedKey(
    {
      method: "PUT",
      account: emulatorAccount,
      path: "/devstoreaccount1/conformance/a%20b%23c",
      query: [],
      headers: [
        ["content-type", "text/plain"],
        ["x-ms-version", "2026-04-06"],
        ["x-ms-blob-type", "BlockBlob"],
      ],
      contentLength: 11,
      date,
    },
    emulatorKey,
  );

  expect(signed.stringToSign).toBe(
    [
      "PUT",
      "",
      "",
      "11",
      "",
      "text/plain",
      "",
      "",
      "",
      "",
      "",
      "",
      "x-ms-blob-type:BlockBlob",
      "x-ms-date:Sun, 30 Aug 2026 12:36:00 GMT",
      "x-ms-version:2026-04-06",
      // Path-style addressing names the account twice, once for the signer and once in
      // the path, which is what the emulator expects.
      "/devstoreaccount1/devstoreaccount1/conformance/a%20b%23c",
    ].join("\n"),
  );
  // Computed apart from this signer: `openssl dgst -sha256 -mac HMAC` over the same string.
  expect(signed.headers).toContainEqual([
    "authorization",
    "SharedKey devstoreaccount1:Pndxzik4sFtIfCmOShKiBI70PtJoRfeAKvhszVWCT3U=",
  ]);
  expect(signed.headers).toContainEqual(["x-ms-date", "Sun, 30 Aug 2026 12:36:00 GMT"]);
});

test("a body of zero bytes signs an empty length", () => {
  const signed = stringToSign({
    method: "GET",
    account: "stowage",
    path: "/conformance/object",
    query: [],
    headers: [["x-ms-date", "Sun, 30 Aug 2026 12:36:00 GMT"]],
    contentLength: 0,
  });

  expect(signed.split("\n")[3]).toBe("");
});

test("the standard headers take their lines whatever case they were named in", () => {
  const signed = stringToSign({
    method: "GET",
    account: "stowage",
    path: "/conformance/object",
    query: [],
    headers: [
      ["Range", "bytes=0-15"],
      ["If-Match", '"0x8D"'],
      ["Content-Language", "de"],
    ],
    contentLength: 0,
  });

  expect(signed.split("\n").slice(0, 12)).toEqual([
    "GET",
    "",
    "de",
    "",
    "",
    "",
    "",
    "",
    '"0x8D"',
    "",
    "",
    "bytes=0-15",
  ]);
});

test("canonical headers are ordered by code point with `_` before the digits", () => {
  const signed = stringToSign({
    method: "PUT",
    account: "stowage",
    path: "/conformance/object",
    query: [],
    headers: [
      ["x-ms-meta-ab", "4"],
      ["x-ms-meta-a1", "3"],
      ["X-MS-Meta-A0b", "2"],
      ["x-ms-meta-a_", "1"],
      ["x-ms-meta-a", "0"],
      ["x-ms-version", "2026-04-06"],
    ],
    contentLength: 1,
  });

  expect(signed.split("\n").slice(12, 18)).toEqual([
    "x-ms-meta-a:0",
    "x-ms-meta-a_:1",
    "x-ms-meta-a0b:2",
    "x-ms-meta-a1:3",
    "x-ms-meta-ab:4",
    "x-ms-version:2026-04-06",
  ]);
});

test("a canonical header value is trimmed and its runs of whitespace folded", () => {
  const signed = stringToSign({
    method: "PUT",
    account: "stowage",
    path: "/conformance/object",
    query: [],
    headers: [["x-ms-meta-note", "  one   two\tthree "]],
    contentLength: 1,
  });

  expect(signed.split("\n")[12]).toBe("x-ms-meta-note:one two three");
});

test("headers outside `x-ms-` and the standard twelve are not signed", () => {
  const signed = stringToSign({
    method: "GET",
    account: "stowage",
    path: "/conformance/object",
    query: [],
    headers: [
      ["accept-encoding", "identity"],
      ["x-ms-version", "2026-04-06"],
    ],
    contentLength: 0,
  });

  expect(signed).not.toContain("identity");
});

test("the query joins the resource by lower-cased name, decoded, in code point order", () => {
  const signed = stringToSign({
    method: "GET",
    account: "stowage",
    path: "/conformance",
    query: [
      ["restype", "container"],
      ["prefix", "a b/ü"],
      ["comp", "list"],
      ["Include", "metadata"],
      ["include", "copy"],
    ],
    headers: [],
    contentLength: 0,
  });

  expect(signed.split("\n").slice(12)).toEqual([
    "/stowage/conformance",
    "comp:list",
    "include:copy,metadata",
    "prefix:a b/ü",
    "restype:container",
  ]);
});
