import { isStorageError, StorageError } from "./errors.ts";

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly signal?: AbortSignal;
}

// ADR 0013 moves both numbers in a minor release and never in a patch; the ceiling on
// `maxAttempts` is what a caller may rely on.
const baseDelay = 100;
const maximumDelay = 5_000;

/**
 * Repeats `attempt` while it rejects with a `StorageError` whose `retryable` is `true`,
 * up to `maxAttempts` times, waiting a random delay between zero and
 * `min(5 s, 100 ms × 2^n)` before attempt `n + 1`. The error it finally rejects with
 * carries the number of attempts made.
 *
 * Spec 4.13 has this be the one definition of the loop of spec 7.5, so that an adapter
 * written outside this repository repeats on the same curve. `adapter-fs` and
 * `adapter-memory` have no request to send again and do not call it.
 */
export async function withRetry<T>(attempt: () => Promise<T>, options: RetryOptions): Promise<T> {
  // What the attempts have cost. One attempt is one request for most callers, and
  // `adapter-s3` sends a second where the provider answered `Expired` (spec 7.3); the
  // error an attempt rejects with says which of the two it was, so what the caller
  // finally reads counts requests sent rather than times this loop ran.
  let spent = 0;

  for (let made = 1; ; made += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- the failure decides whether to repeat
      return await attempt();
    } catch (failure) {
      spent += costOf(failure);

      if (!isStorageError(failure) || !failure.retryable || made >= options.maxAttempts) {
        throw countedAs(failure, spent);
      }

      // oxlint-disable-next-line no-await-in-loop -- the next attempt waits for this delay
      await waitBefore(made, options.signal);
    }
  }
}

// A failure stowage raised before the first request went out cost nothing, and spec 4.10
// has it keep the `attempts: 0` that says so.
function costOf(failure: unknown): number {
  return isStorageError(failure) ? failure.attempts : 1;
}

/**
 * The same failure counting every attempt rather than the one it was raised in. The
 * fields are named one by one, so a field added to `StorageErrorFields` has to be added
 * here too or it is dropped on the way through; the stack travels along, because it
 * points at where the request failed and this is not another place it could have.
 */
function countedAs(failure: unknown, attempts: number): unknown {
  if (!isStorageError(failure) || failure.attempts === attempts) return failure;

  const counted = new StorageError({
    code: failure.code,
    message: failure.message,
    operation: failure.operation,
    bucket: failure.bucket,
    provider: failure.provider,
    attempts,
    key: failure.key,
    status: failure.status,
    providerCode: failure.providerCode,
    requestId: failure.requestId,
    retryable: failure.retryable,
    capability: failure.capability,
    cause: failure.cause,
  });

  counted.stack = failure.stack;

  return counted;
}

/** Full jitter (ADR 0013), interrupted by the signal that is the caller's whole budget. */
async function waitBefore(made: number, signal: AbortSignal | undefined): Promise<void> {
  const milliseconds = Math.random() * Math.min(maximumDelay, baseDelay * 2 ** made);

  await new Promise<void>((resolve, reject) => {
    if (signal === undefined) {
      setTimeout(resolve, milliseconds);

      return;
    }

    signal.throwIfAborted();

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    const aborted = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    signal.addEventListener("abort", aborted, { once: true });
  });
}
