import type { CapabilityName } from "./capabilities.ts";
import type { StorageError } from "./errors.ts";

export type PutBody = Uint8Array | string | ReadableStream<Uint8Array>;

export interface OperationOptions {
  signal?: AbortSignal;
}

export interface PutOptions extends OperationOptions {
  contentType?: string;
  userMetadata?: Record<string, string>;
}

/** Both ends inclusive; `end` absent means to the end of the object. */
export interface ByteRange {
  start: number;
  end?: number;
}

export interface GetOptions extends OperationOptions {
  range?: ByteRange;
}

export interface ListOptions extends OperationOptions {
  prefix?: string;
  delimiter?: string;
  pageSize?: number;
  cursor?: string;
}

export interface ObjectEntry {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
  readonly etag?: string;
}

export interface ObjectStat extends ObjectEntry {
  readonly contentType: string;
  readonly userMetadata: Readonly<Record<string, string>>;
}

export interface StoredObject {
  readonly stat: ObjectStat;
  stream(): ReadableStream<Uint8Array>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

export interface ListPage {
  readonly objects: readonly ObjectEntry[];
  readonly prefixes: readonly string[];
  readonly cursor?: string;
}

export interface ObjectListing extends AsyncIterable<ObjectEntry> {
  page(): Promise<ListPage>;
}

export interface DeleteReport {
  readonly requested: number;
  readonly failed: readonly StorageError[];
}

export interface Storage {
  readonly provider: string;
  readonly bucket: string;
  /** Every capability the storage implements, each once, fixed when it was constructed. */
  readonly capabilities: readonly CapabilityName[];

  put(key: string, body: PutBody, options?: PutOptions): Promise<ObjectStat>;
  get(key: string, options?: GetOptions): Promise<StoredObject>;
  stat(key: string, options?: OperationOptions): Promise<ObjectStat>;
  exists(key: string, options?: OperationOptions): Promise<boolean>;
  list(options?: ListOptions): ObjectListing;
  delete(...keys: readonly string[]): Promise<DeleteReport>;
  deleteAll(prefix: string, options?: OperationOptions): Promise<DeleteReport>;
  copy(from: string, to: string, options?: OperationOptions): Promise<ObjectStat>;
  move(from: string, to: string, options?: OperationOptions): Promise<ObjectStat>;
}
