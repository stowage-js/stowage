import { env } from "node:process";

import { afterAll, describe, test } from "vitest";

import { configuredStorage } from "../../s3/src/environment.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { honoNodeServer } from "../../targets/src/hono-node-server.ts";
import { describeServers } from "../../targets/src/http.ts";

// A file apart from the bridge's, since `@hono/node-server` replaces the global `Request`
// and `Response` for the rest of the process it runs in.
const configured = endpointTiersFrom(env).has("s3") ? configuredStorage() : undefined;
const close = await describeServers([honoNodeServer], "Node", configured, { describe, test });

afterAll(close);
