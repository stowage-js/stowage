import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import { type Divergence, withDivergences } from "../../s3/src/divergences.ts";

/** The endpoints of ADR 0034: the emulator every commit runs against, the real bucket. */
export type GcsEmulator = "fake-gcs-server";
export type GcsRealEndpoint = "gcs";

export const fakeGcsServer: GcsEmulator = "fake-gcs-server";
export const gcsBucket: GcsRealEndpoint = "gcs";

const listedIn = "harness/gcs/src/divergences.ts";

/**
 * ADR 0034: fake-gcs-server serves every signed URL, so a rejection a presigned URL owes fails
 * against it by construction, and the real bucket runs the same case in the `slow` tier.
 */
const signatureUnchecked = {
  endpoint: fakeGcsServer,
  differs:
    "fake-gcs-server 1.56.1 validates neither the signature nor the expiry of a signed URL, as its README states",
  settledBy: "gcs",
  upstream:
    "https://github.com/fsouza/fake-gcs-server/blob/v1.56.1/README.md#using-with-signed-urls",
} as const;

/**
 * ADR 0037: fake-gcs-server serves no `moveTo` and answers every call `400 invalid`, the source
 * left where it was, so the real bucket runs the cases of `move` in the `slow` tier.
 */
const moveUnserved = {
  endpoint: fakeGcsServer,
  differs:
    "fake-gcs-server 1.56.1 serves no `objects.move` and answers every `moveTo` with `400 invalid`",
  settledBy: "gcs",
} as const;

// Kept in the private harness and never in `@stowage/conformance` (ADR 0012). An entry joins
// with the case that shows the difference (ADR 0034).
export const gcsDivergences: readonly Divergence<GcsEmulator, GcsRealEndpoint>[] = [
  // ADR 0034: GCS counts the pseudo-directories of a page towards `maxResults` beside its
  // objects, and the emulator truncates the objects alone, so the level of flow 3, four
  // objects and three pseudo-directories under a page size of five, arrives as one page.
  {
    case: "flow/3-file-browser",
    endpoint: fakeGcsServer,
    differs:
      "fake-gcs-server 1.56.1 counts the objects of a page towards `maxResults` and not its prefixes",
    failureMessagePart: "carries no cursor",
    settledBy: "gcs",
  },
  {
    case: "presign/expired-url",
    failureMessagePart: "that has expired was answered 200",
    ...signatureUnchecked,
  },
  {
    case: "presign/put-rejects-length",
    failureMessagePart: "carrying another length was answered 200",
    ...signatureUnchecked,
  },
  {
    case: "presign/put-rejects-type",
    failureMessagePart: "carrying another content type was answered 200",
    ...signatureUnchecked,
  },
  {
    case: "move/round-trip",
    failureMessagePart: "Metadata in the request couldn't decode",
    ...moveUnserved,
  },
  {
    case: "move/missing-source",
    failureMessagePart: 'carries `code: "ProviderError"` rather than "NotFound"',
    ...moveUnserved,
  },
  // ADR 0043: GCS names a missing bucket in the message of its `404` (spec 9.8), and without
  // it the adapter reads a missing object. `exists` then answers `false`, and `delete` reports
  // the key as deleted.
  {
    case: "errors/missing-bucket",
    endpoint: fakeGcsServer,
    differs:
      "fake-gcs-server 1.56.1 answers every request to a missing bucket with the `404 Not Found` of a missing object, never with `The specified bucket does not exist.`",
    failureMessagePart: "`put` in a missing bucket is `NotFound` naming the key",
    settledBy: "gcs",
  },
];

/** The cases as a run against `endpoint` performs them, after ADR 0012. */
export function withGcsDivergences(
  sources: readonly ConformanceCaseSource[],
  endpoint: string | undefined,
): readonly ConformanceCaseSource[] {
  return withDivergences(sources, endpoint, gcsDivergences, listedIn);
}
