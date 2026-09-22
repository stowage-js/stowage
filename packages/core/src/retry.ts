import { isStorageError, withAttempts } from "./errors.ts";

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
  // One attempt is one request for most callers, and `adapter-s3` sends a second where
  // the provider answered `Expired` (spec 7.3). The error an attempt rejects with says
  // which of the two it was, so what the caller finally reads counts the requests that
  // went out rather than the times this loop ran.
  let requestsSent = 0;

  for (let attemptsMade = 1; ; attemptsMade += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- the failure decides whether to repeat
      return await attempt();
    } catch (failure) {
      requestsSent += costOf(failure);

      if (!isStorageError(failure)) throw failure;
      if (!failure.retryable || attemptsMade >= options.maxAttempts) {
        throw withAttempts(failure, requestsSent);
      }

      // oxlint-disable-next-line no-await-in-loop -- the next attempt waits for this delay
      await waitBefore(attemptsMade, options.signal);
    }
  }
}

// A failure stowage raised before the first request went out cost nothing, and spec 4.10
// has it keep the `attempts: 0` that says so.
function costOf(failure: unknown): number {
  return isStorageError(failure) ? failure.attempts : 1;
}

/** Full jitter (ADR 0013), interrupted by the signal that is the caller's whole budget. */
async function waitBefore(attemptsMade: number, signal: AbortSignal | undefined): Promise<void> {
  const milliseconds = Math.random() * Math.min(maximumDelay, baseDelay * 2 ** attemptsMade);

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
