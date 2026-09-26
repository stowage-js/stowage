import type { ListOptions } from "@stowage/core";

import { requireKey } from "./key.ts";
import { listOptionKeys, optionError, requireKnownOptions } from "./options.ts";

// Spec 8.2: a page holds at most 1000 names, which is what `List Blobs` answers.
const defaultPageSize = 1000;
const maxPageSize = 1000;

export interface ListRequest {
  readonly prefix: string;
  readonly delimiter?: string;
  readonly pageSize: number;
  readonly signal?: AbortSignal;
}

/**
 * Everything spec 4.11 has `list` refuse without asking the provider, but the `cursor`,
 * whose form the listing that hands one out settles.
 */
export function readListRequest(container: string, options: ListOptions | undefined): ListRequest {
  requireKnownOptions(container, options, listOptionKeys, "list");

  const prefix = options?.prefix ?? "";

  requireKey(container, prefix, "prefix", "list");

  const pageSize = options?.pageSize ?? defaultPageSize;

  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw optionError(
      container,
      "pageSize",
      `takes a whole number from 1 to ${maxPageSize}`,
      "list",
    );
  }

  if (options?.delimiter === "") {
    throw optionError(container, "delimiter", "takes at least one character", "list");
  }

  return { prefix, delimiter: options?.delimiter, pageSize, signal: options?.signal };
}
