import type { GcsAdapterOptions } from "../../../packages/adapter-gcs/src/index.ts";
import type { Variables } from "../../s3/src/configuration.ts";

/**
 * ADR 0034: fake-gcs-server checks no credential, so the target resolves one fixed token,
 * which still travels as the bearer every request carries.
 */
const emulatorToken = "fake-gcs-server";

/**
 * ADR 0034: the endpoint is configuration rather than a dependency, so the harness reads a
 * URL and a bucket from the environment `start.sh` prints, and no case knows which server
 * answered.
 */
export function storageOptionsFrom(variables: Variables): GcsAdapterOptions | undefined {
  const endpoint = filled(variables["STOWAGE_GCS_ENDPOINT"]);
  const bucket = filled(variables["STOWAGE_GCS_BUCKET"]);

  if (endpoint === undefined || bucket === undefined) return undefined;

  return { bucket, endpoint, credentials: { accessToken: emulatorToken } };
}

function filled(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : value;
}
