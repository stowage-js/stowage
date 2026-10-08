import { type ObjectStat, type SendParts, uploadStream } from "@stowage/core";

import type { AzureBlobConfiguration } from "./configuration.ts";
import type { ContentHeaderFields } from "./content-headers.ts";
import { describeWrite, type WrittenObject } from "./description.ts";
import { send } from "./request.ts";
import type { UserMetadataHeaders } from "./user-metadata.ts";

/** What `put` writes, apart from the body. */
export interface ObjectWrite {
  readonly key: string;
  readonly contentType: string;
  readonly contentHeaders: ContentHeaderFields;
  readonly userMetadata: UserMetadataHeaders;
  readonly signal?: AbortSignal;
}

/** The object `write` holds once `size` bytes of it are stored. */
function writtenObject(write: ObjectWrite, size: number): WrittenObject {
  return {
    key: write.key,
    size,
    contentType: write.contentType,
    ...write.contentHeaders.held,
    userMetadata: write.userMetadata.held,
  };
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
      ...write.contentHeaders.headers,
      ...write.userMetadata.headers,
    ],
    body: bytes,
    signal: write.signal,
  });

  await response.body?.cancel();

  return describeWrite(configuration.container, writtenObject(write, bytes.byteLength), response);
}

/**
 * Spec 8.6: a stream is read into parts of `partSize`, and one that ends within the first
 * goes as the `Put Blob` held bytes get.
 */
export async function putStream(
  configuration: AzureBlobConfiguration,
  write: ObjectWrite,
  stream: ReadableStream<Uint8Array>,
): Promise<ObjectStat> {
  return await uploadStream(
    stream,
    {
      partSize: configuration.partSize,
      concurrency: configuration.concurrency,
      maxParts,
      bucket: configuration.container,
      provider: "azure-blob",
      key: write.key,
      signal: write.signal,
    },
    {
      whole: async (bytes) => await putBlob(configuration, write, bytes),
      multipart: async (sendParts) => await blockUpload(configuration, write, sendParts),
    },
  );
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
  sendParts: SendParts,
): Promise<ObjectStat> {
  const uploadNonce = crypto.getRandomValues(new Uint8Array(uploadNonceBytes));
  const { results: blockIds, size } = await sendParts(async (index, bytes, signal) => {
    const blockId = blockIdOf(uploadNonce, index);

    await putBlock(configuration, { ...write, signal }, blockId, bytes);

    return blockId;
  });

  return await commitBlocks(configuration, write, blockIds, size);
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
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const response = await send(configuration, {
    method: "PUT",
    operation: "put",
    key: write.key,
    query: [
      ["comp", "block"],
      ["blockid", blockId],
    ],
    body: bytes,
    signal: write.signal,
  });

  await response.body?.cancel();
}

/**
 * Spec 8.5: repeated like every other request, a lost response included, since a repeat
 * commits the same blocks in the same order. The object's own headers travel here,
 * because a commit without them resets the content type and clears the content headers
 * and the user metadata.
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
    headers: [
      ["x-ms-blob-content-type", write.contentType],
      ...write.contentHeaders.headers,
      ...write.userMetadata.headers,
    ],
    body: utf8.encode(blockListDocument(blockIds)),
    signal: write.signal,
  });

  await response.body?.cancel();

  return describeWrite(configuration.container, writtenObject(write, size), response);
}

const utf8 = new TextEncoder();

/** Base64 holds no character XML escapes, so the ids go in as they are. */
function blockListDocument(blockIds: readonly string[]): string {
  const latest = blockIds.map((blockId) => `<Latest>${blockId}</Latest>`).join("");

  return `<?xml version="1.0" encoding="utf-8"?><BlockList>${latest}</BlockList>`;
}
