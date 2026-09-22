import type { Stats } from "node:fs";
import { copyFile, type FileHandle, open, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

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
  type StorageError,
  type StoredObject,
} from "@stowage/core";

import { cancelBody, writeBody } from "./body.ts";
import { contentTypeOf } from "./content-type.ts";
import { createListing } from "./listing.ts";
import { asFailure } from "./errno.ts";
import { requireKey } from "./key.ts";
import {
  findObjectFile,
  type ObjectFile,
  removeObjectFile,
  renameObjectFile,
} from "./object-file.ts";
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
import { temporaryPathIn } from "./temporary.ts";
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

/** Where the file the key names lies, together with what a read of it reports. */
interface FoundObject {
  readonly path: string;
  readonly description: ObjectStat;
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
    return await this.#land(context, path, async (temporary) => {
      const handle = await this.#openTemporary(context, temporary);

      try {
        await writeBody(handle, body, signal);
        signal?.throwIfAborted();

        // The size comes off the handle rather than off the path: it describes the bytes
        // this call wrote, whatever another writer renamed over them in the meantime.
        const written = await handle.stat();

        await handle.close();

        return written;
      } catch (thrown) {
        await handle.close().catch(() => {});

        throw thrown;
      }
    });
  }

  /**
   * Spec 6: the bytes land in a file beside the object and are renamed into place, so a
   * reader sees the object as it was or as it now is and never half of a write. A write
   * that broke takes its file with it, so that no listing names what never became one.
   */
  async #land(
    context: FsAccessContext,
    path: string,
    fill: (temporary: string) => Promise<Stats>,
  ): Promise<ObjectStat> {
    const temporary = temporaryPathIn(dirname(path));

    try {
      const written = await fill(temporary);

      await rename(temporary, path);

      return describe(context.key, written.size, written.mtime);
    } catch (thrown) {
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

    return createStoredObject(context, found.description, {
      path: found.path,
      start: options?.range?.start ?? 0,
      end: lastByteOf(this.#root, options?.range, found.description.size, key),
    });
  }

  async stat(key: string, options?: OperationOptions): Promise<ObjectStat> {
    requireKey(this.#root, key, "addressable", "stat");
    requireKnownOptions(this.#root, options, operationOptionKeys, "stat");

    options?.signal?.throwIfAborted();

    return (await this.#find(await this.#context(key, "stat", "read"))).description;
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

  async delete(...keys: readonly string[]): Promise<DeleteReport> {
    // Spec 4.7 rejects the call for what fails the request as a whole and fills the
    // report for what fails one key. A root that is gone is the first of the two: it is
    // no reason any single key could not be deleted.
    const context = {
      root: this.#root,
      realRoot: await resolveRoot(this.#root, "delete", "write"),
      operation: "delete",
    };
    const failed: StorageError[] = [];

    for (const key of keys) {
      // oxlint-disable-next-line no-await-in-loop -- one tree, one key after another
      const failure = await this.#remove({ ...context, key });

      if (failure !== undefined) failed.push(failure);
    }

    return { requested: keys.length, failed };
  }

  async deleteAll(prefix: string, options?: OperationOptions): Promise<DeleteReport> {
    requireKey(this.#root, prefix, "prefix", "deleteAll");
    requireKnownOptions(this.#root, options, operationOptionKeys, "deleteAll");

    options?.signal?.throwIfAborted();

    // Spec 4.11 has `deleteAll` page on its own, and the walk of the tree below the
    // prefix is what a file system pages through: it names the objects the call covers,
    // and one written after it is one spec 4.11 leaves either way.
    const context = {
      root: this.#root,
      realRoot: await resolveRoot(this.#root, "deleteAll", "write"),
      operation: "deleteAll",
    };
    const entries = await walkObjects(context, prefix);
    const failed: StorageError[] = [];

    for (const entry of entries) {
      options?.signal?.throwIfAborted();

      // Every key goes through the same steps a `delete` of it would: the walk named it
      // a while ago, and what it named may be gone or below a key no caller may address.
      // oxlint-disable-next-line no-await-in-loop -- one tree, one object after another
      const failure = await this.#remove({ ...context, key: entry.key });

      if (failure !== undefined) failed.push(failure);
    }

    return { requested: entries.length, failed };
  }

  async #remove(context: FsAccessContext): Promise<StorageError | undefined> {
    try {
      requireKey(this.#root, context.key, "addressable", context.operation);

      const file = await findObjectFile(context);

      // Spec 4.7: deleting is idempotent, so a key that names nothing this storage holds
      // is one the provider took rather than one it could not delete.
      if (file !== undefined) await removeObjectFile(context, file);

      return undefined;
    } catch (thrown) {
      // Spec 4.7 carries a per-key failure in the report, so that the keys beside it in
      // the same call are deleted rather than held up by it.
      if (isStorageError(thrown)) return thrown;

      throw thrown;
    }
  }

  async copy(from: string, to: string, options?: OperationOptions): Promise<ObjectStat> {
    const ends = await this.#endpoints(from, to, "copy", options);
    const source = await this.#requireFile(ends.from);
    const path = await prepareWrite(ends.to);

    return await this.#land(ends.to, path, async (temporary) => {
      await this.#read(ends.from, source.path, temporary);

      // The bytes of the copy are what the destination holds, whatever another writer
      // renamed over the source in the meantime.
      return await stat(temporary);
    });
  }

  /** Reads the source into the file the copy lands through, and names it in a failure. */
  async #read(context: FsAccessContext, source: string, temporary: string): Promise<void> {
    try {
      await copyFile(source, temporary);
    } catch (thrown) {
      // Spec 4.10 has a failure name the key it concerns, and what a read of the source
      // refuses concerns the source rather than the destination it never reached.
      throw asFailure(thrown, { ...context, access: "read" });
    }
  }

  async move(from: string, to: string, options?: OperationOptions): Promise<ObjectStat> {
    const ends = await this.#endpoints(from, to, "move", options);
    const source = await this.#requireFile(ends.from);
    const path = await prepareWrite(ends.to);

    // The destination has been resolved and its directories created by now, so what a
    // rename still refuses concerns the source it takes the file away from (spec 4.10).
    await renameObjectFile(ends.from, source, path);

    // The rename carries the file as it stands, so the destination is described by what
    // the source held: its bytes and the time they were last written.
    return describe(to, source.stats.size, source.stats.mtime);
  }

  /** Both ends of a `copy` or a `move`, once every rule of spec 4.11 has passed. */
  async #endpoints(
    from: string,
    to: string,
    operation: string,
    options?: OperationOptions,
  ): Promise<{ readonly from: FsAccessContext; readonly to: FsAccessContext }> {
    requireKey(this.#root, from, "addressable", operation);
    requireKey(this.#root, to, "writable", operation);
    requireKnownOptions(this.#root, options, operationOptionKeys, operation);

    options?.signal?.throwIfAborted();

    if (from === to) {
      throw fsError(this.#root, {
        code: "InvalidRequest",
        message: `The key ${JSON.stringify(from)} is both the source and the destination`,
        operation,
        key: from,
        attempts: 0,
      });
    }

    const realRoot = await resolveRoot(this.#root, operation, "write");

    return {
      from: { root: this.#root, realRoot, key: from, operation },
      to: { root: this.#root, realRoot, key: to, operation },
    };
  }

  /** The file the source key names, which `copy` and `move` owe a `NotFound` for. */
  async #requireFile(context: FsAccessContext): Promise<ObjectFile> {
    const file = await findObjectFile(context);

    if (file !== undefined) return file;

    // A key ending in a slash names no file, which the storage answers without asking,
    // and every other one cost the lookup that found nothing (spec 4.10).
    throw absent(context, context.key.endsWith("/") ? 0 : 1);
  }

  /** The file the key names, described as spec 4.4 has a read of one describe it. */
  async #find(context: FsAccessContext): Promise<FoundObject> {
    const path = await resolveObject(context);

    try {
      const described = await stat(path);

      // A key naming a directory is an absent object on a read (spec 6). A file system
      // reports that through more than one `errno`, so what answers here is the file.
      if (!described.isFile()) throw absent(context, 1);

      return { path, description: describe(context.key, described.size, described.mtime) };
    } catch (thrown) {
      throw asFailure(thrown, { ...context, access: "read" });
    }
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

// Spec 6 derives the content type from the key, sets no `etag` and holds no user
// metadata, so a description is the file's size and modification time and nothing else.
function describe(key: string, size: number, lastModified: Date): ObjectStat {
  return { key, size, lastModified, contentType: contentTypeOf(key), userMetadata: noUserMetadata };
}
