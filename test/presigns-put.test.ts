import { expectTypeOf, test } from "vitest";

import type { AzureBlobStorage } from "../packages/adapter-azure-blob/src/index.ts";
import type { FsStorage } from "../packages/adapter-fs/src/index.ts";
import type { GcsSigningStorage, GcsStorage } from "../packages/adapter-gcs/src/index.ts";
import type { MemoryStorage } from "../packages/adapter-memory/src/index.ts";
import type { S3Storage } from "../packages/adapter-s3/src/index.ts";
import { type PresignsPut, presignUpload } from "../packages/http/src/index.ts";

// Spec 10.1: `PresignsPut` names the options every adapter declaring `presignedUrls`
// shares, so each of them is handed to `presignUpload` without a cast. `tsc` checks
// these lines; Vitest only runs the test around them.
test("every storage declaring `presignedUrls` satisfies `PresignsPut`", () => {
  expectTypeOf<S3Storage>().toExtend<PresignsPut>();
  expectTypeOf<AzureBlobStorage>().toExtend<PresignsPut>();
  expectTypeOf<GcsSigningStorage>().toExtend<PresignsPut>();
});

test("a storage without `presignedUrls` fails to compile as `PresignsPut`", () => {
  expectTypeOf<MemoryStorage>().not.toExtend<PresignsPut>();
  expectTypeOf<FsStorage>().not.toExtend<PresignsPut>();
  expectTypeOf<GcsStorage>().not.toExtend<PresignsPut>();
  expectTypeOf(presignFromMemory).toBeFunction();
});

// Never called: what is checked is that the call does not compile.
const presignFromMemory = async (storage: MemoryStorage): Promise<Response> =>
  // @ts-expect-error `MemoryStorage` carries no `presignPut`.
  await presignUpload(storage, "uploads/report.pdf", {
    expiresIn: 60,
    maxSize: 1048576,
    contentType: "application/pdf",
    contentLength: 11,
  });
