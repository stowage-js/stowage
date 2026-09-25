import {
  type CapabilityName,
  isUserMetadataKey,
  type StorageError,
  userMetadataByteLength,
} from "@stowage/core";

import { memoryError } from "./storage-error.ts";

/** Spec 4.3 bounds the set at 2 KB of the header bytes it costs once it is encoded. */
const headerByteLimit = 2048;

const noUserMetadata: Readonly<Record<string, string>> = Object.freeze(Object.create(null));

/**
 * The metadata as it is held: keys folded to lower case, as a header field name is.
 * Rejects before anything is written, in the order of spec 4.3, which reads the refusals
 * off what the storage declares.
 */
export function readUserMetadata(
  userMetadata: Record<string, string> | undefined,
  key: string,
  capabilities: readonly CapabilityName[],
): Readonly<Record<string, string>> {
  const entries = Object.entries(userMetadata ?? {});

  if (entries.length === 0) return noUserMetadata;

  if (!capabilities.includes("userMetadata")) {
    throw unsupported("userMetadata", "This storage holds no user metadata", key);
  }

  const held: Record<string, string> = Object.create(null);

  for (const [name, value] of entries) {
    if (!isUserMetadataKey(name, "token")) {
      throw refusal(`The user metadata key ${JSON.stringify(name)} is no ASCII HTTP token`, key);
    }

    const folded = name.toLowerCase();

    // Folding two keys into one would drop a value the caller handed over, and a write
    // that succeeds while losing what it carried is the failure a caller never sees.
    if (folded in held) {
      throw refusal(`The user metadata key ${JSON.stringify(folded)} is given more than once`, key);
    }

    held[folded] = value;
  }

  const headerBytes = userMetadataByteLength(held);

  if (headerBytes > headerByteLimit) {
    throw refusal(
      `The user metadata is ${headerBytes} encoded header bytes, above the limit of ${headerByteLimit}`,
      key,
    );
  }

  const beyondIdentifiers = entries.find(([name]) => !isUserMetadataKey(name, "identifier"));

  if (beyondIdentifiers !== undefined && !capabilities.includes("userMetadataTokenKeys")) {
    throw unsupported(
      "userMetadataTokenKeys",
      `This storage holds no user metadata key beyond identifiers, such as ${JSON.stringify(beyondIdentifiers[0])}`,
      key,
    );
  }

  return Object.freeze(held);
}

function refusal(message: string, key: string): StorageError {
  return memoryError({ code: "InvalidRequest", message, operation: "put", key, attempts: 0 });
}

function unsupported(capability: CapabilityName, message: string, key: string): StorageError {
  return memoryError({
    code: "Unsupported",
    message,
    operation: "put",
    key,
    attempts: 0,
    capability,
  });
}
