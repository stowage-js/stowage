import { afterEach, expect, test, vi } from "vitest";

import { StorageError, type StorageErrorFields } from "./errors.ts";
import { withRetry } from "./retry.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function failure(fields: Partial<StorageErrorFields> = {}): StorageError {
  return new StorageError({
    code: "ProviderError",
    message: "The provider is under load",
    operation: "get",
    bucket: "stowage",
    provider: "s3",
    attempts: 1,
    retryable: true,
    ...fields,
  });
}

/** The delay of every wait, with the timer itself fired at once so the loop runs on. */
function recordedDelays(): number[] {
  const delays: number[] = [];
  const fire = globalThis.setTimeout;

  vi.stubGlobal("setTimeout", (handler: () => void, milliseconds?: number): unknown => {
    delays.push(milliseconds ?? 0);

    return fire(handler, 0);
  });

  return delays;
}

async function rejection(act: () => Promise<unknown>): Promise<StorageError> {
  try {
    await act();
  } catch (thrown) {
    if (thrown instanceof StorageError) return thrown;

    throw thrown;
  }

  throw new Error("The call resolved");
}

test("an attempt that succeeds is performed once", async () => {
  const attempt = vi.fn<() => Promise<string>>(async () => await Promise.resolve("stored"));

  expect(await withRetry(attempt, { maxAttempts: 3 })).toBe("stored");
  expect(attempt).toHaveBeenCalledOnce();
});

test("a transient failure is repeated up to `maxAttempts` and counts every attempt", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const attempt = vi.fn<() => Promise<never>>(async () => await Promise.reject(failure()));

  const thrown = await rejection(async () => await withRetry(attempt, { maxAttempts: 3 }));

  expect(thrown.attempts).toBe(3);
  expect(thrown.code).toBe("ProviderError");
  expect(attempt).toHaveBeenCalledTimes(3);
});

test("an attempt that succeeds after a transient failure answers it", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const answers: (() => Promise<string>)[] = [
    async () => await Promise.reject(failure()),
    async () => await Promise.resolve("stored"),
  ];
  const attempt = vi.fn<() => Promise<string>>(
    async () => await (answers.shift() ?? (async () => "stored"))(),
  );

  expect(await withRetry(attempt, { maxAttempts: 3 })).toBe("stored");
});

test("a condition that will not pass is not repeated", async () => {
  const attempt = vi.fn<() => Promise<never>>(
    async () => await Promise.reject(failure({ retryable: false })),
  );

  const thrown = await rejection(async () => await withRetry(attempt, { maxAttempts: 3 }));

  expect(thrown.attempts).toBe(1);
  expect(attempt).toHaveBeenCalledOnce();
});

test("`maxAttempts: 1` sends the one attempt", async () => {
  const attempt = vi.fn<() => Promise<never>>(async () => await Promise.reject(failure()));

  const thrown = await rejection(async () => await withRetry(attempt, { maxAttempts: 1 }));

  expect(thrown.attempts).toBe(1);
  expect(attempt).toHaveBeenCalledOnce();
});

// Spec 4.10: an aborted signal produces the runtime's own error, which carries no
// `retryable` to read and is none of this loop's business.
test("a failure that is no `StorageError` travels on untouched", async () => {
  const thrown = new TypeError("fetch failed");

  await expect(
    withRetry(async () => await Promise.reject(thrown), { maxAttempts: 3 }),
  ).rejects.toBe(thrown);
});

/**
 * Spec 7.3 has `adapter-s3` repeat an `Expired` answer once inside a single attempt, so
 * an attempt costs one request or two and the caller reads the requests that went out.
 */
test("an attempt that cost more than one request is counted as it reports", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const attempt = vi.fn<() => Promise<never>>(
    async () => await Promise.reject(failure({ attempts: 2 })),
  );

  const thrown = await rejection(async () => await withRetry(attempt, { maxAttempts: 3 }));

  expect(thrown.attempts).toBe(6);
});

test("the wait before attempt `n + 1` is a random share of `min(5 s, 100 ms × 2^n)`", async () => {
  vi.spyOn(Math, "random").mockReturnValue(1);
  const delays = recordedDelays();

  await rejection(
    async () => await withRetry(async () => await Promise.reject(failure()), { maxAttempts: 8 }),
  );

  expect(delays).toEqual([200, 400, 800, 1600, 3200, 5000, 5000]);
});

test("full jitter draws the whole delay from zero upwards", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.25);
  const delays = recordedDelays();

  await rejection(
    async () => await withRetry(async () => await Promise.reject(failure()), { maxAttempts: 3 }),
  );

  expect(delays).toEqual([50, 100]);
});

test("an abort interrupts the wait between two attempts", async () => {
  const controller = new AbortController();
  const attempt = vi.fn<() => Promise<never>>(async () => {
    controller.abort();

    return await Promise.reject(failure());
  });

  await expect(withRetry(attempt, { maxAttempts: 3, signal: controller.signal })).rejects.toThrow(
    expect.objectContaining({ name: "AbortError" }),
  );
  expect(attempt).toHaveBeenCalledOnce();
});
