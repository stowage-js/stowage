import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import { type Divergence, withDivergences } from "../../s3/src/divergences.ts";

/**
 * The endpoints of ADR 0023, as `STOWAGE_AZURE_BLOB_ENDPOINT_NAME` names them: the
 * emulator by `start.sh`, the real account by the scheduled run.
 */
export type AzureBlobEmulator = "azurite";
export type AzureBlobRealEndpoint = "azure-blob";

const listedIn = "harness/azure-blob/src/divergences.ts";

/**
 * ADR 0025: the pinned Azurite answers `Put Blob From URL` with `501 APINotImplemented`,
 * and the implementation merged after it reads the source through a SAS alone and ignores
 * `x-ms-copy-source-authorization`, which every case sends under the access token.
 */
const copyUnimplemented = {
  endpoint: "azurite",
  differs:
    "Azurite 3.37.0 does not implement `Put Blob From URL`, and the release after it ignores `x-ms-copy-source-authorization`",
  settledBy: "azure-blob",
  upstream: "https://github.com/Azure/Azurite/pull/2749",
} as const;

// The two cases whose source is missing expect `NotFound`, and meet Azurite's `501` as a
// `ProviderError` before any message of Azurite's reaches their failure.
const notImplemented = "Current API is not implemented yet";
const missingSourceUnread = 'carries `code: "ProviderError"` rather than "NotFound"';

/**
 * ADR 0022: Azurite takes `srh` on a user delegation SAS and leaves the headers it names
 * out of the string to sign, so it refuses a signature that binds them, as the real account
 * requires (`docs/research/azure-srh-binding.md`), and accepts one that binds nothing.
 */
const signedHeadersUnbound = {
  endpoint: "azurite",
  differs:
    "Azurite 3.37.0 leaves the request headers `srh` names out of the string to sign of a user delegation SAS",
  settledBy: "azure-blob",
} as const;

// Kept in the private harness and never in `@stowage/conformance` (ADR 0012).
export const azureBlobDivergences: readonly Divergence<AzureBlobEmulator, AzureBlobRealEndpoint>[] =
  [
    { case: "copy/round-trip", failureMessagePart: notImplemented, ...copyUnimplemented },
    { case: "copy/overwrites", failureMessagePart: notImplemented, ...copyUnimplemented },
    { case: "copy/missing-source", failureMessagePart: missingSourceUnread, ...copyUnimplemented },
    { case: "copy/user-metadata", failureMessagePart: notImplemented, ...copyUnimplemented },
    { case: "move/round-trip", failureMessagePart: notImplemented, ...copyUnimplemented },
    { case: "move/missing-source", failureMessagePart: missingSourceUnread, ...copyUnimplemented },
    {
      case: "presign/put",
      failureMessagePart: "answered 403 and not a success",
      ...signedHeadersUnbound,
    },
    {
      case: "flow/2-presigned-put",
      failureMessagePart: "presigned URL was answered 403",
      ...signedHeadersUnbound,
    },
  ];

/** The cases as a run against `endpoint` performs them, after ADR 0012. */
export function withAzureBlobDivergences(
  sources: readonly ConformanceCaseSource[],
  endpoint: string | undefined,
): readonly ConformanceCaseSource[] {
  return withDivergences(sources, endpoint, azureBlobDivergences, listedIn);
}
