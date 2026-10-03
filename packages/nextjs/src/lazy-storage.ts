import type { Storage } from "@stowage/core";

/**
 * A getter that builds a storage on its first call and keeps it for the module instance it
 * lives in, so that `next build`, which evaluates the application's modules, constructs
 * nothing until a request asks. One call holds one storage; two storages are two calls.
 *
 * @param factory Builds the storage, synchronously: whatever is asynchronous, a token or a
 *   secret, belongs in the adapter's credential resolver. A factory that throws is not
 *   cached, so every call runs it again until it returns.
 */
export function lazyStorage<S extends Storage>(factory: () => S): () => S {
  let storage: S | undefined;

  return () => (storage ??= factory());
}
