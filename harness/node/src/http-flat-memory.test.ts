import { describe, test } from "vitest";

import { serverStorage } from "../../s3/src/environment.ts";
import { describeFlatMemory } from "../../targets/src/flat-memory.ts";
import { nodeBridge } from "../../targets/src/http.ts";

// A file of its own, so that Vitest's `forks` pool gives the measurement a process that
// runs nothing else (spec 14.8).
const configured = serverStorage();

describeFlatMemory(nodeBridge, configured, { describe, test });
