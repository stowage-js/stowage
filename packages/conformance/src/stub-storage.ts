import type {
  CapabilityName,
  DeleteReport,
  ObjectListing,
  ObjectStat,
  Storage,
  StoredObject,
} from "@stowage/core";

export interface StubStorageFields {
  readonly provider?: string;
  readonly bucket?: string;
  /** Plain strings, so that a test can declare what no adapter written in TypeScript can. */
  readonly capabilities?: readonly string[];
  readonly deleteAll?: (prefix: string) => Promise<DeleteReport>;
}

/**
 * A storage for this package's own tests, carrying the fields a case reads and leaving
 * every operation beyond `deleteAll` to throw. It is no part of the entry point, so the
 * build never reaches it and the tarball never holds it.
 */
export function stubStorage(fields: StubStorageFields = {}): Storage {
  const deleteAll =
    fields.deleteAll ?? (async (): Promise<DeleteReport> => ({ requested: 0, failed: [] }));

  return {
    provider: fields.provider ?? "stub",
    bucket: fields.bucket ?? "stub",
    // oxlint-disable-next-line no-unsafe-type-assertion -- what `capabilities` above is for
    capabilities: (fields.capabilities ?? []) as readonly CapabilityName[],

    put: unreachable<ObjectStat>("put"),
    get: unreachable<StoredObject>("get"),
    stat: unreachable<ObjectStat>("stat"),
    exists: unreachable<boolean>("exists"),
    list: (): ObjectListing => {
      throw new Error("The stub storage has no `list`");
    },
    delete: unreachable<DeleteReport>("delete"),
    deleteAll,
    copy: unreachable<ObjectStat>("copy"),
    move: unreachable<ObjectStat>("move"),
  };
}

function unreachable<T>(operation: string): () => Promise<T> {
  return async () => {
    throw new Error(`The stub storage has no \`${operation}\``);
  };
}
