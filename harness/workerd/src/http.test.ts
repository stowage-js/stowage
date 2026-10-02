import { env } from "node:process";

import { afterAll, describe, expect, test } from "vitest";

import * as http from "../../../packages/http/src/index.ts";
import { configuredStorage } from "../../s3/src/environment.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { describeServers } from "../../targets/src/http.ts";
import { workerdServer } from "./http-server.ts";

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

describe("`@stowage/http` on `workerd`", () => {
  test("loads whole at the flags of spec 1, the Node bridge among its exports", async () => {
    // No route is asked for, so no request reaches the endpoint these name.
    const started = await workerdServer("spec").start({
      bucket: "stowage",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:9",
      credentials: { accessKeyId: "unused", secretAccessKey: "unused" },
    });

    try {
      const response = await fetch(new URL("/exports", started.url("serve", "")));

      expect(await response.json()).toEqual(Object.keys(http).toSorted());
    } finally {
      await started.close();
    }
  });
});
