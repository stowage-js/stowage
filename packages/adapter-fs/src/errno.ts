import { isStorageError, type StorageError, type StorageErrorCode } from "@stowage/core";

import { fsError } from "./storage-error.ts";

/** Which column of the table in spec 6 a failed syscall is read in. */
export type FsAccess = "read" | "write";

interface ErrnoMapping {
  readonly code: StorageErrorCode;
  /** The code a write is refused with, where spec 6 names another one for it. */
  readonly onWrite?: StorageErrorCode;
  readonly retryable?: boolean;
}

// The table of spec 6. Everything it does not name is a `ProviderError` the caller may
// not repeat, because nothing says the condition behind it passes.
const errnoMappings = new Map<string, ErrnoMapping>([
  ["ENOENT", { code: "NotFound" }],
  ["EISDIR", { code: "NotFound", onWrite: "InvalidRequest" }],
  ["ENOTDIR", { code: "NotFound", onWrite: "InvalidRequest" }],
  ["EACCES", { code: "AccessDenied" }],
  ["EPERM", { code: "AccessDenied" }],
  ["ENAMETOOLONG", { code: "InvalidKey" }],
  ["EMFILE", { code: "ProviderError", retryable: true }],
  ["EBUSY", { code: "ProviderError", retryable: true }],
  ["EAGAIN", { code: "ProviderError", retryable: true }],
]);

export interface FsFailure {
  readonly root: string;
  readonly operation: string;
  readonly access: FsAccess;
  readonly key?: string;
}

/**
 * What the file system threw, as the error spec 6 names for it. The adapter repeats
 * nothing, so the count is the one attempt the syscall made, and `retryable` says that
 * the condition may be gone rather than that anything was sent twice (spec 4.10).
 */
export function fsErrorFrom(thrown: unknown, failure: FsFailure): StorageError {
  const errno = errnoOf(thrown);
  const mapping = errno === undefined ? undefined : errnoMappings.get(errno);
  const onWrite = failure.access === "write" ? mapping?.onWrite : undefined;

  return fsError(failure.root, {
    code: onWrite ?? mapping?.code ?? "ProviderError",
    // Spec 4.10 has the message be the provider's own word for word, and for a file
    // system that is what the syscall reported, down to the path it names.
    message: messageOf(thrown),
    operation: failure.operation,
    key: failure.key,
    attempts: 1,
    retryable: mapping?.retryable ?? false,
    providerCode: errno,
    cause: thrown,
  });
}

/** The `errno` string of a failed syscall, which travels on as the provider code. */
export function errnoOf(thrown: unknown): string | undefined {
  if (typeof thrown !== "object" || thrown === null) return undefined;

  const code: unknown = Reflect.get(thrown, "code");

  return typeof code === "string" ? code : undefined;
}

/** The key names nothing this storage holds, which is what an absent file amounts to. */
export function isAbsence(thrown: unknown): boolean {
  const errno = errnoOf(thrown);

  return errno === "ENOENT" || errno === "ENOTDIR";
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * What a failed step reaches the caller as: the runtime's `AbortError` and a refusal this
 * adapter already shaped travel as they are, and everything else is read off the table
 * above (spec 4.10).
 */
export function asFailure(thrown: unknown, failure: FsFailure): unknown {
  if (isStorageError(thrown) || nameOf(thrown) === "AbortError") return thrown;

  return fsErrorFrom(thrown, failure);
}

function nameOf(thrown: unknown): string | undefined {
  if (typeof thrown !== "object" || thrown === null) return undefined;

  const name: unknown = Reflect.get(thrown, "name");

  return typeof name === "string" ? name : undefined;
}
