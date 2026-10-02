import {
  type CapabilityName,
  type ObjectStat,
  type PutBody,
  type PutOptions,
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

interface Put {
  readonly key: string;
  readonly body: PutBody;
  readonly options: PutOptions | undefined;
}

/**
 * A storage keeping what `put` stores, reading a stream to its end as an adapter does and
 * stopping at the signal with its reason. A stream that fails rejects `put` with a
 * `NetworkError`, as an adapter that wraps it would, and leaves the key as it was: the
 * layer's own refusal has to win over that error's `503`.
 */
export function holdingStorage(
  fields: {
    /** `e1` where it is left out; `undefined` stands for a storage that hands over none. */
    readonly etag?: string | undefined;
    readonly held?: Record<string, string>;
  } = {},
): Storage & { readonly held: Map<string, Uint8Array>; readonly puts: Put[] } {
  const held = new Map<string, Uint8Array>(
    Object.entries(fields.held ?? {}).map(
      ([key, value]) => [key, new TextEncoder().encode(value)] as const,
    ),
  );
  const puts: Put[] = [];
  const etag = "etag" in fields ? fields.etag : "e1";
  const storage = stubStorage({
    put: async (key, body, options): Promise<ObjectStat> => {
      puts.push({ key, body, options });

      // Spec 10.1: the layer buffers no body, so `put` gets the stream it counts.
      if (!(body instanceof ReadableStream)) throw new Error("The layer handed `put` no stream");

      const chunks: Uint8Array[] = [];

      try {
        await body.pipeTo(new WritableStream({ write: (chunk) => void chunks.push(chunk) }), {
          signal: options?.signal,
        });
      } catch (failure) {
        if (options?.signal?.aborted === true) throw failure;

        throw storageError({
          code: "NetworkError",
          operation: "put",
          retryable: true,
          cause: failure,
        });
      }

      const stored = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
      let offset = 0;

      for (const chunk of chunks) {
        stored.set(chunk, offset);
        offset += chunk.byteLength;
      }

      held.set(key, stored);

      return statOf({
        key,
        size: stored.byteLength,
        etag,
        contentType: options?.contentType ?? "application/octet-stream",
        userMetadata: options?.userMetadata ?? {},
      });
    },
  });

  return Object.assign(storage, { held, puts });
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
