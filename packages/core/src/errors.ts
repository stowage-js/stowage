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
    super(fields.message, { cause: fields.cause });

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

    Object.defineProperty(this, storageErrorBrand, { value: true });
  }
}

export function isStorageError(value: unknown): value is StorageError {
  return typeof value === "object" && value !== null && storageErrorBrand in value;
}
