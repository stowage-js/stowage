import { type CapabilityName, isStorageError } from "@stowage/core";

import { serializeError } from "./result.ts";

/**
 * What a case asserts with. The suite carries its own rather than the `expect` of a test
 * framework, because `runAll` runs the same cases where there is no framework (ADR 0006).
 */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
  const thrown = await rejectionOf(call);

  if (thrown === nothingThrown) throw new Error(`${expectation}, and the call resolved`);

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

const nothingThrown: symbol = Symbol("nothing thrown");

async function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (thrown) {
    return thrown;
  }

  return nothingThrown;
}
