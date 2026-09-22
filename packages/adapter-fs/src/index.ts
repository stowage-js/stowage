import { type FileHandle, open, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import {
  type CapabilityName,
  type DeleteReport,
  type GetOptions,
  isStorageError,
  type ListOptions,
  type ObjectListing,
  type ObjectStat,
  type OperationOptions,
  type PutBody,
  type PutOptions,
  type Storage,
  type StoredObject,
} from "@stowage/core";

import { cancelBody, writeBody } from "./body.ts";
import { contentTypeOf } from "./content-type.ts";
import { createListing } from "./listing.ts";
import { asFailure } from "./errno.ts";
import { requireKey } from "./key.ts";
import {
  adapterOptionKeys,
  getOptionKeys,
  operationOptionKeys,
  optionError,
  putOptionKeys,
  requireKnownOptions,
} from "./options.ts";
import { absent, type FsAccessContext, prepareWrite, resolveObject, resolveRoot } from "./paths.ts";
import { lastByteOf, requireRange } from "./range.ts";
import { fsError } from "./storage-error.ts";
import { createStoredObject } from "./stored-object.ts";
import { walkObjects } from "./walk.ts";

export interface FsAdapterOptions {
  root: string;
}

export interface FsStorage extends Storage {
  readonly provider: "fs";
}

export function fsStorage(options: FsAdapterOptions): FsStorage {
  return new FileSystemStorage(options);
}

// One frozen array behind every storage: the declaration is fixed once the storage is
// constructed, and a caller reaching past the `readonly` type reaches all of them.
const fsCapabilities: readonly CapabilityName[] = Object.freeze(["rangeReads"] as const);

/** Where a file the key names lies, together with what a read of it reports. */
interface FoundObject {
  readonly path: string;
  readonly described: ObjectStat;
}

/** A storage that does not declare `userMetadata` reads back none of it (spec 4.9). */
const noUserMetadata: Readonly<Record<string, string>> = Object.freeze({});

class FileSystemStorage implements FsStorage {
  readonly provider = "fs" as const;
  readonly bucket: string;
  readonly capabilities: readonly CapabilityName[] = fsCapabilities;

  readonly #root: string;

  constructor(options: FsAdapterOptions) {
    this.#root = readRoot(options);
    this.bucket = this.#root;
  }

  async put(key: string, body: PutBody, options?: PutOptions): Promise<ObjectStat> {
    try {
      return await this.#put(key, body, options);
    } catch (failure) {
      // Spec 4.2 leaves the stream at its end or canceled once `put` settled, which for
      // a refusal in front of the write is this cancel and for a failed write the one
      // `pipeTo` already performed.
      await cancelBody(body, failure);

      throw failure;
    }
  }

  async #put(key: string, body: PutBody, options?: PutOptions): Promise<ObjectStat> {
    requireKey(this.#root, key, "writable", "put");
    requireKnownOptions(this.#root, options, putOptionKeys, "put");
    this.#requireContentType(options?.contentType);
    this.#requireNoUserMetadata(options?.userMetadata, key);

    // Spec 4.3: a signal that already fired rejects in front of the write, before a
    // directory has been created for a body that is not going to be stored.
    options?.signal?.throwIfAborted();

    const context = await this.#context(key, "put", "write");
    const path = await prepareWrite(context);

    return await this.#write(context, path, body, options?.signal);
  }

  async #write(
    context: FsAccessContext,
    path: string,
    body: PutBody,
    signal?: AbortSignal,
  ): Promise<ObjectStat> {
    // Spec 6: the bytes land in a file beside the object and are renamed into place, so
    // a reader sees the object as it was or as it now is and never half of a write. The
    // name is one no key maps to, so a run that broke leaves nothing a listing names.
    const temporary = join(dirname(path), `.stowage-${crypto.randomUUID()}.tmp`);
    const handle = await this.#openTemporary(context, temporary);

    try {
      await writeBody(handle, body, signal);

      // The size comes off the handle rather than off the path: it describes the bytes
      // this call wrote, whatever another writer renamed over them in the meantime.
      const written = await handle.stat();

      await handle.close();
      await rename(temporary, path);

      return {
        key: context.key,
        size: written.size,
        lastModified: written.mtime,
        contentType: contentTypeOf(context.key),
        userMetadata: noUserMetadata,
      };
    } catch (thrown) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});

      throw asFailure(thrown, { ...context, access: "write" });
    }
  }

  async get(key: string, options?: GetOptions): Promise<StoredObject> {
    requireKey(this.#root, key, "addressable", "get");
    requireKnownOptions(this.#root, options, getOptionKeys, "get");
    requireRange(this.#root, options?.range);

    options?.signal?.throwIfAborted();

    const context = await this.#context(key, "get", "read");
    const found = await this.#find(context);

    return createStoredObject(context, found.described, {
      path: found.path,
      start: options?.range?.start ?? 0,
      end: lastByteOf(this.#root, options?.range, found.described.size, key),
    });
  }

  async stat(key: string, options?: OperationOptions): Promise<ObjectStat> {
    requireKey(this.#root, key, "addressable", "stat");
    requireKnownOptions(this.#root, options, operationOptionKeys, "stat");

    options?.signal?.throwIfAborted();

    return (await this.#find(await this.#context(key, "stat", "read"))).described;
  }

  async exists(key: string, options?: OperationOptions): Promise<boolean> {
    requireKey(this.#root, key, "addressable", "exists");
    requireKnownOptions(this.#root, options, operationOptionKeys, "exists");

    options?.signal?.throwIfAborted();

    // The root is resolved in front of the lookup: a root that is gone is `NotFound` for
    // every operation (spec 6), and answering `false` for it would hide that.
    const context = await this.#context(key, "exists", "read");

    try {
      await this.#find(context);

      return true;
    } catch (thrown) {
      // Spec 4.10: `exists` answers `false` for an absent object alone and carries every
      // other failure to the caller.
      if (isStorageError(thrown) && thrown.code === "NotFound") return false;

      throw thrown;
    }
  }

  list(options?: ListOptions): ObjectListing {
    // Spec 4.6 has a listing perform nothing until it is iterated or asked for a page,
    // so the root is resolved inside the walk rather than here.
    return createListing(
      this.#root,
      async (prefix) =>
        await walkObjects(
          {
            root: this.#root,
            realRoot: await resolveRoot(this.#root, "list", "read"),
            operation: "list",
          },
          prefix,
        ),
      options,
    );
  }

  // What the parity core of spec 4.11 still owes is the step that removes an object
  // together with the directories it leaves empty, up to the root (spec 6).
  async delete(...keys: readonly string[]): Promise<DeleteReport> {
    void keys;

    throw notBuiltYet("delete");
  }

  async deleteAll(prefix: string, options?: OperationOptions): Promise<DeleteReport> {
    void prefix;
    void options;

    throw notBuiltYet("deleteAll");
  }

  async copy(from: string, to: string, options?: OperationOptions): Promise<ObjectStat> {
    void from;
    void to;
    void options;

    throw notBuiltYet("copy");
  }

  async move(from: string, to: string, options?: OperationOptions): Promise<ObjectStat> {
    void from;
    void to;
    void options;

    throw notBuiltYet("move");
  }

  /** The file the key names, described as spec 4.4 has a read of one describe it. */
  async #find(context: FsAccessContext): Promise<FoundObject> {
    const path = await resolveObject(context);

    try {
      const described = await stat(path);

      // A key naming a directory is an absent object on a read (spec 6). A file system
      // reports that through more than one `errno`, so what answers here is the file.
      if (!described.isFile()) throw absent(context, 1);

      return {
        path,
        described: this.#describe(context.key, described.size, described.mtime),
      };
    } catch (thrown) {
      throw asFailure(thrown, { ...context, access: "read" });
    }
  }

  // Spec 6 derives the content type from the key, sets no `etag` and holds no user
  // metadata, so a description is the file's size and modification time and nothing else.
  #describe(key: string, size: number, lastModified: Date): ObjectStat {
    return {
      key,
      size,
      lastModified,
      contentType: contentTypeOf(key),
      userMetadata: noUserMetadata,
    };
  }

  async #context(
    key: string,
    operation: string,
    access: "read" | "write",
  ): Promise<FsAccessContext> {
    return {
      root: this.#root,
      realRoot: await resolveRoot(this.#root, operation, access),
      key,
      operation,
    };
  }

  async #openTemporary(context: FsAccessContext, path: string): Promise<FileHandle> {
    try {
      return await open(path, "wx");
    } catch (thrown) {
      throw asFailure(thrown, { ...context, access: "write" });
    }
  }

  /** Spec 6 validates the type `put` was given and derives the stored one from the key. */
  #requireContentType(contentType: unknown): void {
    if (contentType === undefined || typeof contentType === "string") return;

    throw optionError(this.#root, "contentType", "takes a string", "put");
  }

  #requireNoUserMetadata(userMetadata: Record<string, string> | undefined, key: string): void {
    if (userMetadata === undefined || Object.keys(userMetadata).length === 0) return;

    throw fsError(this.#root, {
      code: "Unsupported",
      message: "This storage holds no user metadata",
      operation: "put",
      key,
      attempts: 0,
      capability: "userMetadata",
    });
  }
}

function readRoot(options: FsAdapterOptions): string {
  // A storage may be constructed from JavaScript, where the declared type of an option
  // promises nothing about what arrives (spec 4.3).
  const root: unknown = options.root;
  const named = typeof root === "string" ? root : "";

  requireKnownOptions(named, options, adapterOptionKeys, "fsStorage");

  if (typeof root !== "string" || !isAbsolute(root)) {
    throw optionError(named, "root", "takes an absolute path to a directory", "fsStorage");
  }

  return root;
}

function notBuiltYet(operation: string): Error {
  return new Error(`\`${operation}\` is not implemented in @stowage/adapter-fs yet`);
}
