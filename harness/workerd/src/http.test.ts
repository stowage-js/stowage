import { env } from "node:process";

import { afterAll, describe, expect, test } from "vitest";

import * as http from "../../../packages/http/src/index.ts";
import { configuredStorage } from "../../s3/src/environment.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { describeServers } from "../../targets/src/http.ts";
import { type HttpConfig, workerdServer } from "./http-server.ts";

// Spec 2: on `workerd` only the server runs inside the runtime, and the cases run here, in
// the Node harness, once against each set of flags.
const configured = endpointTiersFrom(env).has("s3") ? configuredStorage() : undefined;
const close = await describeServers(
  [workerdServer("spec"), workerdServer("defaults")],
  "workerd",
  configured,
  { describe, test },
);

afterAll(close);

/** The answer of the worker at `path`, started at `config` and stopped again. */
async function answerOf(config: HttpConfig, path: string): Promise<unknown> {
  // No route is asked for, so no request reaches the endpoint these name.
  const started = await workerdServer(config).start({
    bucket: "stowage",
    region: "us-east-1",
    endpoint: "http://127.0.0.1:9",
    credentials: { accessKeyId: "unused", secretAccessKey: "unused" },
  });

  try {
    const response = await fetch(new URL(path, started.url("serve", "")));

    return await response.json();
  } finally {
    await started.close();
  }
}

describe("`@stowage/http` on `workerd`", () => {
  test("loads whole at the flags of spec 1, the Node bridge among its exports", async () => {
    expect(await answerOf("spec", "/exports")).toEqual(Object.keys(http).toSorted());
  });

  test("runs at the flags of spec 1 without a Node API to reach", async () => {
    expect(await answerOf("spec", "/node-api")).toEqual({
      process: "undefined",
      Buffer: "undefined",
      "node:os": "rejected",
      "node:buffer": "rejected",
    });
  });

  // Without this, a probe that could not see a Node API at all would pass the test above.
  test("reaches Node APIs at the default flags", async () => {
    expect(await answerOf("defaults", "/node-api")).toEqual({
      process: "object",
      Buffer: "function",
      "node:os": "loaded",
      "node:buffer": "loaded",
    });
  });
});
