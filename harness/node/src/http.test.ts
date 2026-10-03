import { afterAll, describe, test } from "vitest";

import { serverStorage } from "../../s3/src/environment.ts";
import { describeServers, nodeBridge } from "../../targets/src/http.ts";

// Spec 2: one server covers the Node cells of `@stowage/http` and of the Node bridge, since
// the layer reaches Node through the bridge.
const configured = serverStorage();
const close = await describeServers([nodeBridge], "Node", configured, { describe, test });

afterAll(close);
