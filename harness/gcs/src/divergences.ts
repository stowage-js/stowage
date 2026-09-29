import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import { type Divergence, withDivergences } from "../../s3/src/divergences.ts";

/** The endpoints of ADR 0034: the emulator every commit runs against, the real bucket. */
export type GcsEmulator = "fake-gcs-server";
export type GcsRealEndpoint = "gcs";

export const fakeGcsServer: GcsEmulator = "fake-gcs-server";

const listedIn = "harness/gcs/src/divergences.ts";

// Kept in the private harness and never in `@stowage/conformance` (ADR 0012). An entry joins
// with the case that shows the difference (ADR 0034).
export const gcsDivergences: readonly Divergence<GcsEmulator, GcsRealEndpoint>[] = [];

/** The cases as a run against `endpoint` performs them, after ADR 0012. */
export function withGcsDivergences(
  sources: readonly ConformanceCaseSource[],
  endpoint: string | undefined,
): readonly ConformanceCaseSource[] {
  return withDivergences(sources, endpoint, gcsDivergences, listedIn);
}
