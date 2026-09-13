// PROTOTYPE — variant C, "registry".
//
// The middle shape, pushed to its conclusion:
//   - the bucket is bound at construction, and there is no clone: another bucket is another
//     storage object
//   - no facade: the storage carries the convenience, get() hands back a handle
//   - list() returns one listing object that reads three ways: flat, by page, or a single page
//   - per-adapter options come from a registry that the adapter package augments, keyed by the
//     provider name, so the core interface has no generic parameter at all
//   - the operation set is middling: stat() returns null instead of exists(), delete() is
//     variadic instead of deleteMany()

import type {
  Capabilities,
  DeleteReport,
  GetOptions,
  ListOptions,
  ListPage,
  ObjectStat,
  PutBody,
  PutOptions,
  S3Credentials,
  SignedUrlOptions,
} from "../shared/data.ts";

/** Registries. Adapter packages augment these; the core ships them empty. */
export interface PutExtensions {}
export interface ListExtensions {}
export interface SignedUrlExtensions {}

type Extension<Registry, Provider extends string> = Provider extends keyof Registry
  ? Registry[Provider]
  : {};

export interface StoredObject {
  readonly stat: ObjectStat;
  stream(): ReadableStream<Uint8Array>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
}

/** One listing, three ways to read it. */
export interface ObjectListing extends AsyncIterable<ObjectStat> {
  /** Page by page, cursor handled internally. */
  pages(): AsyncIterable<ListPage>;
  /** Exactly one page, for a request that serves one page. */
  page(): Promise<ListPage>;
}

export interface Storage<Provider extends string = string> {
  readonly provider: Provider;
  readonly bucket: string;
  readonly capabilities: Capabilities;

  put(
    key: string,
    body: PutBody,
    options?: PutOptions & Extension<PutExtensions, Provider>,
  ): Promise<ObjectStat>;
  get(key: string, options?: GetOptions): Promise<StoredObject>;
  /** null instead of a throw, so exists() is not needed. */
  stat(key: string): Promise<ObjectStat | null>;
  list(options?: ListOptions & Extension<ListExtensions, Provider>): ObjectListing;
  delete(...keys: readonly string[]): Promise<DeleteReport>;
  deleteAll(prefix: string): Promise<DeleteReport>;
  copy(from: string, to: string): Promise<ObjectStat>;
  move(from: string, to: string): Promise<ObjectStat>;
}

export interface Presigning<Provider extends string = string> {
  presignGet(
    key: string,
    options: SignedUrlOptions & Extension<SignedUrlExtensions, Provider>,
  ): Promise<string>;
  presignPut(
    key: string,
    options: SignedUrlOptions & Extension<SignedUrlExtensions, Provider>,
  ): Promise<string>;
}

export declare function fs(config: { root: string }): Storage<"fs">;
export declare function memory(): Storage<"memory">;
