import { env } from "node:process";

import { afterAll, describe, test } from "vitest";

import { configuredStorage } from "../../s3/src/environment.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { describeServed, nodeBridge, servedTarget } from "../../targets/src/http.ts";

// Spec 2: one server covers the Node cells of `@stowage/http` and of the Node bridge, since
// the layer reaches Node through the bridge.
const configured = endpointTiersFrom(env).has("s3") ? configuredStorage() : undefined;
const served = configured === undefined ? undefined : await servedTarget(nodeBridge, configured);

afterAll(async () => await served?.close());

describeServed(served, { describe, test });
