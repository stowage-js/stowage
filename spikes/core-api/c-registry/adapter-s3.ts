// PROTOTYPE — variant C, the S3 adapter package: it augments the core registries.

import type { S3Credentials } from "../shared/data.ts";
import type { Presigning, Storage } from "./api.ts";

declare module "./api.ts" {
  interface PutExtensions {
    s3: { storageClass?: "STANDARD" | "STANDARD_IA" | "GLACIER"; acl?: "private" | "public-read" };
  }
  interface SignedUrlExtensions {
    s3: { responseContentDisposition?: string };
  }
}

export type S3Storage = Storage<"s3"> & Presigning<"s3">;

export declare function s3(config: {
  bucket: string;
  region: string;
  endpoint?: string;
  credentials: S3Credentials;
}): S3Storage;
