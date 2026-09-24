import type { S3AdapterOptions } from "../../../packages/adapter-s3/src/index.ts";

/**
 * The variables `start.sh` prints. A runtime hands over its own: Node, Bun and Deno their
 * `process.env`, the `workerd` harness the bindings of its worker, where no `process`
 * exists to read them from and a binding whose variable is unset arrives as `null`.
 */
export type Variables = Readonly<Record<string, string | null | undefined>>;

/**
 * ADR 0012: the endpoint is configuration rather than a dependency, so the harness reads
 * a URL, a bucket and a credential from the environment and no case knows which server
 * answered.
 */
export function storageOptionsFrom(
  variables: Variables,
  credentials: S3AdapterOptions["credentials"],
): S3AdapterOptions | undefined {
  const endpoint = filled(variables["STOWAGE_S3_ENDPOINT"]);
  const bucket = filled(variables["STOWAGE_S3_BUCKET"]);

  if (endpoint === undefined || bucket === undefined) return undefined;

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
  const accessKeyId = filled(variables["STOWAGE_S3_DENIED_ACCESS_KEY_ID"]);
  const secretAccessKey = filled(variables["STOWAGE_S3_DENIED_SECRET_ACCESS_KEY"]);

  if (accessKeyId === undefined || secretAccessKey === undefined) return undefined;

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

export interface ExpiredCredentials {
  readonly options: S3AdapterOptions;
  /** The expiration STS returned with the token, after which the provider refuses it. */
  readonly expiresAt: Date;
}

/**
 * Spec 8.3: a credential that has already expired. ADR 0012 has the scheduled run take a
 * 900-second STS token at its start and record the expiration; an endpoint without such
 * a token leaves the case skipped, which is what R2 does.
 */
export function storageWithExpiredCredentials(
  configured: S3AdapterOptions,
  variables: Variables,
): ExpiredCredentials | undefined {
  const accessKeyId = filled(variables["STOWAGE_S3_EXPIRED_ACCESS_KEY_ID"]);
  const secretAccessKey = filled(variables["STOWAGE_S3_EXPIRED_SECRET_ACCESS_KEY"]);
  const sessionToken = filled(variables["STOWAGE_S3_EXPIRED_SESSION_TOKEN"]);
  const expiration = filled(variables["STOWAGE_S3_EXPIRED_AT"]);

  if (accessKeyId === undefined || secretAccessKey === undefined) return undefined;
  if (sessionToken === undefined || expiration === undefined) return undefined;

  const expiresAt = new Date(expiration);

  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error(`STOWAGE_S3_EXPIRED_AT holds ${JSON.stringify(expiration)}, which is no time`);
  }

  return {
    options: { ...configured, credentials: { accessKeyId, secretAccessKey, sessionToken } },
    expiresAt,
  };
}

function filled(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : value;
}
