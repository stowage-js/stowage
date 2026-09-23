import { env } from "node:process";

import { configuredStorage, endpointMissing } from "../../s3/src/environment.ts";
import { endpointConfiguredTest, s3Target } from "../../s3/src/target.ts";
import {
  type ConformanceFramework,
  describeCases,
  describeConformance,
} from "../../../packages/conformance/src/describe.ts";
import { selectedCases } from "../../../packages/conformance/src/run.ts";
import { fsCases, fsTarget } from "./fs.ts";
import { memoryTarget } from "./memory.ts";

/**
 * The `fast` tier against the three adapters spec 2 names for Node, Bun and Deno. The
 * columns share it whole, and a harness differs from the next in the framework it hands
 * over and nothing else, which is what keeps runtime detection out of the cases.
 */
export function describeAdapters(framework: ConformanceFramework): void {
  // ADR 0006: `adapter-memory` is read against the suite like any other adapter, through
  // the same entry point a third-party harness calls.
  describeConformance(memoryTarget, framework);

  describeCases(fsCases(), fsTarget, framework);

  const configured = configuredStorage();

  framework.test(endpointConfiguredTest, async () => {
    if (configured === undefined) throw new Error(endpointMissing);
  });

  if (configured !== undefined)
    describeCases(selectedCases(), s3Target(configured, env), framework);
}
