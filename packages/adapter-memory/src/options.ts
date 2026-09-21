import { memoryError } from "./storage-error.ts";

export const operationOptionKeys = ["signal"] as const;
export const putOptionKeys = ["signal", "contentType", "userMetadata"] as const;
export const getOptionKeys = ["signal", "range"] as const;
export const listOptionKeys = ["signal", "prefix", "delimiter", "pageSize", "cursor"] as const;

/**
 * Refuses an option key the spec does not list, naming the key and never its value
 * (spec 4.3). TypeScript catches one at the call site; this catches the rest.
 */
export function requireKnownOptions(
  options: object | undefined,
  known: readonly string[],
  operation: string,
): void {
  if (options === undefined) return;

  for (const key of Object.keys(options)) {
    if (known.includes(key)) continue;

    throw memoryError({
      code: "InvalidOption",
      message: `The option \`${key}\` is not one this storage takes`,
      operation,
      attempts: 0,
    });
  }
}
