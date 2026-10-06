import { isStorageError, StorageError, type StorageErrorCode } from "./errors.ts";
import { repeatOnBudget, type Settle } from "./retry.ts";
import { isTransientStatus } from "./status.ts";

/** What one attempt sends, built by the adapter under a credential resolved for it. */
export interface PreparedAttempt {
  readonly url: string;
  readonly headers: readonly (readonly [name: string, value: string])[];
  /** Held whole, because a repeat sends it again; a stream is never repeated (ADR 0013). */
  readonly body?: Uint8Array<ArrayBuffer>;
  /** Whether a credential the provider refuses for this attempt may pass once refreshed. */
  readonly refreshable: boolean;
}

/** A refusal as `readFailure` reads it, its body already read to the end. */
export interface RefusedAnswer {
  readonly status: number;
  readonly headers: Headers;
  /** `undefined` for a `HEAD`, and for a body that broke on the way. */
  readonly body: string | undefined;
  /** Whether the attempt went out under a credential refreshed after a refusal. */
  readonly refreshed: boolean;
}

/** What the provider's refusal says, which `sendRequest` raises with the request's context. */
export interface FailureReading {
  readonly code: StorageErrorCode;
  readonly message: string;
  /** The key the failure is told against: the request's, another one, or none for a bucket. */
  readonly key: string | undefined;
  readonly providerCode?: string | undefined;
  readonly requestId?: string | undefined;
  /** The provider refused the credential in a way a refreshed one may pass. */
  readonly refusedCredential?: boolean;
}

/**
 * What a request does after an attempt whose effect may have happened although it failed.
 *
 * - `repeat`: what the budget decides, as for any other failure.
 * - `stop`: an attempt that received no response is not repeated (spec 7.5).
 * - `reportOverNotFound`: repeated, and a `NotFound` of the key after an attempt that
 *   received no response or a `5xx` rejects with that attempt's failure (ADR 0037).
 */
export type UnansweredRule = "repeat" | "stop" | "reportOverNotFound";

export interface RequestToSend {
  readonly provider: string;
  readonly bucket: string;
  readonly operation: string;
  /** The key the request addresses, absent for a request about the bucket itself. */
  readonly key?: string;
  readonly method: string;
  readonly maxAttempts: number;
  readonly signal?: AbortSignal;
  /** Statuses besides `2xx` that answer the request, such as a session's `308` (ADR 0036). */
  readonly answeredBy?: readonly number[];
  readonly unanswered?: UnansweredRule;
  /** Resolves the credential, under `forceRefresh` where asked, and signs one attempt. */
  readonly prepare: (options: { readonly forceRefresh: boolean }) => Promise<PreparedAttempt>;
  readonly readFailure: (answer: RefusedAnswer) => FailureReading;
}

/**
 * One request with all its attempts: the budget and the curve of `withRetry`, one repeat
 * under `forceRefresh` after a refused credential, and the failure raised as a
 * `StorageError` of the request's storage. Resolves with the answer, rejects with the
 * failure, and lets the runtime's `AbortError` travel on (spec 4.10).
 *
 * Not part of the spec: what the adapters in this repository share, free to change in any
 * minor release (ADR 0057). An adapter written elsewhere repeats through `withRetry`.
 */
export async function sendRequest(request: RequestToSend): Promise<Response> {
  return await repeatOnBudget(
    async () => await attempt(request, false),
    { maxAttempts: request.maxAttempts, signal: request.signal },
    settlingBy(request.unanswered ?? "repeat"),
  );
}

/** One attempt, which costs a second request where the provider refused its credential. */
async function attempt(request: RequestToSend, forceRefresh: boolean): Promise<Response> {
  const attempts = forceRefresh ? 2 : 1;
  const prepared = await request.prepare({ forceRefresh }).catch((failure: unknown) => {
    throw toldAgainst(request, failure);
  });
  let response: Response;

  try {
    response = await fetch(prepared.url, {
      method: request.method,
      headers: prepared.headers.map(([name, value]) => [name, value]),
      body: prepared.body,
      signal: request.signal,
    });
  } catch (failure) {
    throw transportFailure(request, failure, attempts);
  }

  if (response.ok || request.answeredBy?.includes(response.status) === true) return response;

  const refreshed = forceRefresh && prepared.refreshable;
  const reading = request.readFailure({
    status: response.status,
    headers: response.headers,
    body: await readBody(request.method, response),
    refreshed,
  });

  if (!forceRefresh && prepared.refreshable && reading.refusedCredential === true) {
    return await attempt(request, true);
  }

  throw new StorageError({
    code: reading.code,
    message: reading.message,
    operation: request.operation,
    bucket: request.bucket,
    provider: request.provider,
    key: reading.key,
    attempts,
    status: response.status,
    providerCode: reading.providerCode,
    requestId: reading.requestId,
    retryable: isTransientStatus(response.status),
  });
}

/**
 * A `HEAD` carries no body, and any other refusal is read to the end, which is also what
 * releases the connection the next attempt needs. A body that broke on the way says
 * nothing the status has not said already.
 */
async function readBody(method: string, response: Response): Promise<string | undefined> {
  if (method === "HEAD") {
    await response.body?.cancel();

    return undefined;
  }

  try {
    return await response.text();
  } catch (failure) {
    if (isAbort(failure)) throw failure;

    return undefined;
  }
}

// Spec 4.10: an aborted signal produces the runtime's `AbortError` and never a
// `StorageError`, so the one failure `fetch` throws that is not a transport failure
// travels on untouched.
function transportFailure(request: RequestToSend, failure: unknown, attempts: number): unknown {
  if (isAbort(failure)) return failure;

  return new StorageError({
    code: "NetworkError",
    message: `The request received no response: ${String(failure)}`,
    operation: request.operation,
    bucket: request.bucket,
    provider: request.provider,
    key: request.key,
    attempts,
    retryable: true,
    cause: failure,
  });
}

/**
 * A credential resolver is written outside the adapter and knows neither bucket nor
 * operation, so the `StorageError` it throws is raised again against the request rather
 * than reaching a caller with the placeholders it was built from (spec 4.10).
 */
function toldAgainst(request: RequestToSend, failure: unknown): unknown {
  if (!isStorageError(failure)) return failure;

  const told = new StorageError({
    code: failure.code,
    message: failure.message,
    operation: request.operation,
    bucket: request.bucket,
    provider: request.provider,
    attempts: failure.attempts,
    key: request.key ?? failure.key,
    status: failure.status,
    providerCode: failure.providerCode,
    requestId: failure.requestId,
    retryable: failure.retryable,
    capability: failure.capability,
    cause: failure.cause,
  });

  told.stack = failure.stack;

  return told;
}

function settlingBy(rule: UnansweredRule): Settle {
  if (rule === "stop") return (failure) => (receivedNoResponse(failure) ? failure : undefined);
  if (rule === "repeat") return () => undefined;

  let doubtful: StorageError | undefined;

  return (failure) => {
    if (doubtful !== undefined && failure.code === "NotFound" && failure.key !== undefined) {
      return doubtful;
    }

    // A resolver's `NetworkError` counts as well although no request went out, which
    // reports a doubt where there was none rather than `NotFound` for an object that may
    // have moved (ADR 0037).
    if (receivedNoResponse(failure) || (failure.status ?? 0) >= 500) doubtful = failure;

    return undefined;
  };
}

function receivedNoResponse(failure: StorageError): boolean {
  return failure.code === "NetworkError" && failure.status === undefined;
}

function isAbort(failure: unknown): boolean {
  return failure instanceof Error && failure.name === "AbortError";
}

/** Where the storage whose `retry` option is read was constructed, which a refusal names. */
export interface ConstructedStorage {
  readonly provider: string;
  readonly bucket: string;
  /** The factory that read the option, such as `s3Storage`. */
  readonly constructedBy: string;
}

const defaultMaxAttempts = 3;

// ADR 0013: callers may lower the budget and never raise it above three.
const maxAttemptsRange = { least: 1, most: 3 };

/**
 * The attempts a request may make under the `retry` option, `retry: false` sending one, or
 * `InvalidOption` naming the option where the value breaks ADR 0013. Not part of the spec,
 * as `sendRequest` is not.
 */
export function readMaxAttempts(retry: unknown, storage: ConstructedStorage): number {
  if (retry === false) return 1;
  if (retry === undefined) return defaultMaxAttempts;

  // Without this, `Object.keys` reads `retry: true` as a group with no key and hands back
  // the default, and `retry: null` throws a `TypeError` where `InvalidOption` is owed.
  if (typeof retry !== "object" || retry === null) {
    throw optionError(storage, "retry", "takes a group of options");
  }

  for (const option of Object.keys(retry)) {
    if (option !== "maxAttempts") {
      throw optionError(storage, option, "is not one this storage takes");
    }
  }

  const { maxAttempts } = retry as { readonly maxAttempts?: unknown };

  if (maxAttempts === undefined) return defaultMaxAttempts;
  if (isInMaxAttemptsRange(maxAttempts)) return maxAttempts;

  throw optionError(
    storage,
    "maxAttempts",
    `takes the integers ${maxAttemptsRange.least} to ${maxAttemptsRange.most}`,
  );
}

function isInMaxAttemptsRange(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= maxAttemptsRange.least &&
    value <= maxAttemptsRange.most
  );
}

// The message names the option and never the value it refused (spec 4.3).
function optionError(
  storage: ConstructedStorage,
  option: string,
  expectation: string,
): StorageError {
  return new StorageError({
    code: "InvalidOption",
    message: `The option \`${option}\` ${expectation}`,
    operation: storage.constructedBy,
    bucket: storage.bucket,
    provider: storage.provider,
    attempts: 0,
  });
}
