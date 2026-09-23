import { memoryStorage } from "../../../packages/adapter-memory/src/index.ts";
import type { ConformanceTarget } from "../../../packages/conformance/src/target.ts";

export const memoryTarget: ConformanceTarget = {
  name: "@stowage/adapter-memory",
  createStorage: () => memoryStorage(),
};
