import type { StorageError } from "@stowage/core";

import { azureBlobError } from "./storage-error.ts";

// `isolatedDeclarations` refuses a spread in an exported array, so the lists carry an
// annotation rather than the tuple type `as const` would infer.
export const operationOptionKeys: readonly string[] = ["signal"];
export const putOptionKeys: readonly string[] = [
  ...operationOptionKeys,
  "contentType",
  "userMetadata",
];
export const getOptionKeys: readonly string[] = [...operationOptionKeys, "range"];
export const listOptionKeys: readonly string[] = [
  ...operationOptionKeys,
  "prefix",
  "delimiter",
  "pageSize",
  "cursor",
];

/**
 * Refuses an option key the spec does not list (spec 4.3). TypeScript catches one at the
 * call site; this catches the rest.
 */
export function requireKnownOptions(
  container: string,
  options: object | undefined,
  known: readonly string[],
  operation: string,
): void {
  if (options === undefined) return;

  for (const key of Object.keys(options)) {
    if (known.includes(key)) continue;

    throw optionError(container, key, "is not one this storage takes", operation);
  }
}

// The message names the option and never the value it refused (spec 4.3).
export function optionError(
  container: string,
  option: string,
  expectation: string,
  operation: string,
): StorageError {
  return azureBlobError(container, {
    code: "InvalidOption",
    message: `The option \`${option}\` ${expectation}`,
    operation,
    attempts: 0,
  });
}
