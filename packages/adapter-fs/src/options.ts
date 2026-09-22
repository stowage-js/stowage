import type { StorageError } from "@stowage/core";

import { fsError } from "./storage-error.ts";

// `isolatedDeclarations` refuses a spread in an exported array, so the lists carry an
// annotation rather than the tuple type `as const` would infer.
export const operationOptionKeys: readonly string[] = ["signal"];
export const putOptionKeys: readonly string[] = [
  ...operationOptionKeys,
  "contentType",
  "userMetadata",
];
export const getOptionKeys: readonly string[] = [...operationOptionKeys, "range"];
export const adapterOptionKeys: readonly string[] = ["root"];

/**
 * Refuses an option key the spec does not list (spec 4.3), in a call as well as in the
 * configuration a storage is constructed from. TypeScript catches one at the call site;
 * this catches the rest.
 */
export function requireKnownOptions(
  root: string,
  options: object | undefined,
  known: readonly string[],
  operation: string,
): void {
  if (options === undefined) return;

  for (const key of Object.keys(options)) {
    if (known.includes(key)) continue;

    throw optionError(root, key, "is not one this storage takes", operation);
  }
}

// The message names the option and never the value it refused (spec 4.3).
export function optionError(
  root: string,
  option: string,
  expectation: string,
  operation: string,
): StorageError {
  return fsError(root, {
    code: "InvalidOption",
    message: `The option \`${option}\` ${expectation}`,
    operation,
    attempts: 0,
  });
}
