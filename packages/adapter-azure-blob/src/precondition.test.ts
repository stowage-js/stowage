import { isStorageError, type StorageError } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import { type AzureBlobAdapterOptions, azureBlobStorage } from "./index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface SentRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
}

type Answer = (request: SentRequest) => Response | Promise<Response>;

/** What `fetch` was called with, in order, while it answered `answer`. */
function stubFetch(answer: Answer): SentRequest[] {
  const sent: SentRequest[] = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    const request: SentRequest = {
      url: new URL(url),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : undefined,
    };

    sent.push(request);

    return await answer(request);
  });

  return sent;
}

const accessToken = "eyJ0eXAiOiJKV1QifQ.e30.";

function storage(overrides: Partial<AzureBlobAdapterOptions> = {}) {
  return azureBlobStorage({
    account: "stowage",
    container: "conformance",
    credentials: { accessToken },
    ...overrides,
  });
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

/** Every wait between two attempts cut to nothing, so a spent budget costs no time. */
function immediateRetries(): void {
  const fire = globalThis.setTimeout;

  vi.stubGlobal("setTimeout", (handler: () => void): unknown => fire(handler, 0));
}

/** What Azure answers `Put Blob`, `Put Block List` and `Put Blob From URL` with. */
function created(): Response {
  return new Response(null, {
    status: 201,
    headers: { etag: '"0x8DCA1B2C3D4E5F6"', "last-modified": "Sun, 30 Aug 2026 12:36:00 GMT" },
  });
}

/** What Azure answers `Get Blob Properties` with: the description, and no body. */
function described(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      "content-length": "11",
      "content-type": "text/plain",
      "last-modified": "Sun, 30 Aug 2026 12:36:00 GMT",
      etag: '"0x8DCA1B2C3D4E5F6"',
      "x-ms-blob-type": "BlockBlob",
    },
  });
}

function refused(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    `﻿<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    {
      status,
      headers: {
        "content-type": "application/xml",
        "x-ms-error-code": code,
        "x-ms-request-id": "request-1",
        ...headers,
      },
    },
  );
}

/** Azure's answer to `If-None-Match: *` on a key that holds a blob, where it documents `412`. */
const blobAlreadyExists = (): Response =>
  refused(409, "BlobAlreadyExists", "The specified blob already exists.");

/** Azure's answer to `If-Match` naming another blob than the one the key holds. */
const conditionNotMet = (): Response =>
  refused(
    412,
    "ConditionNotMet",
    "The condition specified using HTTP conditional header(s) is not met.",
  );

/** The `etag` a `stat` reported, which `onlyIf` names unquoted. */
const etag = "0x8DCA1B2C3D4E5F6";

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

test('`put` with `onlyIf: "absent"` sends `If-None-Match: *` on `Put Blob`', async () => {
  const sent = stubFetch(created);

  await storage().put("object.txt", "body", { onlyIf: "absent" });

  expect(sent).toHaveLength(1);
  expect(sent[0]?.headers.get("if-none-match")).toBe("*");
});

test("`put` without `onlyIf` sends no precondition", async () => {
  const sent = stubFetch(created);

  await storage().put("object.txt", "body");

  expect(sent[0]?.headers.has("if-none-match")).toBe(false);
});

test("`put` onto a key that holds a blob rejects with `PreconditionFailed`, not repeated", async () => {
  const sent = stubFetch(blobAlreadyExists);

  const failure = await rejection(() => storage().put("object.txt", "body", { onlyIf: "absent" }));

  expect(failure).toMatchObject({
    code: "PreconditionFailed",
    operation: "put",
    key: "object.txt",
    status: 409,
    providerCode: "BlobAlreadyExists",
    retryable: false,
    attempts: 1,
  });
  expect(sent).toHaveLength(1);
});

test("`put` with `onlyIf: { etag }` sends `If-Match` with the `etag` quoted as a strong tag", async () => {
  const sent = stubFetch(created);

  await storage().put("object.txt", "body", { onlyIf: { etag } });

  expect(sent).toHaveLength(1);
  expect(sent[0]?.headers.get("if-match")).toBe(`"${etag}"`);
  expect(sent[0]?.headers.has("if-none-match")).toBe(false);
});

test("`put` onto a key that holds another blob rejects with `PreconditionFailed`, not repeated", async () => {
  const sent = stubFetch(conditionNotMet);

  const failure = await rejection(() => storage().put("object.txt", "body", { onlyIf: { etag } }));

  expect(failure).toMatchObject({
    code: "PreconditionFailed",
    operation: "put",
    key: "object.txt",
    status: 412,
    providerCode: "ConditionNotMet",
    retryable: false,
    attempts: 1,
  });
  expect(sent).toHaveLength(1);
});

const mebibyte = 1024 * 1024;

/** The smallest part spec 8.1 accepts, which keeps a block upload cheap to stub. */
const smallestPart = 5 * mebibyte;

/** A stream that fills two parts of `smallestPart`, which makes `put` a block upload. */
function twoParts(): ReadableStream<Uint8Array> {
  const bytes = new Uint8Array(smallestPart + 1);
  let pulled = 0;

  return new ReadableStream({
    pull(controller) {
      if (pulled >= bytes.byteLength) {
        controller.close();
        return;
      }

      const end = Math.min(pulled + mebibyte, bytes.byteLength);

      controller.enqueue(bytes.subarray(pulled, end));
      pulled = end;
    },
  });
}

/** The request of a block upload a `SentRequest` is, read off its method and query. */
function stepOf(request: SentRequest): string {
  const comp = request.url.searchParams.get("comp");

  if (request.method === "PUT" && comp === "block") return "block";
  if (request.method === "PUT" && comp === "blocklist") return "commit";

  return `${request.method} ${request.url.pathname}`;
}

/** Answers every `Put Block` as accepted and the commit with `commit`. */
function blockProvider(commit: () => Response = created): Answer {
  return (request) =>
    stepOf(request) === "commit" ? commit() : new Response(null, { status: 201 });
}

function blockStorage(): ReturnType<typeof azureBlobStorage> {
  return storage({ multipart: { partSize: smallestPart } });
}

// Spec 8.4: Azure checks no precondition on `Put Block`.
test("a conditional block upload sends `If-None-Match: *` on its commit alone", async () => {
  const sent = stubFetch(blockProvider());

  await blockStorage().put("object.bin", twoParts(), { onlyIf: "absent" });

  expect(sent.map((request) => [stepOf(request), request.headers.get("if-none-match")])).toEqual([
    ["block", null],
    ["block", null],
    ["commit", "*"],
  ]);
});

test("a block upload under `onlyIf: { etag }` sends `If-Match` on its commit alone", async () => {
  const sent = stubFetch(blockProvider());

  await blockStorage().put("object.bin", twoParts(), { onlyIf: { etag } });

  expect(sent.map((request) => [stepOf(request), request.headers.get("if-match")])).toEqual([
    ["block", null],
    ["block", null],
    ["commit", `"${etag}"`],
  ]);
});

// Spec 8.6: nothing aborts a block upload, and `Delete Blob` would delete the object that
// refused it.
test("a commit its precondition refused sends nothing after it", async () => {
  const sent = stubFetch(blockProvider(blobAlreadyExists));

  const failure = await rejection(() =>
    blockStorage().put("object.bin", twoParts(), { onlyIf: "absent" }),
  );

  expect(failure).toMatchObject({ code: "PreconditionFailed", key: "object.bin", attempts: 1 });
  expect(sent.map(stepOf)).toEqual(["block", "block", "commit"]);
});

/** The `HEAD`s of a copy answered as described, and `Put Blob From URL` with `copy`. */
function copyProvider(copy: () => Response = created): Answer {
  return (request) => {
    if (request.method === "HEAD") return described();
    if (request.method === "PUT") return copy();

    return new Response(null, { status: 202 });
  };
}

/**
 * Each conditional write of spec 8.5, the answer Azure refuses its precondition with, and the
 * call that sends it answered `answer`.
 */
const conditionalRequests = [
  [
    "`Put Blob`",
    blobAlreadyExists,
    (answer: () => Response) => {
      stubFetch(answer);

      return storage().put("object.txt", "body", { onlyIf: "absent" });
    },
  ],
  [
    "`Put Block List`",
    blobAlreadyExists,
    (answer: () => Response) => {
      stubFetch(blockProvider(answer));

      return blockStorage().put("object.bin", twoParts(), { onlyIf: "absent" });
    },
  ],
  [
    "`Put Blob From URL`",
    blobAlreadyExists,
    (answer: () => Response) => {
      stubFetch(copyProvider(answer));

      return storage().copy("from.txt", "to.txt", { onlyIf: "absent" });
    },
  ],
  [
    "`Put Blob` under `{ etag }`",
    conditionNotMet,
    (answer: () => Response) => {
      stubFetch(answer);

      return storage().put("object.txt", "body", { onlyIf: { etag } });
    },
  ],
  [
    "`Put Block List` under `{ etag }`",
    conditionNotMet,
    (answer: () => Response) => {
      stubFetch(blockProvider(answer));

      return blockStorage().put("object.bin", twoParts(), { onlyIf: { etag } });
    },
  ],
  [
    "`Put Blob From URL` under `{ etag }`",
    conditionNotMet,
    (answer: () => Response) => {
      stubFetch(copyProvider(answer));

      return storage().copy("from.txt", "to.txt", { onlyIf: { etag } });
    },
  ],
] as const;

// Spec 8.5 and ADR 0073: the repeat of a write that went through meets its own blob.
test.each(conditionalRequests)(
  "a conditional %s refused after no response rejects with that failure",
  async (_, refusal, act) => {
    immediateRetries();

    const failure = await rejection(() => act(answeringInTurn(noResponse, refusal)));

    expect(failure).toMatchObject({ code: "NetworkError", retryable: true, attempts: 2 });
  },
);

test.each(conditionalRequests)(
  "a conditional %s refused after a `503` rejects with that failure",
  async (_, refusal, act) => {
    immediateRetries();

    const failure = await rejection(() =>
      act(answeringInTurn(() => refused(503, "ServerBusy", "The server is busy."), refusal)),
    );

    expect(failure).toMatchObject({
      code: "ProviderError",
      status: 503,
      providerCode: "ServerBusy",
      retryable: true,
      attempts: 2,
    });
  },
);

// ADR 0073: a `408` or a `429` says the provider did not act on the attempt.
test.each(
  conditionalRequests.flatMap(([request, refusal, act]) =>
    ([408, 429] as const).map((status) => [request, status, refusal, act] as const),
  ),
)(
  "a conditional %s refused after a `%i` stays `PreconditionFailed`",
  async (_, status, refusal, act) => {
    immediateRetries();

    const failure = await rejection(() =>
      act(answeringInTurn(() => refused(status, "Refused", "Refused."), refusal)),
    );

    expect(failure).toMatchObject({
      code: "PreconditionFailed",
      status: refusal().status,
      retryable: false,
      attempts: 2,
    });
  },
);

test.each(["copy", "move"] as const)(
  '`%s` with `onlyIf: "absent"` sends `If-None-Match: *` on `Put Blob From URL` alone',
  async (operation) => {
    const sent = stubFetch(copyProvider());

    await storage()[operation]("from.txt", "to.txt", { onlyIf: "absent" });

    // The `HEAD` of the source, the copy, the `HEAD` that describes the destination, and the
    // `DELETE` of the source of a `move`.
    expect(sent.map((request) => [request.method, request.headers.get("if-none-match")])).toEqual([
      ["HEAD", null],
      ["PUT", "*"],
      ["HEAD", null],
      ...(operation === "move" ? [["DELETE", null]] : []),
    ]);
  },
);

test.each(["copy", "move"] as const)(
  "`%s` with `onlyIf: { etag }` sends `If-Match` on `Put Blob From URL` alone",
  async (operation) => {
    const sent = stubFetch(copyProvider());

    await storage()[operation]("from.txt", "to.txt", { onlyIf: { etag } });

    expect(sent.map((request) => [request.method, request.headers.get("if-match")])).toEqual([
      ["HEAD", null],
      ["PUT", `"${etag}"`],
      ["HEAD", null],
      ...(operation === "move" ? [["DELETE", null]] : []),
    ]);
    expect(sent[1]?.headers.get("x-ms-source-if-match")).toBe(`"${etag}"`);
  },
);

test.each(["copy", "move"] as const)(
  "`%s` whose destination holds another blob is `PreconditionFailed` against `to`, and deletes nothing",
  async (operation) => {
    const sent = stubFetch(copyProvider(conditionNotMet));

    const failure = await rejection(() =>
      storage()[operation]("from.txt", "to.txt", { onlyIf: { etag } }),
    );

    expect(failure).toMatchObject({
      code: "PreconditionFailed",
      operation,
      key: "to.txt",
      status: 412,
      providerCode: "ConditionNotMet",
      retryable: false,
      attempts: 1,
    });
    expect(sent.map((request) => request.method)).toEqual(["HEAD", "PUT"]);
  },
);

test("an unconditional `copy` sends no precondition on its destination", async () => {
  const sent = stubFetch(copyProvider());

  await storage().copy("from.txt", "to.txt");

  expect(sent.some((request) => request.headers.has("if-none-match"))).toBe(false);
});

test.each(["copy", "move"] as const)(
  "`%s` refused at its destination is `PreconditionFailed` against `to`, and deletes nothing",
  async (operation) => {
    const sent = stubFetch(copyProvider(blobAlreadyExists));

    const failure = await rejection(() =>
      storage()[operation]("from.txt", "to.txt", { onlyIf: "absent" }),
    );

    expect(failure).toMatchObject({
      code: "PreconditionFailed",
      operation,
      key: "to.txt",
      status: 409,
      providerCode: "BlobAlreadyExists",
      retryable: false,
      attempts: 1,
    });
    expect(sent.map((request) => request.method)).toEqual(["HEAD", "PUT"]);
  },
);

/** What Azure answered a copy pinned to an entity tag the source no longer carried. */
function sourceReplaced(): Response {
  return refused(412, "CannotVerifyCopySource", "The condition specified was not met.", {
    "x-ms-copy-source-status-code": "412",
  });
}

// Spec 8.7: the failed pin is the source's, whatever the copy says of its destination.
test("a conditional copy repeated after a failed pin carries the precondition again, and stays the failed pin", async () => {
  const sent = stubFetch(copyProvider(sourceReplaced));

  const failure = await rejection(() => storage().copy("from.txt", "to.txt", { onlyIf: "absent" }));

  expect(failure).toMatchObject({
    code: "ProviderError",
    providerCode: "CannotVerifyCopySource",
    status: 412,
    retryable: true,
    key: "from.txt",
    attempts: 3,
  });

  const copies = sent.filter((request) => request.method === "PUT");

  expect(copies.map((request) => request.headers.get("if-none-match"))).toEqual(["*", "*", "*"]);
});

/** The blob names a Blob Batch deletes, read off the request lines of its subrequests. */
function deletedByBatch(body: string | undefined): string[] {
  return [...(body ?? "").matchAll(/DELETE \/conformance\/(\S+) HTTP\/1\.1/gu)].map(([, path]) =>
    decodeURIComponent(path ?? ""),
  );
}

/** What Azure answers a Blob Batch of `count` deletes with, each accepted. */
function batchAccepted(count: number): Response {
  const boundary = "batchresponse_66925647-d0cb-4109-b6d3-28efe3e1e5ed";
  const parts = Array.from(
    { length: count },
    (_, index) =>
      `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: ${index}\r\n\r\n` +
      `HTTP/1.1 202 Accepted\r\nx-ms-delete-type-permanent: true\r\nx-ms-request-id: sub-${index}\r\nx-ms-version: 2026-04-06\r\n\r\n\r\n`,
  );

  return new Response(`${parts.join("")}--${boundary}--\r\n`, {
    status: 202,
    headers: { "content-type": `multipart/mixed; boundary=${boundary}` },
  });
}

/**
 * A container holding `keys`, which answers `Put Blob From URL` under `If-None-Match: *` as
 * Azure does and refuses the first `deletesRefused` single-key `Delete Blob`s.
 */
function containerHolding(
  keys: readonly string[],
  deletesRefused: number,
): { readonly held: Set<string>; readonly answer: Answer } {
  const held = new Set(keys);
  let refusals = deletesRefused;

  return {
    held,
    answer: (request) => {
      const key = decodeURIComponent(request.url.pathname.replace(/^\/conformance\//u, ""));

      if (request.method === "HEAD") return described();

      if (request.method === "PUT") {
        if (request.headers.get("if-none-match") === "*" && held.has(key)) {
          return blobAlreadyExists();
        }

        held.add(key);

        return created();
      }

      if (request.method === "DELETE") {
        if (refusals > 0) {
          refusals -= 1;

          return refused(
            403,
            "AuthorizationPermissionMismatch",
            "This request is not authorized to perform this operation using this permission.",
          );
        }

        held.delete(key);

        return new Response(null, { status: 202 });
      }

      if (request.method === "POST" && request.url.searchParams.get("comp") === "batch") {
        const deleted = deletedByBatch(request.body);

        for (const name of deleted) held.delete(name);

        return batchAccepted(deleted.length);
      }

      throw new Error(`The stub answers no ${request.method} ${request.url.pathname}`);
    },
  };
}

// Spec 4.10 and ADR 0073: a conditional `move` repeated after its delete failed meets the
// destination it wrote, and `delete(from)` finishes it.
test("a conditional `move` whose delete failed is refused when repeated, and `delete` finishes it", async () => {
  const container = containerHolding(["from.txt"], 1);
  const sent = stubFetch(container.answer);
  const moving = storage();

  const deleteFailed = await rejection(() =>
    moving.move("from.txt", "to.txt", { onlyIf: "absent" }),
  );

  expect(deleteFailed).toMatchObject({
    code: "AccessDenied",
    operation: "move",
    key: "from.txt",
  });
  expect(sent.find((request) => request.method === "DELETE")?.headers.has("if-none-match")).toBe(
    false,
  );
  expect([...container.held].toSorted()).toEqual(["from.txt", "to.txt"]);

  const repeated = await rejection(() => moving.move("from.txt", "to.txt", { onlyIf: "absent" }));

  expect(repeated).toMatchObject({ code: "PreconditionFailed", operation: "move", key: "to.txt" });
  expect([...container.held].toSorted()).toEqual(["from.txt", "to.txt"]);

  const report = await moving.delete("from.txt");

  expect(report).toMatchObject({ requested: 1, failed: [] });
  expect([...container.held]).toEqual(["to.txt"]);
});

/** What Azure answers a `Delete Blob` it carried out with. */
const deleted = (): Response => new Response(null, { status: 202 });

/** Azure's answer to a `Delete Blob` of a key that holds no blob. */
const blobNotFound = (): Response =>
  refused(404, "BlobNotFound", "The specified blob does not exist.");

// Spec 8.1 and ADR 0071: a conditional `delete` is one `Delete Blob`, never a Blob Batch.
test("`delete` with `onlyIf: { etag }` sends one `Delete Blob` carrying `If-Match`", async () => {
  const sent = stubFetch(deleted);

  const report = await storage().delete("a b.txt", { onlyIf: { etag } });

  expect(report).toEqual({ requested: 1, failed: [] });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("DELETE");
  expect(sent[0]?.url.pathname).toBe("/conformance/a%20b.txt");
  expect(sent[0]?.headers.get("if-match")).toBe(`"${etag}"`);
});

// Spec 4.7 and 8.8: a key that holds another blob, or none, is the key's entry, and a missing
// key is no success under a precondition.
test.each([
  ["another blob", conditionNotMet, 412, "ConditionNotMet"],
  ["no blob", blobNotFound, 404, "BlobNotFound"],
] as const)(
  "a conditional `delete` of a key that holds %s reports one `PreconditionFailed` entry",
  async (_, answer, status, providerCode) => {
    const sent = stubFetch(answer);

    const report = await storage().delete("object.txt", { onlyIf: { etag } });

    expect(report.requested).toBe(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({
      code: "PreconditionFailed",
      operation: "delete",
      key: "object.txt",
      status,
      providerCode,
      retryable: false,
      attempts: 1,
    });
    expect(sent).toHaveLength(1);
  },
);

test("a conditional `delete` in a missing container rejects with `NotFound` without `key`", async () => {
  stubFetch(() => refused(404, "ContainerNotFound", "The specified container does not exist."));

  const failure = await rejection(() => storage().delete("object.txt", { onlyIf: { etag } }));

  expect(failure).toMatchObject({ code: "NotFound", operation: "delete", key: undefined });
});

// Spec 4.7 and ADR 0073: whether this call deleted the object is open, and the entry says so.
test.each([
  ["no response", noResponse, { code: "NetworkError" }],
  [
    "a `503`",
    () => refused(503, "ServerBusy", "The server is busy."),
    { code: "ProviderError", status: 503, providerCode: "ServerBusy" },
  ],
] as const)(
  "a conditional `delete` refused after %s reports that failure as the key's entry",
  async (_, first, reported) => {
    immediateRetries();

    for (const refusal of [conditionNotMet, blobNotFound]) {
      stubFetch(answeringInTurn(first, refusal));

      // oxlint-disable-next-line no-await-in-loop -- one stubbed provider at a time
      const report = await storage().delete("object.txt", { onlyIf: { etag } });

      expect(report.requested).toBe(1);
      expect(report.failed).toHaveLength(1);
      expect(report.failed[0]).toMatchObject({
        ...reported,
        operation: "delete",
        key: "object.txt",
        retryable: true,
        attempts: 2,
      });
    }
  },
);

// Spec 4.7: a failure of the request as a whole rejects the call instead of filling the report.
test.each([
  ["receives no response", noResponse, "NetworkError"],
  [
    "is answered `503` on every attempt",
    () => refused(503, "ServerBusy", "Busy."),
    "ProviderError",
  ],
  [
    "is refused its credential",
    () => refused(403, "AuthenticationFailed", "Server failed to authenticate the request."),
    "InvalidCredentials",
  ],
] as const)("a conditional `delete` that %s rejects", async (_, answer, code) => {
  immediateRetries();
  stubFetch(answer);

  const failure = await rejection(() => storage().delete("object.txt", { onlyIf: { etag } }));

  expect(failure).toMatchObject({ code, operation: "delete", key: "object.txt" });
});

// Spec 4.7: the answer is read as the entry of that key in a batch would be.
test("a conditional `delete` the principal may not perform reports `AccessDenied` as the key's entry", async () => {
  stubFetch(() =>
    refused(
      403,
      "AuthorizationPermissionMismatch",
      "This request is not authorized to perform this operation using this permission.",
    ),
  );

  const report = await storage().delete("object.txt", { onlyIf: { etag } });

  expect(report.failed).toHaveLength(1);
  expect(report.failed[0]).toMatchObject({ code: "AccessDenied", key: "object.txt" });
});

test("a conditional `delete` of an invalid key reports `InvalidKey` without a request", async () => {
  const sent = stubFetch(deleted);

  const report = await storage().delete("", { onlyIf: { etag } });

  expect(report.requested).toBe(1);
  expect(report.failed[0]).toMatchObject({ code: "InvalidKey", attempts: 0 });
  expect(sent).toEqual([]);
});

/** `answer` without its `ETag`. */
function withoutEtag(answer: Response): Response {
  answer.headers.delete("etag");

  return answer;
}

// Spec 8.4: the adapter declares `writeIfUnchanged`, so spec 4.4 promises an `etag` on every
// description, and an answer without one is reported rather than described (ADR 0071).
test.each([
  [
    "`Put Blob`",
    "put",
    () => {
      stubFetch(() => withoutEtag(created()));

      return storage().put("to.txt", "body");
    },
  ],
  [
    "`Put Block List`",
    "put",
    () => {
      stubFetch(blockProvider(() => withoutEtag(created())));

      return blockStorage().put("to.txt", twoParts());
    },
  ],
  [
    "the `HEAD` that describes the destination of a copy",
    "copy",
    () => {
      stubFetch((request) =>
        request.method === "HEAD" && request.url.pathname.endsWith("/to.txt")
          ? withoutEtag(described())
          : copyProvider()(request),
      );

      return storage().copy("from.txt", "to.txt");
    },
  ],
  [
    "the `HEAD` of `stat`",
    "stat",
    () => {
      stubFetch(() => withoutEtag(described()));

      return storage().stat("to.txt");
    },
  ],
] as const)("%s answered without an `ETag` is `ProviderError`", async (_, operation, act) => {
  const failure = await rejection(act);

  expect(failure).toMatchObject({ code: "ProviderError", operation, key: "to.txt" });
  expect(failure.message).toContain("no entity tag");
});
