import type { AzureBlobAdapterOptions } from "../../../packages/adapter-azure-blob/src/index.ts";
import type { Variables } from "../../s3/src/configuration.ts";

/**
 * ADR 0023: the endpoint is configuration rather than a dependency, so the harness reads a
 * URL, an account, a container and a credential from the environment `start.sh` prints,
 * and no case knows which server answered.
 */
export function storageOptionsFrom(
  variables: Variables,
  credentials: AzureBlobAdapterOptions["credentials"],
): AzureBlobAdapterOptions | undefined {
  const endpoint = filled(variables["STOWAGE_AZURE_BLOB_ENDPOINT"]);
  const account = filled(variables["STOWAGE_AZURE_BLOB_ACCOUNT"]);
  const container = filled(variables["STOWAGE_AZURE_BLOB_CONTAINER"]);

  if (endpoint === undefined || account === undefined || container === undefined) {
    return undefined;
  }

  return { account, container, endpoint, credentials };
}

function filled(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : value;
}
