import { expect, test } from "vitest";

import { readConfiguration } from "./configuration.ts";
import { signServiceSas, signUserDelegationSas } from "./sas.ts";

/** Azurite's well-known account, whose key Microsoft publishes for the emulator. */
const emulatorKey =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

const grant = {
  key: "a b/grüße.txt",
  permissions: "r",
  start: new Date("2026-08-30T12:21:00.250Z"),
  expiry: new Date("2026-08-30T13:36:00.750Z"),
};

test("a service SAS signs the grant on the blob by account, container and key as they stand", async () => {
  const configuration = readConfiguration({
    account: "devstoreaccount1",
    container: "conformance",
    endpoint: "https://127.0.0.1:10000/devstoreaccount1",
    credentials: { accountKey: emulatorKey },
  });

  const signed = await signServiceSas(configuration, grant, emulatorKey);

  expect(signed.stringToSign).toBe(
    [
      "r",
      "2026-08-30T12:21:00Z",
      "2026-08-30T13:36:00Z",
      // The endpoint's path names the account again, and the resource does not.
      "/blob/devstoreaccount1/conformance/a b/grüße.txt",
      "",
      "",
      "https,http",
      "2026-04-06",
      "b",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
    ].join("\n"),
  );
  // Computed apart from this signer: `openssl dgst -sha256 -mac HMAC` over the same string.
  expect(signed.query).toEqual([
    ["sv", "2026-04-06"],
    ["spr", "https,http"],
    ["st", "2026-08-30T12:21:00Z"],
    ["se", "2026-08-30T13:36:00Z"],
    ["sr", "b"],
    ["sp", "r"],
    ["sig", "534slhIoKo8yh1ztSb96GLyarr6kFgxbG2Y+l6clPA4="],
  ]);
});

test("away from a loopback address the SAS admits `https` alone", async () => {
  const configuration = readConfiguration({
    account: "stowage",
    container: "conformance",
    credentials: { accountKey: emulatorKey },
  });

  const signed = await signServiceSas(configuration, grant, emulatorKey);

  expect(signed.query).toContainEqual(["spr", "https"]);
});

const overrides = {
  cacheControl: "no-cache",
  contentDisposition: 'attachment; filename="grüße.txt"',
  contentType: "text/plain",
};

test("a service SAS signs the response overrides and carries them as `rscc`, `rscd` and `rsct`", async () => {
  const configuration = readConfiguration({
    account: "devstoreaccount1",
    container: "conformance",
    endpoint: "https://127.0.0.1:10000/devstoreaccount1",
    credentials: { accountKey: emulatorKey },
  });

  const signed = await signServiceSas(configuration, { ...grant, overrides }, emulatorKey);

  expect(signed.stringToSign.split("\n").slice(-5)).toEqual([
    "no-cache",
    'attachment; filename="grüße.txt"',
    "", // rsce
    "", // rscl
    "text/plain",
  ]);
  // Computed apart from this signer: `openssl dgst -sha256 -mac HMAC` over the same string.
  expect(signed.query).toEqual([
    ["sv", "2026-04-06"],
    ["spr", "https,http"],
    ["st", "2026-08-30T12:21:00Z"],
    ["se", "2026-08-30T13:36:00Z"],
    ["sr", "b"],
    ["sp", "r"],
    ["rscc", "no-cache"],
    ["rscd", 'attachment; filename="grüße.txt"'],
    ["rsct", "text/plain"],
    ["sig", "fZvK8l41G+3w9ck13YAc4e+Wg6wSstZqyX50GMOAXn0="],
  ]);
});

/** A key as `Get User Delegation Key` answers it, its `Value` 32 bytes in base64. */
const delegationKey = {
  signedOid: "11111111-2222-3333-4444-555555555555",
  signedTid: "66666666-7777-8888-9999-000000000000",
  signedStart: "2026-08-30T12:21:00Z",
  signedExpiry: "2026-08-30T13:36:00Z",
  signedService: "b",
  signedVersion: "2026-04-06",
  value: "c3Rvd2FnZSB1c2VyIGRlbGVnYXRpb24ga2V5IDMyYiE=",
};

const emulatorConfiguration = readConfiguration({
  account: "devstoreaccount1",
  container: "conformance",
  endpoint: "https://127.0.0.1:10000/devstoreaccount1",
  credentials: { accessToken: "eyJ0eXAiOiJKV1QifQ.e30." },
});

test("a user delegation SAS binds the request headers `srh` names, each on a line of its own", async () => {
  const signed = await signUserDelegationSas(
    emulatorConfiguration,
    {
      ...grant,
      permissions: "w",
      signedHeaders: [
        ["content-type", "text/plain"],
        ["content-length", "11"],
        ["x-ms-blob-type", "BlockBlob"],
      ],
    },
    delegationKey,
  );

  expect(signed.stringToSign).toBe(
    [
      "w",
      "2026-08-30T12:21:00Z",
      "2026-08-30T13:36:00Z",
      "/blob/devstoreaccount1/conformance/a b/grüße.txt",
      "11111111-2222-3333-4444-555555555555",
      "66666666-7777-8888-9999-000000000000",
      "2026-08-30T12:21:00Z",
      "2026-08-30T13:36:00Z",
      "b",
      "2026-04-06",
      "", // saoid
      "", // suoid
      "", // scid
      "", // skdutid
      "", // sduoid
      "", // sip
      "https,http",
      "2026-04-06",
      "b",
      "", // snapshot time
      "", // ses
      // The canonicalized headers end in a newline of their own before the joining one.
      "content-type:text/plain\ncontent-length:11\nx-ms-blob-type:BlockBlob\n",
      "", // canonicalized signed request query parameters
      "", // rscc
      "", // rscd
      "", // rsce
      "", // rscl
      "", // rsct
    ].join("\n"),
  );
  // Computed apart from this signer: `openssl dgst -sha256 -mac HMAC` with the decoded
  // `Value` as the key.
  expect(signed.query).toEqual([
    ["sv", "2026-04-06"],
    ["spr", "https,http"],
    ["st", "2026-08-30T12:21:00Z"],
    ["se", "2026-08-30T13:36:00Z"],
    ["skoid", "11111111-2222-3333-4444-555555555555"],
    ["sktid", "66666666-7777-8888-9999-000000000000"],
    ["skt", "2026-08-30T12:21:00Z"],
    ["ske", "2026-08-30T13:36:00Z"],
    ["sks", "b"],
    ["skv", "2026-04-06"],
    ["sr", "b"],
    ["sp", "w"],
    ["srh", "content-type,content-length,x-ms-blob-type"],
    ["sig", "SssFzIi6C3txDPvhX139OdF4T/6ZoF3wy0ZiQ9Em9wo="],
  ]);
});

test("a user delegation SAS without headers signs the response overrides", async () => {
  const signed = await signUserDelegationSas(
    emulatorConfiguration,
    { ...grant, overrides },
    delegationKey,
  );

  expect(signed.query).not.toContainEqual(expect.arrayContaining(["srh"]));
  expect(signed.query.slice(-4)).toEqual([
    ["rscc", "no-cache"],
    ["rscd", 'attachment; filename="grüße.txt"'],
    ["rsct", "text/plain"],
    ["sig", "6I/MSqLEePyqni6R1ApREQqTiV/mEWnPnsCb1Fv0aY8="],
  ]);
});
