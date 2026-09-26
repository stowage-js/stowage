import { expect, test } from "vitest";

import { readConfiguration } from "./configuration.ts";
import { signServiceSas } from "./sas.ts";

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
