import { env } from "node:process";

import { describe, test } from "vitest";

import { configuredStorage as configuredGcsStorage } from "../../gcs/src/environment.ts";
import { describeGcs } from "../../gcs/src/target.ts";
import { describeAdapters } from "../../targets/src/index.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { runOptionsFrom } from "../../targets/src/run-options.ts";

describeAdapters({ describe, test });

// Spec 2 promises the GCS column on every runtime; Node runs it first, and the other
// harnesses join it through `describeAdapters` once their jobs start fake-gcs-server.
if (endpointTiersFrom(env).has("gcs")) {
  describeGcs({ describe, test, ...runOptionsFrom(env) }, configuredGcsStorage());
}
