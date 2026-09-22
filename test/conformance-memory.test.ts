import { describe, test } from "vitest";

import { memoryStorage } from "../packages/adapter-memory/src/index.ts";
import { describeConformance } from "../packages/conformance/src/index.ts";

// ADR 0006: `adapter-memory` is read against the suite like any other adapter, through
// the same entry point a third-party harness calls.
describeConformance(
  { name: "@stowage/adapter-memory", createStorage: () => memoryStorage() },
  { describe, test },
);
