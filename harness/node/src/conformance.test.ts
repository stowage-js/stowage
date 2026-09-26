import { env } from "node:process";

import { describe, test } from "vitest";

import { configuredStorage } from "../../azure-blob/src/environment.ts";
import { describeAzureBlob } from "../../azure-blob/src/target.ts";
import { describeAdapters } from "../../targets/src/index.ts";
import { runOptionsFrom } from "../../targets/src/run-options.ts";

describeAdapters({ describe, test });

// Spec 2 promises the Azure column on every runtime; Node runs it first, and the other
// harnesses join it through `describeAdapters` once they trust Azurite's certificate.
describeAzureBlob({ describe, test, ...runOptionsFrom(env) }, configuredStorage());
