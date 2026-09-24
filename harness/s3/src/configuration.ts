import type { S3AdapterOptions } from "../../../packages/adapter-s3/src/index.ts";

/**
 * The variables `start.sh` prints. A runtime hands over its own: Node, Bun and Deno their
 * `process.env`, the `workerd` harness the bindings of its worker, where no `process`
 * exists to read them from.
 */
export type Variables = Readonly<Record<string, string | undefined>>;

/**
 * ADR 0012: the endpoint is configuration rather than a dependency, so the harness reads
 * a URL, a bucket and a credential from the environment and no case knows which server
 * answered.
 */
export function storageOptionsFrom(
  variables: Variables,
  credentials: S3AdapterOptions["credentials"],
): S3AdapterOptions | undefined {
  const endpoint = variables["STOWAGE_S3_ENDPOINT"];
  const bucket = variables["STOWAGE_S3_BUCKET"];

  if (endpoint === undefined || endpoint === "" || bucket === undefined || bucket === "") {
    return undefined;
  }

  return {
    bucket,
    region: variables["STOWAGE_S3_REGION"] ?? "us-east-1",
    endpoint,
    // The emulator answers on a loopback address, which no bucket name resolves in front
    // of; a real bucket is addressed virtual-hosted and leaves this unset.
    forcePathStyle: variables["STOWAGE_S3_FORCE_PATH_STYLE"] === "true",
    credentials,
  };
}

/**
 * Spec 8.3: a credential the provider refuses. No identity is configured for it — a key
 * id no provider ever issued is refused by every one of them.
 */
export function storageWithBadCredentials(configured: S3AdapterOptions): S3AdapterOptions {
  return {
    ...configured,
    credentials: { accessKeyId: "stowage-no-such-identity", secretAccessKey: "nor-this-secret" },
  };
}

/**
 * Spec 8.3: a credential the provider accepts and refuses the write to. It reads and
 * lists and may not write, which is what tells the `403` that means this caller may not
 * do this from the two that fail to authenticate.
 */
export function storageWithDeniedCredentials(
  configured: S3AdapterOptions,
  variables: Variables,
): S3AdapterOptions | undefined {
  const accessKeyId = variables["STOWAGE_S3_DENIED_ACCESS_KEY_ID"];
  const secretAccessKey = variables["STOWAGE_S3_DENIED_SECRET_ACCESS_KEY"];

  if (accessKeyId === undefined || accessKeyId === "") return undefined;
  if (secretAccessKey === undefined || secretAccessKey === "") return undefined;

  return { ...configured, credentials: { accessKeyId, secretAccessKey } };
}

/**
 * The real endpoints of ADR 0012, as `STOWAGE_S3_ENDPOINT_NAME` names them in the
 * scheduled run. The emulator is named by `start.sh`, and a divergence names it.
 */
export const realEndpoints: readonly string[] = ["aws-s3", "r2"];

/** Which server answers, for the harness alone: no case reads it (ADR 0012). */
export function endpointNameFrom(variables: Variables): string | undefined {
  return filled(variables["STOWAGE_S3_ENDPOINT_NAME"]);
}

function filled(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
