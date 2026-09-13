// PROTOTYPE — throwaway, not production code. See ../README.md.
//
// Shapes that #11 does NOT ask about live here, so the three variants differ only where the
// ticket has an open question. Errors are a placeholder: #14 owns the hierarchy.

export type PutBody = ReadableStream<Uint8Array> | Uint8Array | Blob | string;

export interface ObjectStat {
  readonly key: string;
  readonly size: number;
  readonly contentType?: string;
  readonly lastModified?: Date;
  readonly etag?: string;
}

export interface ListPage {
  /** Objects at this level. */
  readonly objects: readonly ObjectStat[];
  /** Pseudo-directories one level below the prefix, when a delimiter was given. */
  readonly prefixes: readonly string[];
  /** Hand back to continue the listing. Absent means the listing is complete. */
  readonly cursor?: string;
}

export interface ListOptions {
  prefix?: string;
  delimiter?: string;
  pageSize?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface PutOptions {
  contentType?: string;
  /** Lets an adapter send a single PUT instead of a multipart upload. */
  contentLength?: number;
  signal?: AbortSignal;
}

export interface GetOptions {
  range?: { start: number; end?: number };
  signal?: AbortSignal;
}

export interface SignedUrlOptions {
  expiresIn: number;
  contentType?: string;
  contentLength?: number;
}

export interface DeleteReport {
  readonly deleted: number;
  readonly failed: readonly { readonly key: string; readonly reason: string }[];
}

export interface Capabilities {
  readonly presignedGet: boolean;
  readonly presignedPut: boolean;
  readonly rangeRead: boolean;
  readonly metadata: boolean;
}

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

// #14 owns the real hierarchy; the stub only needs something to catch.
export declare class StorageError extends Error {}
export declare class NotFoundError extends StorageError {}
