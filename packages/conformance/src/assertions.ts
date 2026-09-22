import {
  type CapabilityName,
  isStorageError,
  type ObjectStat,
  type StorageError,
  type StorageErrorCode,
} from "@stowage/core";

import { serializeError } from "./result.ts";

/**
 * What a case asserts with. The suite carries its own rather than the `expect` of a test
 * framework, because `runAll` runs the same cases where there is no framework (ADR 0006).
 */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** The bytes a case wrote, read back, where a failure names the offset and not the body. */
export function assertSameBytes(actual: Uint8Array, expected: Uint8Array, what: string): void {
  assert(
    actual.byteLength === expected.byteLength,
    `${what} is ${actual.byteLength} bytes, and not the ${expected.byteLength} that were written`,
  );

  for (let index = 0; index < expected.byteLength; index += 1) {
    assert(
      actual[index] === expected[index],
      `${what} holds ${actual[index]} at byte ${index}, and not the ${expected[index]} that was written`,
    );
  }
}

/** What two reads of one object are held against each other on, `===` telling them apart. */
export type ComparedStatField = "key" | "size" | "contentType" | "etag";

/**
 * Two descriptions of one object, on the fields the row of spec 8.5 names. Spec 4.4
 * leaves `lastModified` free to differ between a write and a later read by the
 * provider's rounding, so a row names its fields rather than the whole description.
 */
export function assertSameDescription(
  one: ObjectStat,
  other: ObjectStat,
  fields: readonly ComparedStatField[],
  what: string,
): void {
  for (const field of fields) {
    assert(
      one[field] === other[field],
      `${what} report \`${field}\` as ${JSON.stringify(one[field])} and ${JSON.stringify(other[field])}`,
    );
  }
}

export interface StorageErrorExpectation {
  readonly code: StorageErrorCode;
  readonly operation?: string;
  readonly key?: string;
  readonly attempts?: number;
  readonly retryable?: boolean;
}

/**
 * The `StorageError` the call is expected to reject with, handed back so that a case can
 * read it for what its row of spec 8.5 states beyond the fields it named here. A case
 * running the same call over a list of keys names the one it is at in `what`.
 */
export async function expectStorageError(
  call: () => Promise<unknown>,
  expected: StorageErrorExpectation,
  what?: string,
): Promise<StorageError> {
  const subject = what === undefined ? "" : ` for ${what}`;
  const expectation = `Expected a \`StorageError\` with \`code: "${expected.code}"\`${subject}`;
  const thrown = await rejectionOf(call, expectation);

  if (!isStorageError(thrown)) {
    const { name, message } = serializeError(thrown);

    throw new Error(`${expectation}, and the call threw ${name}: ${message}`);
  }

  for (const [field, value] of Object.entries(expected)) {
    const held: unknown = Reflect.get(thrown, field);

    assert(
      held === value,
      `${expectation}, and the error carries \`${field}: ${JSON.stringify(held)}\` rather than ${JSON.stringify(value)}`,
    );
  }

  return thrown;
}

/**
 * Spec 4.3 and 4.5 leave two failures to the runtime — the `AbortError` of a signal and
 * the `SyntaxError` of a body that is no JSON — which a caller branching on a
 * `StorageError` has to be able to tell apart from one.
 */
export async function expectRuntimeError(
  call: () => Promise<unknown>,
  name: string,
): Promise<void> {
  const expectation = `Expected the runtime's \`${name}\``;
  const thrown = await rejectionOf(call, expectation);
  const serialized = serializeError(thrown);

  assert(
    !isStorageError(thrown),
    `${expectation}, and the call rejected with a \`StorageError\`: ${serialized.message}`,
  );
  assert(
    serialized.name === name,
    `${expectation}, and the call threw ${serialized.name}: ${serialized.message}`,
  );
}

/**
 * Spec 4.9 leaves a call needing a capability the storage does not declare with an
 * `Unsupported` error naming it, and spec 8.2 has most of the `runWithout` halves assert
 * that through this.
 */
export async function expectUnsupported(
  call: () => Promise<unknown>,
  capability: CapabilityName,
): Promise<void> {
  const expectation = `Expected \`Unsupported\` naming \`${capability}\``;
  const thrown = await rejectionOf(call, expectation);

  if (!isStorageError(thrown)) {
    const { name, message } = serializeError(thrown);

    throw new Error(`${expectation}, and the call threw ${name}: ${message}`);
  }

  if (thrown.code !== "Unsupported" || thrown.capability !== capability) {
    throw new Error(
      `${expectation}, and the call rejected with \`${thrown.code}\` naming \`${thrown.capability}\``,
    );
  }
}

async function rejectionOf(call: () => Promise<unknown>, expectation: string): Promise<unknown> {
  try {
    await call();
  } catch (thrown) {
    return thrown;
  }

  throw new Error(`${expectation}, and the call resolved`);
}
