// PROTOTYPE — variant D, the shape decided in #11. What @stowage/core would export.
//
//   - the bucket is bound at construction, and there is no clone
//   - no facade: get() hands back a handle that carries the stat from the same response
//   - list() returns one listing, read flat or one page at a time
//   - the core is closed: no generic parameter, no registry, no index signature. Provider
//     options exist only on the concrete adapter type
//   - stat() throws like the rest, and exists() is the question that does not throw
//   - delete() is variadic and always reports
//
// Bucket management is deliberately absent: it is not parity core, and if it comes it comes as
// a separate client per provider.

import type {
  Capabilities,
  DeleteReport,
  GetOptions,
  ListOptions,
  ListPage,
  ObjectStat,
  PutBody,
  PutOptions,
} from "../shared/data.ts";

/** What get() hands back. The stat comes from the same response as the body. */
export interface StoredObject {
  readonly stat: ObjectStat;
  stream(): ReadableStream<Uint8Array>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
}

/** One listing, two ways to read it: every object, or one page with its cursor. */
export interface ObjectListing extends AsyncIterable<ObjectStat> {
  page(): Promise<ListPage>;
}

export interface Storage {
  readonly provider: string;
  readonly bucket: string;
  readonly capabilities: Capabilities;

  put(key: string, body: PutBody, options?: PutOptions): Promise<ObjectStat>;
  get(key: string, options?: GetOptions): Promise<StoredObject>;
  /** Throws when the key is absent. */
  stat(key: string): Promise<ObjectStat>;
  exists(key: string): Promise<boolean>;
  list(options?: ListOptions): ObjectListing;
  delete(...keys: readonly string[]): Promise<DeleteReport>;
  deleteAll(prefix: string): Promise<DeleteReport>;
  copy(from: string, to: string): Promise<ObjectStat>;
  move(from: string, to: string): Promise<ObjectStat>;
}

export declare function fs(config: { root: string }): Storage;
export declare function memory(): Storage;
