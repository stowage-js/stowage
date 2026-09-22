import type { ListOptions } from "@stowage/core";

import { requireKey } from "./key.ts";
import { listOptionKeys, optionError, requireKnownOptions } from "./options.ts";

// Spec 7.2: a page holds at most 1000 keys, which is what `ListObjectsV2` answers.
const defaultPageSize = 1000;
const maxPageSize = 1000;

export interface ListRequest {
  readonly prefix: string;
  readonly delimiter?: string;
  readonly pageSize: number;
  /** The continuation token the page before this one ended with. */
  readonly cursor?: string;
}

/**
 * The listing one reader asks for. Spec 4.6 has `list` send nothing until it is read, so
 * an option arrives here from the reader that asked rather than from `list` itself, and
 * what it refuses is refused before any request.
 */
export function readListOptions(bucket: string, options: ListOptions | undefined): ListRequest {
  requireKnownOptions(bucket, options, listOptionKeys, "list");

  const prefix = options?.prefix ?? "";

  requireKey(bucket, prefix, "prefix", "list");

  const pageSize = options?.pageSize ?? defaultPageSize;

  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw optionError(bucket, "pageSize", `takes a whole number from 1 to ${maxPageSize}`, "list");
  }

  if (options?.delimiter === "") {
    throw optionError(bucket, "delimiter", "takes at least one character", "list");
  }

  // A cursor is the provider's continuation token and is refused where it is spent: spec
  // 7.9 reads the `InvalidArgument` it answers as `InvalidOption` naming `cursor`.
  return { prefix, delimiter: options?.delimiter, pageSize, cursor: options?.cursor };
}
