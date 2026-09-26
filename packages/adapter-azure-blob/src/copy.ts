import type { ObjectStat } from "@stowage/core";

import type { AzureBlobConfiguration } from "./configuration.ts";
import type { AzureBlobCredentials } from "./credentials.ts";
import { describeResponse } from "./description.ts";
import { blobUrl, send } from "./request.ts";
import { signServiceSas } from "./sas.ts";
import type { HeaderField } from "./sign.ts";

const minute = 60 * 1000;

/** ADR 0022: a SAS starts early enough for a service clock that trails this one. */
const sasLead = 15 * minute;

/** ADR 0025: long enough for the service to read the largest source one copy takes. */
const sourceSasLifetime = 60 * minute;

/**
 * Spec 8.7: one `Put Blob From URL`, which is synchronous and leaves the destination as it
 * was where it fails. It names neither content type nor user metadata, so the service
 * copies the source's; its answer names neither the size nor the user metadata of what it
 * wrote, so a `HEAD` of the destination describes it.
 */
export async function copyBlob(
  configuration: AzureBlobConfiguration,
  from: string,
  to: string,
  operation: string,
  signal: AbortSignal | undefined,
): Promise<ObjectStat> {
  signal?.throwIfAborted();

  const response = await send(configuration, {
    method: "PUT",
    operation,
    key: to,
    copySource: from,
    headers: async (credentials) => [
      ["x-ms-blob-type", "BlockBlob"],
      ...(await sourceAuthorization(configuration, from, credentials)),
    ],
    // Azure requires `Content-Length: 0`, which `fetch` sends for an empty body alone.
    body: new Uint8Array(0),
    signal,
  });

  await response.body?.cancel();

  const described = await send(configuration, { method: "HEAD", operation, key: to, signal });

  return describeResponse(configuration.container, to, operation, described);
}

/**
 * ADR 0025: a request signed with Shared Key does not authorize its source, even within
 * one account. Under an account key the source URL carries a service SAS signed with the
 * key this attempt resolved; under an access token the source is authorized by the same
 * token as the request, so the repeat of spec 8.3 renews both.
 */
async function sourceAuthorization(
  configuration: AzureBlobConfiguration,
  from: string,
  credentials: AzureBlobCredentials,
): Promise<readonly HeaderField[]> {
  if ("accessToken" in credentials) {
    return [
      ["x-ms-copy-source", blobUrl(configuration, from, [])],
      ["x-ms-copy-source-authorization", `Bearer ${credentials.accessToken}`],
    ];
  }

  const now = Date.now();
  const sas = await signServiceSas(
    configuration,
    {
      key: from,
      permissions: "r",
      start: new Date(now - sasLead),
      expiry: new Date(now + sourceSasLifetime),
    },
    credentials.accountKey,
  );

  return [["x-ms-copy-source", blobUrl(configuration, from, sas.query)]];
}
