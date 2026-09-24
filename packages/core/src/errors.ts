import type { CapabilityName } from "./capabilities.ts";

/**
 * What went wrong, as the one field a caller branches on (spec 4.10). A code added here is a
 * minor release, so a `switch` over it needs a default branch.
 *
 * - `NotFound`: no object under the key, or no bucket; `stat` cannot tell the two apart.
 * - `AccessDenied`: the credential is valid and may not do this.
 * - `InvalidCredentials`: the provider does not accept the credential, or a required
 *   credential field is empty or unknown.
 * - `Expired`: the credential or session token has expired.
 * - `InvalidRequest`: the provider or stowage refused the request for what it asked, such as
 *   metadata over the limit, an unsatisfiable range, a copy onto itself or a second read of a
 *   body.
 * - `NetworkError`: the request received no response.
 * - `ProviderError`: the provider answered with a failure stowage has no other name for;
 *   `providerCode` carries its string.
 * - `InvalidKey`: the key violates the key rule, or a rule the adapter adds to it.
 * - `InvalidOption`: an option or configuration value stowage refused, such as an unknown key,
 *   a value out of range or a cursor it did not produce.
 * - `Unsupported`: the call needs a capability the storage does not declare; `capability`
 *   names it.
 */
export type StorageErrorCode =
  | "NotFound"
  | "AccessDenied"
  | "InvalidCredentials"
  | "Expired"
  | "InvalidRequest"
  | "NetworkError"
  | "ProviderError"
  | "InvalidKey"
  | "InvalidOption"
  | "Unsupported";

export interface StorageErrorFields {
  readonly code: StorageErrorCode;
  readonly message: string;
  readonly operation: string;
  readonly bucket: string;
  readonly provider: string;
  readonly attempts: number;
  readonly key?: string;
  readonly status?: number;
  readonly providerCode?: string;
  readonly requestId?: string;
  readonly retryable?: boolean;
  readonly capability?: CapabilityName;
  readonly cause?: unknown;
}

// ADR 0005: two copies of `@stowage/core` in one dependency tree produce two
// constructors, so the guard tests a brand under a registered symbol instead of the
// constructor `instanceof` would compare.
const storageErrorBrand: symbol = Symbol.for("stowage.error");

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly operation: string;
  readonly bucket: string;
  readonly provider: string;
  /**
   * How often the failing step was attempted: `0` where stowage refused before the first
   * attempt, `1` where a single attempt failed, more where the adapter repeated it.
   */
  readonly attempts: number;
  /** The condition is transient. It says nothing about whether stowage sent the request again. */
  readonly retryable: boolean;
  readonly key?: string;
  readonly status?: number;
  readonly providerCode?: string;
  readonly requestId?: string;
  /** The capability an `Unsupported` failure needs, and set for no other code. */
  readonly capability?: CapabilityName;

  constructor(fields: StorageErrorFields) {
    super(fields.message);

    if (fields.code === "Unsupported" && fields.capability === undefined) {
      throw new TypeError("An `Unsupported` storage error names the capability it needs");
    }

    this.name = "StorageError";
    this.code = fields.code;
    this.operation = fields.operation;
    this.bucket = fields.bucket;
    this.provider = fields.provider;
    this.attempts = fields.attempts;
    this.retryable = fields.retryable ?? false;
    this.key = fields.key;
    this.status = fields.status;
    this.providerCode = fields.providerCode;
    this.requestId = fields.requestId;
    this.capability = fields.capability;

    if (fields.cause !== undefined) this.cause = fields.cause;

    Object.defineProperty(this, storageErrorBrand, { value: true });
  }
}

export function isStorageError(value: unknown): value is StorageError {
  return typeof value === "object" && value !== null && storageErrorBrand in value;
}

/**
 * The same failure counting the attempts a whole retry loop made rather than the one it
 * was raised in. It lives beside the field list, because every field has to be named
 * again here or it is dropped on the way through; the stack travels along, because it
 * points at where the request failed and this is no other place it could have failed.
 *
 * Not published: spec 4.13 lists what an adapter calls, and `withRetry` is the one
 * caller this has.
 */
export function withAttempts(failure: StorageError, attempts: number): StorageError {
  if (failure.attempts === attempts) return failure;

  const counted = new StorageError({
    code: failure.code,
    message: failure.message,
    operation: failure.operation,
    bucket: failure.bucket,
    provider: failure.provider,
    attempts,
    key: failure.key,
    status: failure.status,
    providerCode: failure.providerCode,
    requestId: failure.requestId,
    retryable: failure.retryable,
    capability: failure.capability,
    cause: failure.cause,
  });

  counted.stack = failure.stack;

  return counted;
}
