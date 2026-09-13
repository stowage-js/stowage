// PROTOTYPE — what each variant refuses to compile. A "@ts-expect-error" that does not fire is
// reported by tsc as an unused directive, so this file is the negative half of the experiment.

import { Storage as DiskStorage, s3 as diskS3, type StorageAdapter } from "./a-disk/api.ts";
import { s3 as clientS3, type StorageClient } from "./b-client/api.ts";
import { s3 as registryS3 } from "./c-registry/adapter-s3.ts";
import type { Storage as RegistryStorage } from "./c-registry/api.ts";

declare const body: Uint8Array;
declare const anyClient: StorageClient;
declare const anyRegistry: RegistryStorage;
declare const credentials: { accessKeyId: string; secretAccessKey: string };

// ---------- A ----------

const diskBound = new DiskStorage(diskS3({ bucket: "b", region: "r", credentials }));

// @ts-expect-error — an option no S3 adapter declares
await diskBound.put("k", body, { storageKlass: "STANDARD" });

// The portable facade type: no. FINDING — `StorageAdapter<any>` makes `A extends
// StorageAdapter<infer E>` infer `any`, so the options parameter degrades to `any` and every
// one of these compiles. The generic extension map buys type safety only as long as the
// concrete adapter type is carried all the way to the call site.
declare const anyDisk: DiskStorage<StorageAdapter<any>>;
await anyDisk.put("k", body, { storageClass: "STANDARD" });
await anyDisk.put("k", body, { storageKlass: 42, whatever: null });

// ---------- B ----------

// @ts-expect-error — the core client knows no provider options
await anyClient.put({ bucket: "b", key: "k" }, body, { storageClass: "STANDARD" });

const s3Client = clientS3({ region: "r", credentials });
// @ts-expect-error — wrong value for a declared provider option
await s3Client.put({ bucket: "b", key: "k" }, body, { storageClass: "DEEP_FREEZE" });

// ---------- C ----------

// @ts-expect-error — the portable type resolves the registry to {}
await anyRegistry.put("k", body, { storageClass: "STANDARD" });

const s3Registry = registryS3({ bucket: "b", region: "r", credentials });
// @ts-expect-error — wrong value for a registry-declared option
await s3Registry.put("k", body, { storageClass: "DEEP_FREEZE" });

// @ts-expect-error — presigning is not on a portable storage
await anyRegistry.presignGet("k", { expiresIn: 60 });
