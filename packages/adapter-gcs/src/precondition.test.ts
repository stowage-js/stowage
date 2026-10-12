import { isStorageError, type StorageError } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import { gcsStorage } from "./index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface SentRequest {
  readonly url: URL;
  readonly method: string;
}

type Answer = (request: SentRequest) => Response | Promise<Response>;

/** What `fetch` was called with, in order, while it answered `answer`. */
function stubFetch(answer: Answer): SentRequest[] {
  const sent: SentRequest[] = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    const request: SentRequest = { url: new URL(url), method: init.method ?? "GET" };

    sent.push(request);

    return await answer(request);
  });

  return sent;
}

function storage() {
  return gcsStorage({ bucket: "conformance", credentials: { accessToken: "ya29.a0AfB_byC" } });
}

async function rejection(act: () => Promise<unknown>): Promise<StorageError> {
  try {
    await act();
  } catch (failure) {
    if (isStorageError(failure)) return failure;

    throw failure;
  }

  throw new Error("The call resolved");
}

function withoutBackoff(): void {
  vi.spyOn(Math, "random").mockReturnValue(0);
}

/** The object resource the JSON API answers an insert, a finished rewrite and a move with. */
function objectResource(name: string): Record<string, unknown> {
  return {
    kind: "storage#object",
    name,
    bucket: "conformance",
    generation: "1790665923456000",
    contentType: "text/plain",
    size: "4",
    updated: "2026-09-29T07:12:03.456Z",
  };
}

const written = (): Response => Response.json(objectResource("to"));

const rewritten = (): Response =>
  Response.json({ kind: "storage#rewriteResponse", done: true, resource: objectResource("to") });

const rewriting = (): Response =>
  Response.json({ kind: "storage#rewriteResponse", done: false, rewriteToken: "token-1" });

function errorDocument(status: number, reason: string, message: string): Response {
  return Response.json(
    { error: { code: status, message, errors: [{ message, reason }] } },
    { status, headers: { "x-guploader-uploadid": "upload-1" } },
  );
}

/** GCS's answer to `ifGenerationMatch=0` on a name that holds an object. */
const conditionNotMet = (): Response =>
  errorDocument(
    412,
    "conditionNotMet",
    "At least one of the pre-conditions you specified did not hold.",
  );

const noResponse = (): never => {
  throw new TypeError("fetch failed");
};

/** A provider that answers the attempts in turn, the last answer standing for every later one. */
function answeringInTurn(...answers: readonly (() => Response)[]): () => Response {
  let attempt = 0;

  return () => {
    const answer = answers[Math.min(attempt, answers.length - 1)];

    attempt += 1;

    if (answer === undefined) throw new Error("The stub holds no answer");

    return answer();
  };
}

test("the storage declares `writeIfAbsent`", () => {
  expect(storage().capabilities).toContain("writeIfAbsent");
});

test('`put` with `onlyIf: "absent"` sends `ifGenerationMatch=0` on the insert', async () => {
  const sent = stubFetch(written);

  await storage().put("to", "body", { onlyIf: "absent" });

  expect(sent).toHaveLength(1);
  expect(sent[0]?.url.searchParams.get("uploadType")).toBe("multipart");
  expect(sent[0]?.url.searchParams.get("ifGenerationMatch")).toBe("0");
});

test("`put` without `onlyIf` sends no precondition", async () => {
  const sent = stubFetch(written);

  await storage().put("to", "body");

  expect(sent[0]?.url.searchParams.has("ifGenerationMatch")).toBe(false);
});

test("`put` onto a key that holds an object rejects with `PreconditionFailed`, not repeated", async () => {
  const sent = stubFetch(conditionNotMet);

  const failure = await rejection(() => storage().put("to", "body", { onlyIf: "absent" }));

  expect(failure).toMatchObject({
    code: "PreconditionFailed",
    operation: "put",
    key: "to",
    status: 412,
    providerCode: "conditionNotMet",
    retryable: false,
    attempts: 1,
  });
  expect(sent).toHaveLength(1);
});

test("`copy` sends `ifGenerationMatch=0` on every call of the rewrite", async () => {
  const sent = stubFetch(answeringInTurn(rewriting, rewriting, rewritten));

  await storage().copy("from", "to", { onlyIf: "absent" });

  expect(sent.map(({ url }) => url.searchParams.get("ifGenerationMatch"))).toEqual(["0", "0", "0"]);
  expect(sent.map(({ url }) => url.searchParams.get("rewriteToken"))).toEqual([
    null,
    "token-1",
    "token-1",
  ]);
});

test("an unconditional `copy` and `move` send no precondition", async () => {
  const sent = stubFetch((request) =>
    request.url.pathname.includes("/rewriteTo/") ? rewritten() : written(),
  );

  await storage().copy("from", "to");
  await storage().move("from", "to");

  expect(sent.map(({ url }) => url.searchParams.has("ifGenerationMatch"))).toEqual([false, false]);
});

// Spec 9.7: GCS holds the first call's precondition through the rewrite and checks it at the
// committing call, so a key another writer took in between is refused there.
test("a conditional `copy` overtaken between two calls of the rewrite rejects with `PreconditionFailed` for `to`", async () => {
  const sent = stubFetch(answeringInTurn(rewriting, rewriting, conditionNotMet));

  const failure = await rejection(() => storage().copy("from", "to", { onlyIf: "absent" }));

  expect(failure).toMatchObject({
    code: "PreconditionFailed",
    operation: "copy",
    key: "to",
    status: 412,
    retryable: false,
    attempts: 1,
  });
  expect(sent).toHaveLength(3);
});

test('`move` with `onlyIf: "absent"` sends `ifGenerationMatch=0` on `objects.move`', async () => {
  const sent = stubFetch(written);

  await storage().move("from", "to", { onlyIf: "absent" });

  expect(sent).toHaveLength(1);
  expect(sent[0]?.url.pathname).toBe("/storage/v1/b/conformance/o/from/moveTo/o/to");
  expect(sent[0]?.url.searchParams.get("ifGenerationMatch")).toBe("0");
});

test("a conditional `move` onto a key that holds an object rejects with `PreconditionFailed` for `to`", async () => {
  const sent = stubFetch(conditionNotMet);

  const failure = await rejection(() => storage().move("from", "to", { onlyIf: "absent" }));

  expect(failure).toMatchObject({
    code: "PreconditionFailed",
    operation: "move",
    key: "to",
    retryable: false,
    attempts: 1,
  });
  expect(sent).toHaveLength(1);
});

const conditionalRequests = [
  ["put", () => storage().put("to", "body", { onlyIf: "absent" })],
  ["copy", () => storage().copy("from", "to", { onlyIf: "absent" })],
  ["move", () => storage().move("from", "to", { onlyIf: "absent" })],
] as const;

// Spec 9.5 and ADR 0073: the repeat of a write that went through meets its own object.
test.each(conditionalRequests)(
  "a conditional `%s` refused after an attempt without a response rejects with that `NetworkError`",
  async (operation, call) => {
    withoutBackoff();
    stubFetch(answeringInTurn(noResponse, conditionNotMet));

    const failure = await rejection(call);

    expect(failure).toMatchObject({
      code: "NetworkError",
      operation,
      retryable: true,
      attempts: 2,
    });
  },
);

test.each(conditionalRequests)(
  "a conditional `%s` refused after a `5xx` rejects with that `ProviderError`",
  async (operation, call) => {
    withoutBackoff();
    stubFetch(
      answeringInTurn(() => errorDocument(503, "backendError", "Backend Error"), conditionNotMet),
    );

    const failure = await rejection(call);

    expect(failure).toMatchObject({
      code: "ProviderError",
      operation,
      status: 503,
      retryable: true,
      attempts: 2,
    });
  },
);

// ADR 0073: a `408` or a `429` says the provider did not act on the attempt.
test.each(
  conditionalRequests.flatMap(([operation, call]) => [
    [operation, 408, call],
    [operation, 429, call],
  ]),
)(
  "a conditional `%s` refused after a `%i` rejects with `PreconditionFailed`",
  async (operation, status, call) => {
    withoutBackoff();
    stubFetch(
      answeringInTurn(
        () => errorDocument(status, "rateLimitExceeded", "Slow down."),
        conditionNotMet,
      ),
    );

    const failure = await rejection(call);

    expect(failure).toMatchObject({
      code: "PreconditionFailed",
      operation,
      key: "to",
      attempts: 2,
    });
  },
);

test.each([
  ["conflict", 409],
  ["clientClosedRequest", 499],
])("`%s` answered to a conditional `put` stays `ProviderError`", async (providerCode, status) => {
  stubFetch(() => errorDocument(status, providerCode, "The provider said so."));

  const failure = await rejection(() => storage().put("to", "body", { onlyIf: "absent" }));

  expect(failure).toMatchObject({ code: "ProviderError", providerCode, status });
});

// Until the adapter declares `writeIfUnchanged`, spec 4.3 refuses `onlyIf: { etag }` before
// any request.
test.each([
  ["put", () => storage().put("to", "body", { onlyIf: { etag: "1" } })],
  ["copy", () => storage().copy("from", "to", { onlyIf: { etag: "1" } })],
  ["move", () => storage().move("from", "to", { onlyIf: { etag: "1" } })],
] as const)(
  "`%s` refuses `onlyIf: { etag }` as `Unsupported` naming `writeIfUnchanged` before any request",
  async (operation, call) => {
    const sent = stubFetch(written);
    const failure = await rejection(call);

    expect(failure).toMatchObject({
      code: "Unsupported",
      capability: "writeIfUnchanged",
      operation,
      key: "to",
      attempts: 0,
    });
    expect(sent).toEqual([]);
  },
);
