import {
  type CapabilityName,
  type ObjectStat,
  type Storage,
  StorageError,
  type StorageErrorFields,
  type StoredObject,
} from "@stowage/core";

/**
 * A storage for this package's own tests, answering `get`, `stat` and `put` as a test says
 * and leaving every other operation to throw. Nothing here is part of the entry point, so the
 * build never reaches it and the tarball never holds it.
 */
export function stubStorage(
  fields: {
    readonly capabilities?: readonly CapabilityName[];
    readonly get?: Storage["get"];
    readonly stat?: Storage["stat"];
    readonly put?: Storage["put"];
  } = {},
): Storage {
  return {
    provider: "stub",
    bucket: "stub",
    capabilities: fields.capabilities ?? [],
    get: fields.get ?? unreachable("get"),
    stat: fields.stat ?? unreachable("stat"),
    put: fields.put ?? unreachable("put"),
    exists: unreachable("exists"),
    list: () => {
      throw new Error("The stub storage has no `list`");
    },
    delete: unreachable("delete"),
    deleteAll: unreachable("deleteAll"),
    copy: unreachable("copy"),
    move: unreachable("move"),
  };
}

function unreachable(operation: string): () => Promise<never> {
  return async () => {
    throw new Error(`The stub storage has no \`${operation}\``);
  };
}

export function statOf(fields: Partial<ObjectStat> = {}): ObjectStat {
  return {
    key: "docs/report.pdf",
    size: 4,
    lastModified: new Date("2026-09-01T10:20:30.456Z"),
    etag: "0123abcd",
    contentType: "application/pdf",
    userMetadata: {},
    ...fields,
  };
}

/** A stored object whose stream is the one `body` names, so that a test can tell it apart. */
export function storedObject(
  stat: ObjectStat,
  body: ReadableStream<Uint8Array> = streamOf("body"),
): StoredObject {
  return {
    stat,
    stream: () => body,
    bytes: unread,
    text: unread,
    json: unread,
  };
}

async function unread(): Promise<never> {
  throw new Error("The layer reads the stream of `get` and nothing else");
}

export function streamOf(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body ?? new ReadableStream();
}

export function storageError(
  fields: Partial<StorageErrorFields> & Pick<StorageErrorFields, "code">,
): StorageError {
  return new StorageError({
    message: "The provider names its bucket here",
    operation: "get",
    bucket: "stub",
    provider: "stub",
    attempts: 1,
    ...fields,
  });
}
