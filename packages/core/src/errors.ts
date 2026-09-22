import type { CapabilityName } from "./capabilities.ts";

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
  readonly attempts: number;
  readonly retryable: boolean;
  readonly key?: string;
  readonly status?: number;
  readonly providerCode?: string;
  readonly requestId?: string;
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
