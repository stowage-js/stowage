// PROTOTYPE — variant A, "disk".
//
// The flydrive shape, pushed to its conclusion:
//   - the bucket is bound at construction, and .bucket(name) clones the adapter
//   - a Storage facade wraps the adapter and owns the convenience methods
//   - list() hands out pages: AsyncIterable<ListPage>
//   - per-adapter options are a generic extension map threaded through the adapter type
//   - the operation set is wide: exists, copy, move, deleteMany all earn a place

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

/** One slot per operation that an adapter may widen. Every slot must be filled. */
export interface AdapterExtensions {
  put: object;
  get: object;
  list: object;
  signedUrl: object;
}

export interface NoExtensions extends AdapterExtensions {
  put: {};
  get: {};
  list: {};
  signedUrl: {};
}

export interface StorageAdapter<Ext extends AdapterExtensions = NoExtensions> {
  readonly provider: string;
  /** The bucket this adapter is bound to. For fs it is the root directory. */
  readonly bucket: string;
  readonly capabilities: Capabilities;

  put(key: string, body: PutBody, options?: PutOptions & Ext["put"]): Promise<ObjectStat>;
  get(key: string, options?: GetOptions & Ext["get"]): Promise<ReadableStream<Uint8Array>>;
  stat(key: string): Promise<ObjectStat>;
  exists(key: string): Promise<boolean>;
  list(options?: ListOptions & Ext["list"]): AsyncIterable<ListPage>;
  delete(key: string): Promise<void>;
  deleteMany(keys: readonly string[]): Promise<DeleteReport>;
  deleteAll(prefix: string): Promise<DeleteReport>;
  copy(from: string, to: string): Promise<ObjectStat>;
  move(from: string, to: string): Promise<ObjectStat>;

  /** Clone bound to another bucket. */
  withBucket(bucket: string): StorageAdapter<Ext>;
}

/** Presigning is a capability, not part of the parity core. */
export interface Presigning<Ext extends AdapterExtensions = NoExtensions> {
  presignGet(key: string, options: SignedUrlOptions & Ext["signedUrl"]): Promise<string>;
  presignPut(key: string, options: SignedUrlOptions & Ext["signedUrl"]): Promise<string>;
}

/** The facade the application holds. Every parity-core method is repeated here. */
export declare class Storage<A extends StorageAdapter<any> = StorageAdapter<any>> {
  constructor(adapter: A);
  readonly adapter: A;

  put(
    key: string,
    body: PutBody,
    options?: A extends StorageAdapter<infer E> ? PutOptions & E["put"] : PutOptions,
  ): Promise<ObjectStat>;
  get(key: string, options?: GetOptions): Promise<ReadableStream<Uint8Array>>;
  bytes(key: string, options?: GetOptions): Promise<Uint8Array>;
  text(key: string, options?: GetOptions): Promise<string>;
  json<T>(key: string, options?: GetOptions): Promise<T>;
  stat(key: string): Promise<ObjectStat>;
  exists(key: string): Promise<boolean>;
  list(options?: ListOptions): AsyncIterable<ListPage>;
  delete(key: string): Promise<void>;
  deleteMany(keys: readonly string[]): Promise<DeleteReport>;
  deleteAll(prefix: string): Promise<DeleteReport>;
  copy(from: string, to: string): Promise<ObjectStat>;
  move(from: string, to: string): Promise<ObjectStat>;
}

// ---------- adapters ----------

export interface S3Extensions extends AdapterExtensions {
  put: { storageClass?: "STANDARD" | "STANDARD_IA" | "GLACIER"; acl?: "private" | "public-read" };
  get: {};
  list: {};
  signedUrl: { responseContentDisposition?: string };
}

export interface S3Adapter extends StorageAdapter<S3Extensions>, Presigning<S3Extensions> {
  readonly provider: "s3";
}

export declare function s3(config: {
  bucket: string;
  region: string;
  endpoint?: string;
  credentials: S3Credentials;
}): S3Adapter;

export declare function fs(config: { root: string }): StorageAdapter;
export declare function memory(): StorageAdapter;
