import { afterAll, describe, expect, test } from "vitest";

import { serverStorage } from "../../s3/src/environment.ts";
import { describeServers } from "../../targets/src/http.ts";
import { eagerBuildFailure, nextjsServer } from "../../targets/src/nextjs.ts";

const configured = serverStorage();
const nextjs = nextjsServer();

// Spec 13: the build runs without the variables the application's factory reads, which
// throws on each one missing, so a storage constructed at build time fails it.
test("`next build` constructs no storage", async () => {
  const { output } = await nextjs.build();

  expect(output).toMatch(/ƒ \/serve\/\[\.\.\.key\]/u);
}, 120_000);

// Without this, the test above would pass as well for a build that evaluated no route module.
test("`next build` fails where the storage is constructed as the module is evaluated", async () => {
  expect(await eagerBuildFailure()).toMatch(/STOWAGE_S3_\w+ is not set/u);
}, 120_000);

const close = await describeServers([nextjs], "Node", configured, { describe, test });

afterAll(async () => {
  await close();
  await nextjs.remove();
});
