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

/** Options as a caller outside TypeScript may hand them over, where the types refuse them. */
function untyped(options: Record<string, unknown>): never {
  // oxlint-disable-next-line no-unsafe-type-assertion -- a caller outside TypeScript
  return options as never;
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

/** The generation an earlier write reported as `etag`. */
const generation = "1790665923456000";

test("`put` with `onlyIf: { etag }` sends the generation as `ifGenerationMatch` on the insert", async () => {
  const sent = stubFetch(written);

  await storage().put("to", "body", { onlyIf: { etag: generation } });

  expect(sent).toHaveLength(1);
  expect(sent[0]?.url.searchParams.get("ifGenerationMatch")).toBe(generation);
});

test("`copy` with `onlyIf: { etag }` sends the generation on every call of the rewrite", async () => {
  const sent = stubFetch(answeringInTurn(rewriting, rewritten));

  await storage().copy("from", "to", { onlyIf: { etag: generation } });

  expect(sent.map(({ url }) => url.searchParams.get("ifGenerationMatch"))).toEqual([
    generation,
    generation,
  ]);
});

test("`move` with `onlyIf: { etag }` sends the generation on `objects.move`", async () => {
  const sent = stubFetch(written);

  await storage().move("from", "to", { onlyIf: { etag: generation } });

  expect(sent).toHaveLength(1);
  expect(sent[0]?.url.searchParams.get("ifGenerationMatch")).toBe(generation);
});

test("`put` onto a key that holds another generation, or none, rejects with `PreconditionFailed`", async () => {
  const sent = stubFetch(conditionNotMet);

  const failure = await rejection(() =>
    storage().put("to", "body", { onlyIf: { etag: generation } }),
  );

  expect(failure).toMatchObject({
    code: "PreconditionFailed",
    operation: "put",
    key: "to",
    status: 412,
    providerCode: "conditionNotMet",
    attempts: 1,
  });
  expect(sent).toHaveLength(1);
});

/** Well-formed `etag`s that name no generation, which GCS would never match (spec 9.1). */
const noGenerations = [
  "0",
  "01",
  "00",
  "9223372036854775808",
  "18446744073709551616",
  "-1",
  "+1",
  "1.0",
  "1e3",
  "abc",
  "0x1F",
] as const;

// Spec 9.1 and ADR 0071: `0` would turn "unchanged" into "absent" in silence, and the rest
// never match, so each is refused as GCS would refuse it, without a request.
test.each(
  noGenerations.flatMap((etag) =>
    (
      [
        ["put", "to", () => storage().put("to", "body", { onlyIf: { etag } })],
        ["copy", "to", () => storage().copy("from", "to", { onlyIf: { etag } })],
        ["move", "to", () => storage().move("from", "to", { onlyIf: { etag } })],
      ] as const
    ).map(([operation, key, call]) => [operation, etag, key, call] as const),
  ),
)(
  "`%s` refuses `onlyIf: { etag: %j }` as `PreconditionFailed` without a request",
  async (operation, _etag, key, call) => {
    const sent = stubFetch(written);
    const failure = await rejection(call);

    expect(failure).toMatchObject({
      code: "PreconditionFailed",
      operation,
      key,
      retryable: false,
      attempts: 0,
    });
    expect(failure.status).toBeUndefined();
    expect(sent).toEqual([]);
  },
);

test.each(["1", "9223372036854775807", generation])(
  "`put` sends `onlyIf: { etag: %j }` as a generation",
  async (etag) => {
    const sent = stubFetch(written);

    await storage().put("to", "body", { onlyIf: { etag } });

    expect(sent[0]?.url.searchParams.get("ifGenerationMatch")).toBe(etag);
  },
);

// Spec 4.3: with `writeIfAbsent` declared, a string other than `"absent"` is no precondition
// at all rather than one the storage does not hold.
test.each([
  ["put", () => storage().put("to", "body", untyped({ onlyIf: "present" }))],
  ["copy", () => storage().copy("from", "to", untyped({ onlyIf: "present" }))],
  ["move", () => storage().move("from", "to", untyped({ onlyIf: "present" }))],
] as const)(
  '`%s` refuses `onlyIf` as another string than `"absent"` as `InvalidOption` before any request',
  async (operation, call) => {
    const sent = stubFetch(written);
    const failure = await rejection(call);

    expect(failure).toMatchObject({ code: "InvalidOption", operation, attempts: 0 });
    expect(failure.message).toContain("`onlyIf`");
    expect(sent).toEqual([]);
  },
);

/** What GCS answers a `DELETE` it carried out with. */
const deleted = (): Response => new Response(null, { status: 204 });

/** GCS's answer to a `DELETE` of a key that holds no object. */
const objectNotFound = (): Response =>
  errorDocument(404, "notFound", "No such object: conformance/object.txt");

// Spec 9.1 and ADR 0071: a conditional `delete` is one `DELETE`, never a batch.
test("`delete` with `onlyIf: { etag }` sends one `DELETE` carrying the generation", async () => {
  const sent = stubFetch(deleted);

  const report = await storage().delete("a b.txt", { onlyIf: { etag: generation } });

  expect(report).toEqual({ requested: 1, failed: [] });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("DELETE");
  expect(sent[0]?.url.pathname).toBe("/storage/v1/b/conformance/o/a%20b.txt");
  expect(sent[0]?.url.searchParams.get("ifGenerationMatch")).toBe(generation);
});

// Spec 4.7 and 9.8: a key that holds another generation, or none, is the key's entry, and a
// missing key is no success under a precondition.
test.each([
  ["another generation", conditionNotMet, 412, "conditionNotMet"],
  ["no object", objectNotFound, 404, "notFound"],
] as const)(
  "a conditional `delete` of a key that holds %s reports one `PreconditionFailed` entry",
  async (_, answer, status, providerCode) => {
    const sent = stubFetch(answer);

    const report = await storage().delete("object.txt", { onlyIf: { etag: generation } });

    expect(report.requested).toBe(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({
      code: "PreconditionFailed",
      operation: "delete",
      key: "object.txt",
      status,
      providerCode,
      requestId: "upload-1",
      retryable: false,
      attempts: 1,
    });
    expect(sent).toHaveLength(1);
  },
);

test("a conditional `delete` in a missing bucket rejects with `NotFound` without `key`", async () => {
  stubFetch(() => errorDocument(404, "notFound", "The specified bucket does not exist."));

  const failure = await rejection(() =>
    storage().delete("object.txt", { onlyIf: { etag: generation } }),
  );

  expect(failure).toMatchObject({ code: "NotFound", operation: "delete", key: undefined });
});

// Spec 4.7 and ADR 0073: whether this call deleted the object is open, and the entry says so.
test.each(
  (
    [
      ["no response", noResponse, { code: "NetworkError" }],
      [
        "a `503`",
        () => errorDocument(503, "backendError", "Backend Error"),
        { code: "ProviderError", status: 503, providerCode: "backendError" },
      ],
    ] as const
  ).flatMap(([first, answer, reported]) =>
    (
      [
        ["`412 conditionNotMet`", conditionNotMet],
        ["`404 notFound`", objectNotFound],
      ] as const
    ).map(([refusal, refuse]) => [refusal, first, answer, refuse, reported] as const),
  ),
)(
  "a conditional `delete` refused with %s after %s reports that failure as the key's entry",
  async (_refusal, _first, answer, refuse, reported) => {
    withoutBackoff();
    stubFetch(answeringInTurn(answer, refuse));

    const report = await storage().delete("object.txt", { onlyIf: { etag: generation } });

    expect(report.requested).toBe(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({
      ...reported,
      operation: "delete",
      key: "object.txt",
      retryable: true,
      attempts: 2,
    });
  },
);

// Spec 4.7: a failure of the request as a whole rejects the call instead of filling the report.
test.each([
  ["receives no response", noResponse, "NetworkError"],
  [
    "is answered `503` on every attempt",
    () => errorDocument(503, "backendError", "Backend Error"),
    "ProviderError",
  ],
  [
    "is refused its credential",
    () => errorDocument(401, "required", "Anonymous caller does not have storage.objects.delete."),
    "InvalidCredentials",
  ],
] as const)("a conditional `delete` that %s rejects", async (_, answer, code) => {
  withoutBackoff();
  stubFetch(answer);

  const failure = await rejection(() =>
    storage().delete("object.txt", { onlyIf: { etag: generation } }),
  );

  expect(failure).toMatchObject({ code, operation: "delete", key: "object.txt" });
});

// Spec 4.7: the answer is read as the entry of that key in a batch would be.
test("a conditional `delete` the principal may not perform reports `AccessDenied` as the key's entry", async () => {
  stubFetch(() =>
    errorDocument(
      403,
      "insufficientPermissions",
      "stowage-conformance-denied does not have storage.objects.delete access.",
    ),
  );

  const report = await storage().delete("object.txt", { onlyIf: { etag: generation } });

  expect(report.failed).toHaveLength(1);
  expect(report.failed[0]).toMatchObject({ code: "AccessDenied", key: "object.txt" });
});

test("a conditional `delete` of an invalid key reports `InvalidKey` without a request", async () => {
  const sent = stubFetch(deleted);

  const report = await storage().delete("", { onlyIf: { etag: generation } });

  expect(report.requested).toBe(1);
  expect(report.failed[0]).toMatchObject({ code: "InvalidKey", attempts: 0 });
  expect(sent).toEqual([]);
});

// Spec 4.7 and 9.1: an `etag` that is no generation is refused as GCS would refuse it, which is
// the key's entry on a `delete`.
test.each(noGenerations)(
  "a conditional `delete` under `{ etag: %j }` reports `PreconditionFailed` without a request",
  async (etag) => {
    const sent = stubFetch(deleted);

    const report = await storage().delete("object.txt", { onlyIf: { etag } });

    expect(report.requested).toBe(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({
      code: "PreconditionFailed",
      operation: "delete",
      key: "object.txt",
      retryable: false,
      attempts: 0,
    });
    expect(sent).toEqual([]);
  },
);
