import { afterAll, describe, test } from "vitest";

import { serverStorage } from "../../s3/src/environment.ts";
import { describeFlatMemory } from "../../targets/src/flat-memory.ts";
import { nextjsServer } from "../../targets/src/nextjs.ts";

// A file of its own, so that Vitest's `forks` pool gives the client's side of the
// measurement a process that runs nothing else (spec 14.8); `next start` runs in its own.
const configured = serverStorage();
const nextjs = nextjsServer();

describeFlatMemory(nextjs, configured, { describe, test });

afterAll(async () => await nextjs.remove());
