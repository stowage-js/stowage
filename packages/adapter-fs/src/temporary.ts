import { join } from "node:path";

// The name a write in flight carries (spec 6): one of the adapter's own that no key maps
// to, so that a listing passes it over and a run that broke leaves nothing behind that a
// listing names as an object.
const temporaryName = /^\.stowage-[\da-f-]{36}\.tmp$/;

/** Where the bytes of a write land before the rename that puts them under the key. */
export function temporaryPathIn(directory: string): string {
  return join(directory, `.stowage-${crypto.randomUUID()}.tmp`);
}

export function isTemporaryName(name: string): boolean {
  return temporaryName.test(name);
}
