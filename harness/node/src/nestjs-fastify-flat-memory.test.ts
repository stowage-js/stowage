import { env } from "node:process";

import { describe, test } from "vitest";

import { configuredStorage } from "../../s3/src/environment.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { describeFlatMemory } from "../../targets/src/flat-memory.ts";
import { nestjsOnFastify } from "../../targets/src/nestjs.ts";

// A file of its own, so that Vitest's `forks` pool gives the measurement a process that
// runs nothing else (spec 14.8).
const configured = endpointTiersFrom(env).has("s3") ? configuredStorage() : undefined;

describeFlatMemory(nestjsOnFastify, configured, { describe, test });
