import type { GcsAdapterOptions, GcsSigner } from "../../../packages/adapter-gcs/src/index.ts";
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
 * `put` of held bytes and of a stream, user metadata, `get` with or without a range, `stat`, `exists`,
 * `list`, `delete`, `deleteAll`, `copy`, `move` and the presigned URLs, and nothing else.
 * Every operation that joins the adapter adds its cases here, until the list is the whole
 * suite and goes. The three credential cases stay in the list and report themselves
 * skipped, since the target supplies none of their factories (ADR 0033, ADR 0034).
 * `flow/3-file-browser`, the three rejections a presigned URL owes and the two cases of
 * `move` run against fake-gcs-server as divergences (`divergences.ts`).
 */
const coveredCases: ReadonlySet<string> = new Set([
  "declaration/valid-names",
  "declaration/identity",
  "put/bytes-round-trip",
  "put/string-round-trip",
  "put/stream-round-trip",
  "put/multipart-round-trip",
  "put/empty-body",
  "put/abort-during-upload",
  "put/stream-consumed",
  "put/concurrent-writers",
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
  "delete/single",
  "delete/many",
  "delete/absent-key-succeeds",
  "delete/nothing",
  "delete/invalid-key-reported",
  "delete/past-one-thousand",
  "deleteAll/below-prefix",
  "deleteAll/nothing",
  "deleteAll/past-one-thousand",
  "copy/round-trip",
  "copy/overwrites",
  "copy/missing-source",
  "copy/onto-itself",
  "copy/invalid-keys",
  "copy/user-metadata",
  "move/round-trip",
  "move/missing-source",
  "presign/get",
  "presign/put",
  "presign/expires-in-bounds",
  "presign/put-rejects-type",
  "presign/put-rejects-length",
  "presign/expired-url",
  "errors/shape",
  "errors/bad-credentials",
  "errors/denied-credentials",
  "errors/expired-credentials",
  "errors/not-a-storage-error",
  "flow/1-large-upload",
  "flow/2-presigned-put",
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
 * ADR 0034: the service account the URLs name. fake-gcs-server checks no signature, so it
 * names no account that exists.
 */
const emulatorServiceAccount = "fake-gcs-server@stowage.invalid";

/**
 * `adapter-gcs` against fake-gcs-server under the fixed token of ADR 0034, signing its URLs
 * with an RSA key generated for the run, so that the presigning cases and flow 2 run on every
 * commit. There is no factory for a bad or a denied credential: the emulator checks neither.
 */
export function gcsTarget(configured: GcsAdapterOptions): ConformanceTarget {
  let signer: Promise<GcsSigner> | undefined;

  return {
    name: "@stowage/adapter-gcs",

    async createStorage() {
      signer ??= generatedSigner();

      return gcsStorage({ ...configured, signer: await signer });
    },
  };
}

/** A key of Web Crypto's own on every runtime, and never extractable, since nothing reads it. */
async function generatedSigner(): Promise<GcsSigner> {
  const { privateKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    false,
    ["sign", "verify"],
  );

  return { serviceAccount: emulatorServiceAccount, privateKey };
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
