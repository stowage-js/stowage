import { afterEach, expect, test, vi } from "vitest";

import { isStorageError, StorageError, type StorageErrorFields } from "./errors.ts";
import {
  type FailureReading,
  readMaxAttempts,
  type RefusedAnswer,
  type RequestToSend,
  sendRequest,
} from "./send-request.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: BodyInit | null | undefined;
  readonly signal: AbortSignal | null | undefined;
}

/** What `fetch` was called with, in order, while it answered `answer`. */
function stubFetch(answer: (request: SentRequest, index: number) => Response): SentRequest[] {
  const sent: SentRequest[] = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    const sentRequest: SentRequest = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body,
      signal: init.signal,
    };

    sent.push(sentRequest);

    return await Promise.resolve(answer(sentRequest, sent.length - 1));
  });

  return sent;
}

/** Every wait between attempts lasts no time at all. */
function withoutDelays(): void {
  vi.spyOn(Math, "random").mockReturnValue(0);
}

/** A refusal whose body names the provider's `code`, which `readFailure` below reads. */
function refused(status: number, code = "Refused", headers: Record<string, string> = {}): Response {
  return new Response(`code=${code}`, { status, headers: { "x-request-id": "abc", ...headers } });
}

/** A refusal whose body breaks with `failure` while it is read. */
function refusedWithBrokenBody(status: number, failure: unknown): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(failure);
      },
    }),
    { status },
  );
}

/** What a provider reads out of the body above: the code after `code=`. */
function readFailure(answer: RefusedAnswer): FailureReading {
  const providerCode = answer.body?.replace(/^code=/u, "");

  return {
    code: providerCode === "NoSuchKey" ? "NotFound" : "ProviderError",
    message: `The provider answered ${answer.status}`,
    key: providerCode === "NoSuchBucket" ? undefined : "object.txt",
    providerCode,
    requestId: answer.headers.get("x-request-id") ?? undefined,
    refusedCredential: providerCode === "Expired",
  };
}

function request(overrides: Partial<RequestToSend> = {}): RequestToSend {
  return {
    provider: "s3",
    bucket: "stowage",
    operation: "get",
    key: "object.txt",
    method: "GET",
    maxAttempts: 3,
    prepare: async ({ forceRefresh }) =>
      await Promise.resolve({
        url: "https://provider.invalid/stowage/object.txt",
        headers: [["authorization", forceRefresh ? "refreshed" : "resolved"]],
        refreshable: true,
      }),
    readFailure,
    ...overrides,
  };
}

async function rejection(act: () => Promise<unknown>): Promise<StorageError> {
  try {
    await act();
  } catch (thrown) {
    if (isStorageError(thrown)) return thrown;

    throw thrown;
  }

  throw new Error("The call resolved");
}

test("an answer that succeeds resolves with the response of one request", async () => {
  const body = new Uint8Array([1, 2, 3]);
  const signal = new AbortController().signal;
  const sent = stubFetch(() => new Response("stored"));
  const response = await sendRequest(
    request({
      method: "PUT",
      signal,
      prepare: async () =>
        await Promise.resolve({
          url: "https://provider.invalid/stowage/object.txt",
          headers: [["x-signed", "yes"]],
          body,
          refreshable: true,
        }),
    }),
  );

  expect(await response.text()).toBe("stored");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.url).toBe("https://provider.invalid/stowage/object.txt");
  expect(sent[0]?.method).toBe("PUT");
  expect(sent[0]?.headers.get("x-signed")).toBe("yes");
  expect(sent[0]?.body).toBe(body);
  expect(sent[0]?.signal).toBe(signal);
});

// ADR 0036: a resumable session answers a chunk it persisted with `308`.
test("a status the request names as an answer resolves like a success", async () => {
  stubFetch(() => new Response(null, { status: 308, headers: { range: "bytes=0-9" } }));

  const response = await sendRequest(request({ answeredBy: [308] }));

  expect(response.status).toBe(308);
});

test("a refusal is told by what `readFailure` read of it, and by the request", async () => {
  const answers: RefusedAnswer[] = [];

  stubFetch(() => refused(404, "NoSuchKey", { "x-other": "seen" }));

  const failure = await rejection(
    async () =>
      await sendRequest(
        request({
          readFailure: (answer) => {
            answers.push(answer);

            return readFailure(answer);
          },
        }),
      ),
  );

  expect(answers).toHaveLength(1);
  expect(answers[0]?.status).toBe(404);
  expect(answers[0]?.headers.get("x-other")).toBe("seen");
  expect(answers[0]?.body).toBe("code=NoSuchKey");
  expect(answers[0]?.refreshed).toBe(false);
  expect(failure).toMatchObject({
    code: "NotFound",
    message: "The provider answered 404",
    operation: "get",
    bucket: "stowage",
    provider: "s3",
    attempts: 1,
    retryable: false,
    key: "object.txt",
    status: 404,
    providerCode: "NoSuchKey",
    requestId: "abc",
  } satisfies Partial<StorageErrorFields>);
});

// ADR 0043: a missing bucket is the `NotFound` that names no key.
test("a refusal told against no key names none", async () => {
  stubFetch(() => refused(404, "NoSuchBucket"));

  const failure = await rejection(async () => await sendRequest(request()));

  expect(failure.key).toBeUndefined();
});

test("the body of a refused `HEAD` is not read", async () => {
  const answers: RefusedAnswer[] = [];

  stubFetch(() => refused(403));

  await rejection(
    async () =>
      await sendRequest(
        request({
          method: "HEAD",
          readFailure: (answer) => {
            answers.push(answer);

            return readFailure(answer);
          },
        }),
      ),
  );

  expect(answers[0]?.body).toBeUndefined();
});

test("a refusal whose body breaks leaves the body unread and the status to decide", async () => {
  stubFetch(() => refusedWithBrokenBody(403, new TypeError("terminated")));

  const failure = await rejection(async () => await sendRequest(request()));

  expect(failure.code).toBe("ProviderError");
  expect(failure.providerCode).toBeUndefined();
  expect(failure.status).toBe(403);
});

// Spec 4.10: an abort produces the runtime's `AbortError` and never a `StorageError`, also
// where it lands while the body of a refusal is read (#356).
test("an AbortError while reading a refusal travels on", async () => {
  const aborted = new DOMException("Aborted", "AbortError");
  const sent = stubFetch(() => refusedWithBrokenBody(409, aborted));

  await expect(sendRequest(request())).rejects.toBe(aborted);
  expect(sent).toHaveLength(1);
});

test("an AbortError from `fetch` travels on and is not repeated", async () => {
  const aborted = new DOMException("Aborted", "AbortError");
  let calls = 0;

  vi.stubGlobal("fetch", async (): Promise<Response> => {
    calls += 1;

    return await Promise.reject(aborted);
  });

  await expect(sendRequest(request())).rejects.toBe(aborted);
  expect(calls).toBe(1);
});

test("a request that receives no response is a `NetworkError`, repeated on the budget", async () => {
  withoutDelays();
  const broken = new TypeError("fetch failed");
  let calls = 0;

  vi.stubGlobal("fetch", async (): Promise<Response> => {
    calls += 1;

    return await Promise.reject(broken);
  });

  const failure = await rejection(async () => await sendRequest(request()));

  expect(calls).toBe(3);
  expect(failure.code).toBe("NetworkError");
  expect(failure.message).toBe("The request received no response: TypeError: fetch failed");
  expect(failure.retryable).toBe(true);
  expect(failure.attempts).toBe(3);
  expect(failure.status).toBeUndefined();
  expect(failure.key).toBe("object.txt");
  expect(failure.cause).toBe(broken);
});

test("a transient status is repeated up to `maxAttempts`, and another status is not", async () => {
  withoutDelays();
  const transient = stubFetch(() => refused(503));
  const repeated = await rejection(async () => await sendRequest(request({ maxAttempts: 2 })));

  expect(transient).toHaveLength(2);
  expect(repeated.attempts).toBe(2);
  expect(repeated.retryable).toBe(true);

  const final = stubFetch(() => refused(403));
  const once = await rejection(async () => await sendRequest(request()));

  expect(final).toHaveLength(1);
  expect(once.attempts).toBe(1);
  expect(once.retryable).toBe(false);
});

test("a repeat that succeeds resolves", async () => {
  withoutDelays();
  const sent = stubFetch((_, index) => (index === 0 ? refused(500) : new Response("stored")));

  expect(await (await sendRequest(request())).text()).toBe("stored");
  expect(sent).toHaveLength(2);
});

// ADR 0013: a refused credential is resolved again under `forceRefresh` and sent at once,
// on a budget of its own.
test("a refused credential is refreshed once, without a delay", async () => {
  const delay = vi.spyOn(globalThis, "setTimeout");
  const sent = stubFetch((_, index) =>
    index === 0 ? refused(400, "Expired") : new Response("stored"),
  );

  expect(await (await sendRequest(request())).text()).toBe("stored");
  expect(sent.map((one) => one.headers.get("authorization"))).toEqual(["resolved", "refreshed"]);
  expect(delay).not.toHaveBeenCalled();
});

test("a credential refused after its refresh is reported, counting both requests", async () => {
  const answers: RefusedAnswer[] = [];
  const sent = stubFetch(() => refused(400, "Expired"));

  const failure = await rejection(
    async () =>
      await sendRequest(
        request({
          readFailure: (answer) => {
            answers.push(answer);

            return readFailure(answer);
          },
        }),
      ),
  );

  expect(sent).toHaveLength(2);
  expect(answers.map((answer) => answer.refreshed)).toEqual([false, true]);
  expect(failure.providerCode).toBe("Expired");
  expect(failure.attempts).toBe(2);
});

test("a refusal is read beside the headers the attempt that met it sent", async () => {
  const answers: RefusedAnswer[] = [];

  stubFetch(() => refused(400, "Expired"));

  await rejection(
    async () =>
      await sendRequest(
        request({
          readFailure: (answer) => {
            answers.push(answer);

            return readFailure(answer);
          },
        }),
      ),
  );

  expect(answers.map((answer) => answer.sentHeaders)).toEqual([
    [["authorization", "resolved"]],
    [["authorization", "refreshed"]],
  ]);
});

test("a credential the attempt cannot refresh is reported at once", async () => {
  const answers: RefusedAnswer[] = [];
  const sent = stubFetch(() => refused(400, "Expired"));

  await rejection(
    async () =>
      await sendRequest(
        request({
          prepare: async () =>
            await Promise.resolve({
              url: "https://provider.invalid/stowage/object.txt",
              headers: [],
              refreshable: false,
            }),
          readFailure: (answer) => {
            answers.push(answer);

            return readFailure(answer);
          },
        }),
      ),
  );

  expect(sent).toHaveLength(1);
  expect(answers[0]?.refreshed).toBe(false);
});

test("the attempts count every request that went out, refreshes included", async () => {
  withoutDelays();
  const sent = stubFetch((_, index) => (index === 0 ? refused(400, "Expired") : refused(503)));

  const failure = await rejection(async () => await sendRequest(request()));

  expect(sent).toHaveLength(4);
  expect(failure.attempts).toBe(4);
});

// ADR 0013: the repeat is how a caching resolver is told to refresh rather than a repeat of
// the transport, and without it an expired credential has no way back.
test("a single attempt still refreshes a refused credential", async () => {
  const sent = stubFetch(() => refused(400, "Expired"));

  const failure = await rejection(async () => await sendRequest(request({ maxAttempts: 1 })));

  expect(sent).toHaveLength(2);
  expect(failure.attempts).toBe(2);
});

test("one request costs at most six: three attempts, each doubled by the refresh", async () => {
  withoutDelays();
  const sent = stubFetch((_, index) => (index % 2 === 0 ? refused(400, "Expired") : refused(503)));

  const failure = await rejection(async () => await sendRequest(request()));

  expect(sent).toHaveLength(6);
  expect(failure.attempts).toBe(6);
});

// Spec 7.5: no promised provider is documented to send `Retry-After`, and a header no
// endpoint of ADR 0012 produces is one no test could cover.
test("the wait follows the curve and never a `Retry-After`", async () => {
  vi.spyOn(Math, "random").mockReturnValue(1);
  const delays: number[] = [];
  const fire = globalThis.setTimeout;

  vi.stubGlobal("setTimeout", (handler: () => void, milliseconds?: number): unknown => {
    delays.push(milliseconds ?? 0);

    return fire(handler, 0);
  });
  stubFetch(() => refused(503, "SlowDown", { "retry-after": "120" }));

  await rejection(async () => await sendRequest(request()));

  expect(delays).toEqual([200, 400]);
});

test("a `StorageError` from `prepare` is told against the request, before any request", async () => {
  const sent = stubFetch(() => new Response("stored"));
  const refusal = new StorageError({
    code: "InvalidCredentials",
    message: "The resolved credential is not an object",
    operation: "resolve",
    bucket: "",
    provider: "s3",
    attempts: 0,
  });

  const failure = await rejection(
    async () => await sendRequest(request({ prepare: async () => await Promise.reject(refusal) })),
  );

  expect(sent).toHaveLength(0);
  expect(failure.code).toBe("InvalidCredentials");
  expect(failure.message).toBe("The resolved credential is not an object");
  expect(failure.operation).toBe("get");
  expect(failure.bucket).toBe("stowage");
  expect(failure.key).toBe("object.txt");
  expect(failure.attempts).toBe(0);
});

test("anything else `prepare` throws travels on untouched", async () => {
  const thrown = new RangeError("the resolver broke");

  stubFetch(() => new Response("stored"));

  await expect(
    sendRequest(request({ prepare: async () => await Promise.reject(thrown) })),
  ).rejects.toBe(thrown);
});

// Spec 7.5: `CompleteMultipartUpload` is not repeated after a transport failure.
test("`stop` repeats no attempt that received no response, and still repeats a status", async () => {
  withoutDelays();
  let calls = 0;

  vi.stubGlobal("fetch", async (): Promise<Response> => {
    calls += 1;

    return await Promise.reject(new TypeError("fetch failed"));
  });

  const unanswered = await rejection(
    async () => await sendRequest(request({ unanswered: "stop" })),
  );

  expect(calls).toBe(1);
  expect(unanswered.code).toBe("NetworkError");
  expect(unanswered.retryable).toBe(true);
  expect(unanswered.attempts).toBe(1);

  const sent = stubFetch(() => refused(503));
  const answered = await rejection(async () => await sendRequest(request({ unanswered: "stop" })));

  expect(sent).toHaveLength(3);
  expect(answered.attempts).toBe(3);
});

// ADR 0037: a move whose answer was lost answers `404` for its source when sent again.
test("`reportOverNotFound` rejects with the doubtful attempt rather than a later `NotFound`", async () => {
  withoutDelays();
  let calls = 0;

  vi.stubGlobal("fetch", async (): Promise<Response> => {
    calls += 1;

    return calls === 1
      ? await Promise.reject(new TypeError("fetch failed"))
      : refused(404, "NoSuchKey");
  });

  const afterNoResponse = await rejection(
    async () => await sendRequest(request({ unanswered: "reportOverNotFound" })),
  );

  expect(afterNoResponse.code).toBe("NetworkError");
  expect(afterNoResponse.retryable).toBe(true);
  expect(afterNoResponse.attempts).toBe(2);

  stubFetch((_, index) => (index === 0 ? refused(503) : refused(404, "NoSuchKey")));

  const afterServerError = await rejection(
    async () => await sendRequest(request({ unanswered: "reportOverNotFound" })),
  );

  expect(afterServerError.code).toBe("ProviderError");
  expect(afterServerError.status).toBe(503);
  expect(afterServerError.attempts).toBe(2);
});

test("`reportOverNotFound` reports the last doubtful attempt, through an answer below `500`", async () => {
  withoutDelays();
  let calls = 0;

  vi.stubGlobal("fetch", async (): Promise<Response> => {
    calls += 1;

    if (calls === 1) return await Promise.reject(new TypeError("fetch failed"));

    return refused(calls === 2 ? 429 : 404, calls === 2 ? "SlowDown" : "NoSuchKey");
  });

  const throughSlowDown = await rejection(
    async () => await sendRequest(request({ unanswered: "reportOverNotFound" })),
  );

  expect(throughSlowDown.code).toBe("NetworkError");
  expect(throughSlowDown.attempts).toBe(3);

  stubFetch((_, index) => {
    if (index === 0) return refused(500, "InternalError");

    return index === 1 ? refused(503, "SlowDown") : refused(404, "NoSuchKey");
  });

  const lastDoubt = await rejection(
    async () => await sendRequest(request({ unanswered: "reportOverNotFound" })),
  );

  expect(lastDoubt.status).toBe(503);
  expect(lastDoubt.attempts).toBe(3);
});

test("`reportOverNotFound` leaves a `NotFound` without doubt, or of the bucket, as it is", async () => {
  withoutDelays();
  stubFetch(() => refused(404, "NoSuchKey"));

  const undoubted = await rejection(
    async () => await sendRequest(request({ unanswered: "reportOverNotFound" })),
  );

  expect(undoubted.code).toBe("NotFound");

  stubFetch((_, index) => (index === 0 ? refused(503) : refused(404, "NoSuchBucket")));

  const ofTheBucket = await rejection(
    async () => await sendRequest(request({ unanswered: "reportOverNotFound" })),
  );

  expect(ofTheBucket.status).toBe(404);
  expect(ofTheBucket.key).toBeUndefined();
});

const storage = { provider: "s3", bucket: "stowage", constructedBy: "s3Storage" };

test("`retry` reads as the number of attempts, three where it is left out", () => {
  expect(readMaxAttempts(undefined, storage)).toBe(3);
  expect(readMaxAttempts({}, storage)).toBe(3);
  expect(readMaxAttempts(false, storage)).toBe(1);
  expect(readMaxAttempts({ maxAttempts: 1 }, storage)).toBe(1);
  expect(readMaxAttempts({ maxAttempts: 2 }, storage)).toBe(2);
});

test.each([
  [true, "The option `retry` takes a group of options"],
  [null, "The option `retry` takes a group of options"],
  [{ attempts: 2 }, "The option `attempts` is not one this storage takes"],
  [{ maxAttempts: 0 }, "The option `maxAttempts` takes the integers 1 to 3"],
  [{ maxAttempts: 4 }, "The option `maxAttempts` takes the integers 1 to 3"],
  [{ maxAttempts: 1.5 }, "The option `maxAttempts` takes the integers 1 to 3"],
])("`retry: %j` is refused where the storage is constructed", (retry, message) => {
  let thrown: unknown;

  try {
    readMaxAttempts(retry, storage);
  } catch (failure) {
    thrown = failure;
  }

  expect(thrown).toMatchObject({
    code: "InvalidOption",
    message,
    operation: "s3Storage",
    bucket: "stowage",
    provider: "s3",
    attempts: 0,
  });
});
