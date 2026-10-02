import { env } from "node:process";

import { afterAll, describe, test } from "vitest";

import { configuredStorage } from "../../s3/src/environment.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { describeServers, nodeBridge } from "../../targets/src/http.ts";

// Spec 2: one server covers the Node cells of `@stowage/http` and of the Node bridge, since
// the layer reaches Node through the bridge.
const configured = endpointTiersFrom(env).has("s3") ? configuredStorage() : undefined;
const close = await describeServers([nodeBridge], "Node", configured, { describe, test });

afterAll(close);
