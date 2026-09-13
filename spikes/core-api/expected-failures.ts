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

// ---------- D, the decided shape ----------

import { s3 as chosenS3 } from "./d-chosen/adapter-s3.ts";
import type { Storage as ChosenStorage } from "./d-chosen/core.ts";

declare const portable: ChosenStorage;
const chosen = chosenS3({ bucket: "b", region: "r", credentials });

// @ts-expect-error — the portable type knows no provider options
await portable.put("k", body, { storageClass: "STANDARD" });

// @ts-expect-error — and no unknown options either
await portable.put("k", body, { storageKlass: 42 });

// @ts-expect-error — presigning is not on the portable type
await portable.presignGet("k", { expiresIn: 60 });

// @ts-expect-error — wrong value for a declared provider option
await chosen.put("k", body, { storageClass: "DEEP_FREEZE" });

// @ts-expect-error — no clone: another bucket is another storage
chosen.withBucket("other");

// @ts-expect-error — pages() is gone; a listing reads flat or one page at a time
portable.list().pages();

// The parts that must compile: the stat travels with the body, delete is variadic either way.
const object = await portable.get("k", { range: { start: 0, end: 1023 } });
object.stat.contentType;
await portable.delete("a");
await portable.delete("a", "b", "c");
