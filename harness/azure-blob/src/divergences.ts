import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import { type Divergence, withDivergences } from "../../s3/src/divergences.ts";

/**
 * The endpoints of ADR 0023, as `STOWAGE_AZURE_BLOB_ENDPOINT_NAME` names them: the
 * emulator by `start.sh`, the real account by the scheduled run.
 */
export type AzureBlobEmulator = "azurite";
export type AzureBlobRealEndpoint = "azure-blob";

export const azureBlobAccount: AzureBlobRealEndpoint = "azure-blob";

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

const notImplemented = "Current API is not implemented yet";

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

/**
 * ADR 0067: Azurite refuses a stale access token with an answer the adapter does not refresh
 * after, so the case fails at `get`, its first operation under the stale credential.
 */
const staleCredentialUnrefreshed = {
  endpoint: "azurite",
  differs:
    "Azurite 3.37.0 answers a token it cannot read, and one past its `exp`, with `403 AuthenticationFailed` where the account answers `401 InvalidAuthenticationInfo`, so no refresh follows",
  settledBy: "azure-blob",
} as const;

// Kept in the private harness and never in `@stowage/conformance` (ADR 0012).
export const azureBlobDivergences: readonly Divergence<AzureBlobEmulator, AzureBlobRealEndpoint>[] =
  [
    {
      case: "errors/stale-credentials",
      failureMessagePart:
        "`get` under a stale credential rejected with `InvalidCredentials` and `attempts: 1` after no refresh",
      ...staleCredentialUnrefreshed,
    },
    { case: "copy/round-trip", failureMessagePart: notImplemented, ...copyUnimplemented },
    { case: "copy/overwrites", failureMessagePart: notImplemented, ...copyUnimplemented },
    // ADR 0068: `copy/missing-source` and `move/missing-source` are not here, since the `HEAD` in
    // front of the copy finds a missing source before Azurite meets the copy.
    { case: "copy/user-metadata", failureMessagePart: notImplemented, ...copyUnimplemented },
    { case: "copy/content-headers", failureMessagePart: notImplemented, ...copyUnimplemented },
    { case: "move/round-trip", failureMessagePart: notImplemented, ...copyUnimplemented },
    { case: "move/content-headers", failureMessagePart: notImplemented, ...copyUnimplemented },
    {
      case: "presign/put",
      failureMessagePart: "answered 403 and not a success",
      ...signedHeadersUnbound,
    },
    {
      case: "presign/put-content-headers",
      failureMessagePart: "carrying the content headers answered 403 and not a success",
      ...signedHeadersUnbound,
    },
    {
      case: "flow/2-presigned-put",
      failureMessagePart: "presigned URL was answered 403",
      ...signedHeadersUnbound,
    },
    // Spec 8.4 and ADR 0020: from `2021-02-12` the account lists a name holding `U+FFFE` as
    // `<Name Encoded="true">`, which the adapter decodes (#171).
    {
      case: "list/noncharacter-key",
      endpoint: "azurite",
      differs:
        "Azurite 3.37.0 answers a `List Blobs` whose result holds a name with `U+FFFE` with `500`",
      unrunBecause:
        "the blob the case leaves behind fails the `cleanup` of the run, whose `deleteAll` lists the run's prefix first",
      settledBy: "azure-blob",
    },
  ];

/** The cases as a run against `endpoint` performs them, after ADR 0012. */
export function withAzureBlobDivergences(
  sources: readonly ConformanceCaseSource[],
  endpoint: string | undefined,
): readonly ConformanceCaseSource[] {
  return withDivergences(sources, endpoint, azureBlobDivergences, listedIn);
}
