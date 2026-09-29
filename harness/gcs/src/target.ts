import type { GcsAdapterOptions } from "../../../packages/adapter-gcs/src/index.ts";
import { gcsStorage } from "../../../packages/adapter-gcs/src/index.ts";
import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import {
  type ConformanceFramework,
  describeCases,
} from "../../../packages/conformance/src/describe.ts";
import {
  type ConformanceRunOptions,
  selectedCases,
} from "../../../packages/conformance/src/run.ts";
import type { ConformanceTarget } from "../../../packages/conformance/src/target.ts";
import { fakeGcsServer, withGcsDivergences } from "./divergences.ts";

/**
 * The cases the adapter passes while its operations arrive one by one: those that need
 * `put` of held bytes, user metadata, `get` with or without a range, `stat`, `exists` and
 * `list`, and the refusals `copy` and `move` make before any request, and nothing else.
 * Every operation that joins the adapter adds its cases here, until the list is the whole
 * suite and goes. The three credential cases stay in the list and report themselves
 * skipped, since the target supplies none of their factories (ADR 0033, ADR 0034).
 * `flow/3-file-browser` runs against fake-gcs-server as a divergence (`divergences.ts`).
 */
const coveredCases: ReadonlySet<string> = new Set([
  "declaration/valid-names",
  "declaration/identity",
  "put/bytes-round-trip",
  "put/string-round-trip",
  "put/overwrites",
  "put/content-type-stored",
  "put/content-type-default",
  "put/user-metadata",
  "put/user-metadata-limits",
  "put/user-metadata-token-keys",
  "put/refused-keys",
  "put/unknown-option",
  "put/aborted-signal",
  "get/missing-key",
  "get/stream",
  "get/text-and-json",
  "get/body-read-once",
  "get/stat-from-response",
  "get/addressable-keys",
  "get/refused-keys",
  "get/aborted-signal",
  "get/range",
  "get/range-unsatisfiable",
  "get/range-clipped",
  "stat/describes-object",
  "stat/missing-key",
  "exists/answers",
  "exists/invalid-key",
  "list/nothing",
  "list/every-object-once",
  "list/entry-shape",
  "list/pages-and-cursor",
  "list/delimiter",
  "list/prefix-mid-segment",
  "list/lazy",
  "list/page-size-bounds",
  "list/invalid-cursor",
  "list/invalid-delimiter",
  "list/past-one-thousand",
  "list/key-bytes",
  "errors/shape",
  "errors/bad-credentials",
  "errors/denied-credentials",
  "errors/expired-credentials",
  "errors/not-a-storage-error",
  "flow/3-file-browser",
  "flow/4-streaming-download",
]);

/**
 * Spec 10.7 and ADR 0034: GCS refuses the key `list/noncharacter-key` writes (spec 9.1), so
 * the case stays unrun on every GCS endpoint. It is no divergence, since no real endpoint
 * runs it to settle one, and it stays out once the list above goes.
 */
const unrunCases: ReadonlySet<string> = new Set(["list/noncharacter-key"]);

export function gcsCases(options: ConformanceRunOptions): readonly ConformanceCaseSource[] {
  return selectedCases(options).filter(
    (source) => coveredCases.has(source.name) && !unrunCases.has(source.name),
  );
}

/**
 * `adapter-gcs` against fake-gcs-server under the fixed token of ADR 0034. There is no
 * factory for a bad or a denied credential: the emulator checks neither.
 */
export function gcsTarget(configured: GcsAdapterOptions): ConformanceTarget {
  return {
    name: "@stowage/adapter-gcs",

    createStorage: () => gcsStorage(configured),

    // The default of spec 10.2 deletes below the prefix through `deleteAll`, which the
    // adapter does not have yet. fake-gcs-server holds the run in memory and is recreated
    // by every start, so nothing the run wrote outlives it.
    async cleanup() {},
  };
}

export const endpointMissing = "No GCS endpoint is configured; see `harness/gcs/README.md`";

/**
 * ADR 0034, after ADR 0012: a run includes this tier and fails where no endpoint is
 * reachable rather than passing with it skipped.
 */
export function describeGcsEndpointCheck(
  framework: ConformanceFramework,
  configured: GcsAdapterOptions | undefined,
): void {
  framework.test(
    "the GCS endpoint of ADR 0034 is configured (see `harness/gcs/README.md`)",
    async () => {
      if (configured === undefined) throw new Error(endpointMissing);
    },
  );
}

/**
 * The cases as a run against fake-gcs-server performs them, the one endpoint a harness
 * reaches until the scheduled run names the real bucket.
 */
export function gcsRunCases(options: ConformanceRunOptions): readonly ConformanceCaseSource[] {
  return withGcsDivergences(gcsCases(options), fakeGcsServer);
}

/** The check above, then the cases as a run against fake-gcs-server. */
export function describeGcs(
  framework: ConformanceFramework,
  configured: GcsAdapterOptions | undefined,
): void {
  describeGcsEndpointCheck(framework, configured);

  if (configured === undefined) return;

  describeCases(gcsRunCases(framework), gcsTarget(configured), framework);
}
