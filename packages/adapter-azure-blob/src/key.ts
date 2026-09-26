import { invalidKeyReason, type KeyRule, type StorageError } from "@stowage/core";

import { azureBlobError } from "./storage-error.ts";

/** Azure's limit on the segments of a blob name. */
export const segmentLimit = 254;

/** C1 controls, which the core rule lets through and Azure forbids or advises against. */
const c1Control = /[\u0080-\u009f]/u;

/**
 * Spec 8.1: three kinds of writable key Azure forbids or advises against are refused
 * before any request (ADR 0020). An addressable key and a prefix meet the
 * core rule alone, so that a blob another tool wrote stays reachable.
 */
export function requireKey(container: string, key: string, rule: KeyRule, operation: string): void {
  const reason =
    invalidKeyReason(key, rule) ?? (rule === "writable" ? azureReason(key) : undefined);

  if (reason === undefined) return;

  throw keyError(container, key, reason, operation);
}

function azureReason(key: string): string | undefined {
  const control = c1Control.exec(key)?.[0];

  if (control !== undefined) {
    const code = control.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");

    return `holds the control character U+${code}`;
  }

  const segments = key.split("/");

  if (segments.length > segmentLimit) {
    return `has ${segments.length} segments, above the limit of ${segmentLimit}`;
  }

  // Azure says to avoid a dot that ends a segment without saying what becomes of it, and
  // loosening a key rule later costs nothing where tightening one costs a minor release.
  const dotted = segments.find((segment) => segment.endsWith("."));

  if (dotted !== undefined) return `holds the segment ${JSON.stringify(dotted)}, ending in a dot`;

  return undefined;
}

function keyError(container: string, key: string, reason: string, operation: string): StorageError {
  return azureBlobError(container, {
    code: "InvalidKey",
    message: `The key ${JSON.stringify(key)} ${reason}`,
    operation,
    key,
    attempts: 0,
  });
}
