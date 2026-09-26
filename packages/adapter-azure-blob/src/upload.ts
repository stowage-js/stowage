import type { ObjectStat, StorageError } from "@stowage/core";

import type { AzureBlobConfiguration } from "./configuration.ts";
import { describeWrite } from "./description.ts";
import { type Part, PartReader } from "./part-reader.ts";
import { send } from "./request.ts";
import { azureBlobError } from "./storage-error.ts";
import type { UserMetadataHeaders } from "./user-metadata.ts";

/** What `put` writes, apart from the body. */
export interface ObjectWrite {
  readonly key: string;
  readonly contentType: string;
  readonly userMetadata: UserMetadataHeaders;
  readonly signal?: AbortSignal;
}

/** Spec 8.6: bytes the adapter holds go as one `Put Blob`, which it never splits. */
export async function putBlob(
  configuration: AzureBlobConfiguration,
  write: ObjectWrite,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<ObjectStat> {
  const response = await send(configuration, {
    method: "PUT",
    operation: "put",
    key: write.key,
    headers: [
      ["content-type", write.contentType],
      ["x-ms-blob-type", "BlockBlob"],
      ...write.userMetadata.headers,
    ],
    body: bytes,
    signal: write.signal,
  });

  await response.body?.cancel();

  return describeWrite(
    configuration.container,
    write.key,
    bytes.byteLength,
    write.contentType,
    write.userMetadata.held,
    response,
  );
}

/**
 * Spec 8.6: a stream is read into parts of `partSize`, and one that ends within the first
 * goes as the `Put Blob` held bytes get.
 */
export async function uploadStream(
  configuration: AzureBlobConfiguration,
  write: ObjectWrite,
  stream: ReadableStream<Uint8Array>,
): Promise<ObjectStat> {
  const parts = new PartReader(stream, configuration.partSize, write.signal);

  try {
    const first = await parts.next();

    if (first.last) return await putBlob(configuration, write, first.bytes);

    return await blockUpload(configuration, write, parts, first);
  } catch (failure) {
    await parts.cancel(failure);

    throw failure;
  } finally {
    parts.release();
  }
}

/** Azure's limit on the committed blocks of one blob, which ADR 0024 leaves no option to lift. */
const maxParts = 50_000;

/**
 * ADR 0024: every id of one blob has one length, so the length of these twenty bytes is
 * fixed for as long as the adapter exists; another would collide with the uncommitted
 * blocks an earlier version left under the name.
 */
const uploadNonceBytes = 16;
const partIndexBytes = 4;

/**
 * Spec 8.6: the blocks staged with `concurrency` in flight and committed with one `Put
 * Block List`. Nothing is sent once a block failed or the caller aborted: nothing aborts a
 * block upload, and the staged blocks are left to the next commit to the name or to the
 * service (ADR 0024).
 */
async function blockUpload(
  configuration: AzureBlobConfiguration,
  write: ObjectWrite,
  parts: PartReader,
  first: Part,
): Promise<ObjectStat> {
  const uploadNonce = crypto.getRandomValues(new Uint8Array(uploadNonceBytes));
  const { blockIds, size } = await stageBlocks(configuration, write, parts, first, uploadNonce);

  return await commitBlocks(configuration, write, blockIds, size);
}

interface StagedBlocks {
  /** In part order, which is the order `Put Block List` commits them in. */
  readonly blockIds: readonly string[];
  readonly size: number;
}

/**
 * Spec 8.6: `concurrency` parts in flight, and the next part read only once one of them
 * settled, so the part buffers never outnumber the parts in flight. The first failure
 * stops the parts still in flight, and is what the upload rejects with once they settled.
 */
async function stageBlocks(
  configuration: AzureBlobConfiguration,
  write: ObjectWrite,
  parts: PartReader,
  first: Part,
  uploadNonce: Uint8Array,
): Promise<StagedBlocks> {
  const stop = new AbortController();
  const partWrite: ObjectWrite = {
    ...write,
    signal: write.signal === undefined ? stop.signal : AbortSignal.any([write.signal, stop.signal]),
  };
  const inFlight = new Set<Promise<void>>();
  const blockIds: string[] = [];
  let failure: { readonly reason: unknown } | undefined;
  let size = 0;

  // The source is canceled along with the parts, because a stream that stalls would
  // otherwise hold the upload at the read of a part that is never sent.
  const fail = (reason: unknown): void => {
    failure ??= { reason };
    stop.abort();
    void parts.cancel(reason);
  };
  const stageBlock = async (blockId: string, part: Part): Promise<void> => {
    try {
      await putBlock(configuration, partWrite, blockId, part);
    } catch (reason) {
      fail(reason);
    } finally {
      parts.recycle(part);
    }
  };

  try {
    for (let index = 0, part = first; !stop.signal.aborted; index += 1) {
      if (index === maxParts - 1 && !part.last) throw tooManyParts(configuration, write);

      const blockId = blockIdOf(uploadNonce, index);
      const staging = stageBlock(blockId, part);

      blockIds.push(blockId);
      inFlight.add(staging);
      void staging.finally(() => inFlight.delete(staging));
      size += part.bytes.byteLength;

      if (part.last) break;

      // oxlint-disable-next-line no-await-in-loop -- a free slot is what lets the next part go
      while (inFlight.size >= configuration.concurrency) await Promise.race(inFlight);

      // oxlint-disable-next-line no-await-in-loop -- the next part is read into the free slot
      part = await parts.next();
    }
  } catch (reason) {
    fail(reason);
  }

  await Promise.all(inFlight);

  if (failure !== undefined) throw failure.reason;

  return { blockIds, size };
}

/** ADR 0024: the upload's nonce and the part index big-endian, as the Base64 of twenty bytes. */
function blockIdOf(uploadNonce: Uint8Array, index: number): string {
  const bytes = new Uint8Array(uploadNonceBytes + partIndexBytes);

  bytes.set(uploadNonce);
  new DataView(bytes.buffer).setUint32(uploadNonceBytes, index);

  return btoa(String.fromCharCode(...bytes));
}

async function putBlock(
  configuration: AzureBlobConfiguration,
  write: ObjectWrite,
  blockId: string,
  part: Part,
): Promise<void> {
  const response = await send(configuration, {
    method: "PUT",
    operation: "put",
    key: write.key,
    query: [
      ["comp", "block"],
      ["blockid", blockId],
    ],
    body: part.bytes,
    signal: write.signal,
  });

  await response.body?.cancel();
}

/**
 * Spec 8.5: repeated like every other request, a lost response included, since a repeat
 * commits the same blocks in the same order. The object's own headers travel here,
 * because a commit without them resets the content type and drops the user metadata.
 */
async function commitBlocks(
  configuration: AzureBlobConfiguration,
  write: ObjectWrite,
  blockIds: readonly string[],
  size: number,
): Promise<ObjectStat> {
  const response = await send(configuration, {
    method: "PUT",
    operation: "put",
    key: write.key,
    query: [["comp", "blocklist"]],
    headers: [["x-ms-blob-content-type", write.contentType], ...write.userMetadata.headers],
    body: utf8.encode(blockListDocument(blockIds)),
    signal: write.signal,
  });

  await response.body?.cancel();

  return describeWrite(
    configuration.container,
    write.key,
    size,
    write.contentType,
    write.userMetadata.held,
    response,
  );
}

const utf8 = new TextEncoder();

/** Base64 holds no character XML escapes, so the ids go in as they are. */
function blockListDocument(blockIds: readonly string[]): string {
  const latest = blockIds.map((blockId) => `<Latest>${blockId}</Latest>`).join("");

  return `<?xml version="1.0" encoding="utf-8"?><BlockList>${latest}</BlockList>`;
}

/**
 * Spec 8.6: known once the last part the provider takes is full and the stream goes on.
 * ADR 0016 fixes the part size before the first part, so the way past it is a larger one.
 */
function tooManyParts(configuration: AzureBlobConfiguration, write: ObjectWrite): StorageError {
  return azureBlobError(configuration.container, {
    code: "InvalidRequest",
    message: `The stream needs more than ${maxParts} parts of the configured \`partSize\` of ${configuration.partSize} bytes; a larger \`multipart.partSize\` carries it`,
    operation: "put",
    key: write.key,
    attempts: 0,
  });
}
