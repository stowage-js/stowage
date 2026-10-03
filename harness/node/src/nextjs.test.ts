import { env } from "node:process";

import { afterAll, describe, expect, test } from "vitest";

import { configuredStorage } from "../../s3/src/environment.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { describeServers } from "../../targets/src/http.ts";
import { nextjsServer } from "../../targets/src/nextjs.ts";

// Spec 2: `next build` and `next start`, the server a child process of this harness.
const configured = endpointTiersFrom(env).has("s3") ? configuredStorage() : undefined;
const nextjs = nextjsServer();

// Spec 13: the build runs without the variables the application's factory reads, which
// throws on each one missing, so a storage constructed at build time fails it.
test("`next build` constructs no storage", async () => {
  const { output } = await nextjs.build();

  expect(output).toMatch(/ƒ \/serve\/\[\.\.\.key\]/u);
}, 120_000);

const close = await describeServers([nextjs], "Node", configured, { describe, test });

afterAll(async () => {
  await close();
  await nextjs.remove();
});
