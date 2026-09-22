import type {
  CapabilityName,
  DeleteReport,
  ObjectEntry,
  ObjectListing,
  ObjectStat,
  Storage,
  StoredObject,
} from "@stowage/core";

import type { ConformanceCaseSource } from "./case.ts";
import { conformanceCaseSources } from "./cases/index.ts";
import type { ConformanceTarget } from "./target.ts";

export interface StubStorageFields {
  readonly provider?: string;
  readonly bucket?: string;
  /** Plain strings, so that a test can declare what no adapter written in TypeScript can. */
  readonly capabilities?: readonly string[];
  readonly put?: Storage["put"];
  readonly get?: Storage["get"];
  readonly stat?: Storage["stat"];
  readonly list?: Storage["list"];
  readonly copy?: Storage["copy"];
  readonly deleteAll?: (prefix: string) => Promise<DeleteReport>;
}

/**
 * A storage for this package's own tests, carrying the fields a case reads and leaving
 * every operation beyond `deleteAll` to throw. Nothing here is part of the entry point,
 * so the build never reaches it and the tarball never holds it.
 */
export function stubStorage(fields: StubStorageFields = {}): Storage {
  const deleteAll =
    fields.deleteAll ?? (async (): Promise<DeleteReport> => ({ requested: 0, failed: [] }));

  return {
    provider: fields.provider ?? "stub",
    bucket: fields.bucket ?? "stub",
    // oxlint-disable-next-line no-unsafe-type-assertion -- what `capabilities` above is for
    capabilities: (fields.capabilities ?? []) as readonly CapabilityName[],

    put: fields.put ?? unreachable<ObjectStat>("put"),
    get: fields.get ?? unreachable<StoredObject>("get"),
    stat: fields.stat ?? unreachable<ObjectStat>("stat"),
    exists: unreachable<boolean>("exists"),
    list:
      fields.list ??
      ((): ObjectListing => {
        throw new Error("The stub storage has no `list`");
      }),
    delete: unreachable<DeleteReport>("delete"),
    deleteAll,
    copy: fields.copy ?? unreachable<ObjectStat>("copy"),
    move: unreachable<ObjectStat>("move"),
  };
}

/** A listing over entries already in hand, which is as far as a stub of this package goes. */
export function stubListing(entries: readonly ObjectEntry[]): ObjectListing {
  return {
    page: async () => ({ objects: entries, prefixes: [] }),
    async *[Symbol.asyncIterator](): AsyncIterator<ObjectEntry> {
      yield* entries;
    },
  };
}

function unreachable<T>(operation: string): () => Promise<T> {
  return async () => {
    throw new Error(`The stub storage has no \`${operation}\``);
  };
}

export function stubTarget(fields: Partial<ConformanceTarget> = {}): ConformanceTarget {
  return { name: "stub", createStorage: () => stubStorage(), ...fields };
}

export function caseNamed(name: string): ConformanceCaseSource {
  const source = conformanceCaseSources.find((one) => one.name === name);

  if (source === undefined) throw new Error(`The suite holds no case named ${name}`);

  return source;
}

/** A case that asserts nothing, for tests that are about the run and not about a case. */
export function passingCase(name: string): ConformanceCaseSource {
  return { name, requires: [], cost: "fast", run: async () => {} };
}
