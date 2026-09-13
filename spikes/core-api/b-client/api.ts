// PROTOTYPE — variant B, "client".
//
// The bare shape, pushed to its conclusion:
//   - one client per provider account, the bucket travels with every call
//   - no facade: get() returns a handle that carries stat and the convenience methods
//   - list() is flat (AsyncIterable<ObjectStat>), listPage() is the paged call
//   - the core interface stays closed; per-adapter options live on the concrete client type
//   - the operation set is narrow: exists, move and deleteMany are the caller's to write

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

/** Bucket and key together, because neither is bound to the client. */
export interface ObjectLocation {
  bucket: string;
  key: string;
}

/** What get() hands back: the stat comes from the same response as the body. */
export interface StoredObject {
  readonly stat: ObjectStat;
  stream(): ReadableStream<Uint8Array>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
}

export interface StorageClient {
  readonly provider: string;
  readonly capabilities: Capabilities;

  put(at: ObjectLocation, body: PutBody, options?: PutOptions): Promise<ObjectStat>;
  get(at: ObjectLocation, options?: GetOptions): Promise<StoredObject>;
  stat(at: ObjectLocation): Promise<ObjectStat>;
  /** Walks every page itself. */
  list(bucket: string, options?: ListOptions): AsyncIterable<ObjectStat>;
  /** One page, one call, cursor in and cursor out. */
  listPage(bucket: string, options?: ListOptions): Promise<ListPage>;
  delete(at: ObjectLocation): Promise<void>;
  deleteAll(bucket: string, prefix: string): Promise<DeleteReport>;
  copy(from: ObjectLocation, to: ObjectLocation): Promise<ObjectStat>;
}

// ---------- adapters ----------

export interface S3PutOptions extends PutOptions {
  storageClass?: "STANDARD" | "STANDARD_IA" | "GLACIER";
  acl?: "private" | "public-read";
}

/** Provider options are visible only through the concrete client type. */
export interface S3Client extends StorageClient {
  readonly provider: "s3";
  put(at: ObjectLocation, body: PutBody, options?: S3PutOptions): Promise<ObjectStat>;
  presignGet(
    at: ObjectLocation,
    options: SignedUrlOptions & { responseContentDisposition?: string },
  ): Promise<string>;
  presignPut(at: ObjectLocation, options: SignedUrlOptions): Promise<string>;
}

export declare function s3(config: {
  region: string;
  endpoint?: string;
  credentials: S3Credentials;
}): S3Client;

/** For fs, "bucket" is a directory below the root. */
export declare function fs(config: { root: string }): StorageClient;
export declare function memory(): StorageClient;
