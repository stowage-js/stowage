import { isStorageError, type StorageError } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import { fromEnv, type S3Credentials, resolveCredentials } from "./credentials.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A `process` standing in for the one the runtime holds, reading through `read`. */
function stubProcessEnv(read: (name: string) => string | undefined): void {
  vi.stubGlobal("process", {
    env: new Proxy({}, { get: (_target, name) => read(String(name)) }),
  });
}

function refusalOf(resolve: () => unknown): StorageError {
  try {
    resolve();
  } catch (failure) {
    if (isStorageError(failure)) return failure;

    throw failure;
  }

  throw new Error("The credential was accepted");
}

const held: S3Credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };

test("a value resolves to itself", async () => {
  expect(await resolveCredentials(held, { forceRefresh: false })).toEqual(held);
});

test("a function is called with what it was asked for", async () => {
  const resolve = vi.fn<() => S3Credentials>(() => held);

  await resolveCredentials(resolve, { forceRefresh: true });

  expect(resolve).toHaveBeenCalledWith({ forceRefresh: true });
});

test("nothing is held between two calls", async () => {
  const answers = [held, { ...held, accessKeyId: "SECOND" }];
  const resolve = vi.fn<() => S3Credentials>(() => answers.shift() ?? held);

  await resolveCredentials(resolve, { forceRefresh: false });

  expect((await resolveCredentials(resolve, { forceRefresh: false })).accessKeyId).toBe("SECOND");
});

test.each(["accessKeyId", "secretAccessKey"])("an empty `%s` is refused by name", async (field) => {
  const failure = await resolveCredentials({ ...held, [field]: "" }, { forceRefresh: false }).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  expect(isStorageError(failure) && failure.code).toBe("InvalidCredentials");
  expect(isStorageError(failure) && failure.message).toContain(field);
  expect(isStorageError(failure) && failure.attempts).toBe(0);
});

test("a field outside the three is refused by name", async () => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the point of the case
  const resolved = { ...held, expiration: "soon" } as S3Credentials;
  const failure = await resolveCredentials(resolved, { forceRefresh: false }).then(
    () => undefined,
    (reason: unknown) => reason,
  );

  expect(isStorageError(failure) && failure.code).toBe("InvalidCredentials");
  expect(isStorageError(failure) && failure.message).toContain("expiration");
});

test("`fromEnv` reads the three variables and nothing else", () => {
  const read: string[] = [];

  stubProcessEnv((name) => {
    read.push(name);

    return { AWS_ACCESS_KEY_ID: "key", AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "t" }[
      name
    ];
  });

  expect(fromEnv()).toEqual({ accessKeyId: "key", secretAccessKey: "secret", sessionToken: "t" });
  expect(read).toEqual(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]);
});

test("`fromEnv` leaves a missing session token absent", () => {
  stubProcessEnv((name) => ({ AWS_ACCESS_KEY_ID: "key", AWS_SECRET_ACCESS_KEY: "secret" })[name]);

  expect(fromEnv()).toEqual({ accessKeyId: "key", secretAccessKey: "secret" });
});

test.each(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"])(
  "an empty `%s` is refused by name",
  (variable) => {
    stubProcessEnv((name) =>
      name === variable ? "" : { AWS_ACCESS_KEY_ID: "key", AWS_SECRET_ACCESS_KEY: "secret" }[name],
    );

    const failure = refusalOf(fromEnv);

    expect(failure.code).toBe("InvalidCredentials");
    expect(failure.message).toContain(variable);
    expect(failure.attempts).toBe(0);
  },
);

// ADR 0007: a Worker without `nodejs_compat` has no `process` at all, and Deno without
// `--allow-env` throws instead of answering `undefined`.
test("a missing `process` leaves the value empty rather than throwing a `ReferenceError`", () => {
  vi.stubGlobal("process", undefined);

  expect(refusalOf(fromEnv).message).toContain("AWS_ACCESS_KEY_ID");
});

test("a refused read leaves the value empty", () => {
  stubProcessEnv((name) => {
    throw new Error(`Requires env access to ${name}`);
  });

  expect(refusalOf(fromEnv).message).toContain("AWS_ACCESS_KEY_ID");
});
