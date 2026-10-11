import type { DeleteOptions } from "./storage.ts";

/** The arguments of `delete` in its form for one key (spec 4.1). */
export type OneKeyWithOptions = readonly [key: string, options: DeleteOptions];

/**
 * Whether `delete` was called in its form for one key: a second argument that is no key
 * (spec 4.1). Not part of the spec, as `sendRequest` is not.
 */
export function isOneKeyWithOptions(
  args: readonly string[] | OneKeyWithOptions,
): args is OneKeyWithOptions {
  return args.length === 2 && typeof args[1] === "object" && args[1] !== null;
}
