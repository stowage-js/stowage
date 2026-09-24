import type { ConformanceRunOptions } from "../../../packages/conformance/src/run.ts";
import type { Variables } from "../../s3/src/configuration.ts";

/**
 * ADR 0006: the per-commit run is the `fast` tier, and the scheduled one asks for both
 * through this variable, which every harness reads from where its runtime keeps it.
 */
export function runOptionsFrom(variables: Variables): ConformanceRunOptions {
  return { includeSlow: variables["STOWAGE_CONFORMANCE_INCLUDE_SLOW"] === "true" };
}
