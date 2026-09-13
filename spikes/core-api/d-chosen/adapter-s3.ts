// PROTOTYPE — variant D, what @stowage/adapter-s3 would export. The concrete type is where
// provider options and capabilities beyond the parity core live; no augmentation, no generics.

import type { ObjectStat, PutBody, PutOptions, S3Credentials, SignedUrlOptions } from "../shared/data.ts";
import type { Storage } from "./core.ts";

export interface S3PutOptions extends PutOptions {
  storageClass?: "STANDARD" | "STANDARD_IA" | "GLACIER";
  acl?: "private" | "public-read";
}

export interface S3SignedUrlOptions extends SignedUrlOptions {
  responseContentDisposition?: string;
}

export interface S3Storage extends Storage {
  readonly provider: "s3";
  put(key: string, body: PutBody, options?: S3PutOptions): Promise<ObjectStat>;
  presignGet(key: string, options: S3SignedUrlOptions): Promise<string>;
  presignPut(key: string, options: S3SignedUrlOptions): Promise<string>;
}

export declare function s3(config: {
  bucket: string;
  region: string;
  endpoint?: string;
  credentials: S3Credentials;
}): S3Storage;
