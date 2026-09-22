import type { ListOptions } from "@stowage/core";

import { requireKey } from "./key.ts";
import { listOptionKeys, optionError, requireKnownOptions } from "./options.ts";

// Spec 7.2: a page holds at most 1000 keys, which is what `ListObjectsV2` answers.
const defaultPageSize = 1000;
const maxPageSize = 1000;

/**
 * Everything spec 4.11 has `list` refuse without asking the provider. Spec 4.6 has the
 * listing send nothing until it is read, so this runs from the reader that asked rather
 * than from `list` itself. The `cursor` is the one option left to the provider: spec 7.9
 * reads the `InvalidArgument` it answers as `InvalidOption` naming the option.
 */
export function requireListOptions(bucket: string, options: ListOptions | undefined): void {
  requireKnownOptions(bucket, options, listOptionKeys, "list");
  requireKey(bucket, options?.prefix ?? "", "prefix", "list");

  const pageSize = options?.pageSize ?? defaultPageSize;

  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw optionError(bucket, "pageSize", `takes a whole number from 1 to ${maxPageSize}`, "list");
  }

  if (options?.delimiter === "") {
    throw optionError(bucket, "delimiter", "takes at least one character", "list");
  }
}
