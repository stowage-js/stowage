import { isStorageError, type StorageErrorCode } from "@stowage/core";

import type { ConformanceCaseMetadata } from "./case.ts";

export type ConformanceMode = "declared" | "without";

export interface SerializedConformanceError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: StorageErrorCode;
}

export type ConformanceResult =
  | {
      readonly case: ConformanceCaseMetadata;
      readonly status: "passed";
      readonly mode: ConformanceMode;
    }
  | { readonly case: ConformanceCaseMetadata; readonly status: "skipped"; readonly reason: string }
  | {
      readonly case: ConformanceCaseMetadata;
      readonly status: "failed";
      readonly mode: ConformanceMode;
      readonly error: SerializedConformanceError;
    };

/**
 * What a harness may carry out of a run (ADR 0006). Neither `cause` nor the thrown value
 * itself survives the trip out of a worker, so a result holds neither.
 */
export function serializeError(thrown: unknown): SerializedConformanceError {
  const serialized: { name: string; message: string; stack?: string; code?: StorageErrorCode } = {
    name: stringFieldOf(thrown, "name") ?? "Error",
    message: stringFieldOf(thrown, "message") ?? String(thrown),
  };

  const stack = stringFieldOf(thrown, "stack");

  if (stack !== undefined) serialized.stack = stack;
  if (isStorageError(thrown)) serialized.code = thrown.code;

  return serialized;
}

// The fields are read off the value rather than through `instanceof Error`: a case may
// throw anything, and an `Error` a worker hands back from another realm is none here.
function stringFieldOf(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;

  const held: unknown = Reflect.get(value, field);

  return typeof held === "string" ? held : undefined;
}
