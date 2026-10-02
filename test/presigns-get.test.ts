import { expectTypeOf, test } from "vitest";

import type { AzureBlobStorage } from "../packages/adapter-azure-blob/src/index.ts";
import type { FsStorage } from "../packages/adapter-fs/src/index.ts";
import type { GcsSigningStorage, GcsStorage } from "../packages/adapter-gcs/src/index.ts";
import type { MemoryStorage } from "../packages/adapter-memory/src/index.ts";
import type { S3Storage } from "../packages/adapter-s3/src/index.ts";
import { type PresignsGet, redirectToObject } from "../packages/http/src/index.ts";

// Spec 10.1: `PresignsGet` names the options every adapter declaring `presignedUrls`
// shares, so each of them is handed to `redirectToObject` without a cast. `tsc` checks
// these lines; Vitest only runs the test around them.
test("every storage declaring `presignedUrls` satisfies `PresignsGet`", () => {
  expectTypeOf<S3Storage>().toExtend<PresignsGet>();
  expectTypeOf<AzureBlobStorage>().toExtend<PresignsGet>();
  expectTypeOf<GcsSigningStorage>().toExtend<PresignsGet>();
});

test("a storage without `presignedUrls` fails to compile as `PresignsGet`", () => {
  expectTypeOf<MemoryStorage>().not.toExtend<PresignsGet>();
  expectTypeOf<FsStorage>().not.toExtend<PresignsGet>();
  expectTypeOf<GcsStorage>().not.toExtend<PresignsGet>();
  expectTypeOf(redirectFromMemory).toBeFunction();
});

// Never called: what is checked is that the call does not compile.
const redirectFromMemory = async (storage: MemoryStorage, request: Request): Promise<Response> =>
  // @ts-expect-error `MemoryStorage` carries no `presignGet`.
  await redirectToObject(storage, "docs/report.pdf", request, { expiresIn: 60 });
