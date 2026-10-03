import { describe, test } from "vitest";

import { serverStorage } from "../../s3/src/environment.ts";
import { describeFlatMemory } from "../../targets/src/flat-memory.ts";
import { honoNodeServer } from "../../targets/src/hono-node-server.ts";

// A file of its own, so that Vitest's `forks` pool gives the measurement a process that
// runs nothing else (spec 14.8).
const configured = serverStorage();

describeFlatMemory(honoNodeServer, configured, { describe, test });
