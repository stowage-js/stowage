import { isStorageError, type StorageError } from "@stowage/core";
import { expect, test, vi } from "vitest";

import { type GcsCredentials, resolveCredentials } from "./credentials.ts";

async function refusalOf(credentials: unknown): Promise<StorageError> {
  // oxlint-disable-next-line no-unsafe-type-assertion -- a resolver written in JavaScript
  const resolving = resolveCredentials(credentials as GcsCredentials, { forceRefresh: false });
  const failure = await resolving.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  if (isStorageError(failure)) return failure;

  throw new Error(`The credential was not refused: ${String(failure)}`);
}

const accessToken = { accessToken: "ya29.a0AfB_byC" };

test("a held token resolves to itself", async () => {
  expect(await resolveCredentials(accessToken, { forceRefresh: false })).toEqual(accessToken);
});

test("a function is called with what it was asked for", async () => {
  const resolve = vi.fn<() => GcsCredentials>(() => accessToken);

  await resolveCredentials(resolve, { forceRefresh: false });

  expect(resolve).toHaveBeenCalledWith({ forceRefresh: false });
});

test("nothing is held between two calls", async () => {
  const answers: GcsCredentials[] = [accessToken, { accessToken: "ya29.renewed" }];
  const resolve = vi.fn<() => GcsCredentials>(() => answers.shift() ?? accessToken);

  await resolveCredentials(resolve, { forceRefresh: false });

  expect(await resolveCredentials(resolve, { forceRefresh: false })).toEqual({
    accessToken: "ya29.renewed",
  });
  expect(resolve).toHaveBeenCalledTimes(2);
});

test("a token that looks like no JWT is not parsed and passes", async () => {
  expect(await resolveCredentials({ accessToken: "not-a-jwt" }, { forceRefresh: false })).toEqual({
    accessToken: "not-a-jwt",
  });
});

test.each([
  [{}, "accessToken"],
  [{ accessToken: "" }, "accessToken"],
  [{ accessToken: 42 }, "accessToken"],
  [{ ...accessToken, projectId: "stowage-conformance" }, "projectId"],
  [{ ...accessToken, accountKey: "c3Rvd2FnZQ==" }, "accountKey"],
])("%j is refused, naming `%s`", async (credentials, field) => {
  const refusal = await refusalOf(credentials);

  expect(refusal.code).toBe("InvalidCredentials");
  expect(refusal.message).toContain(`\`${field}\``);
  expect(refusal.attempts).toBe(0);
  expect(refusal.provider).toBe("gcs");
});

test.each([[null], ["ya29.a0AfB_byC"]])("%j is no credential at all", async (credentials) => {
  const refusal = await refusalOf(credentials);

  expect(refusal.code).toBe("InvalidCredentials");
  expect(refusal.attempts).toBe(0);
});

test("the refusal never carries the token it refused", async () => {
  const refusal = await refusalOf({ accessToken: "ya29.secret", extra: "field" });

  expect(refusal.message).not.toContain("ya29.secret");
});

test("a resolver's own failure travels on untouched", async () => {
  const failure = new Error("the metadata server is unreachable");

  await expect(
    resolveCredentials(
      () => {
        throw failure;
      },
      { forceRefresh: false },
    ),
  ).rejects.toBe(failure);
});
