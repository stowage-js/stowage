import { isStorageError, type StorageError } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import { type AzureBlobCredentials, fromEnv, resolveCredentials } from "./credentials.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A `process` standing in for the one the runtime holds, reading through `read`. */
function stubProcessEnv(read: (name: string) => string | undefined): void {
  vi.stubGlobal("process", {
    env: new Proxy({}, { get: (_target, name) => read(String(name)) }),
  });
}

async function refusalOf(credentials: unknown): Promise<StorageError> {
  // oxlint-disable-next-line no-unsafe-type-assertion -- a resolver written in JavaScript
  const resolving = resolveCredentials(credentials as AzureBlobCredentials, {
    forceRefresh: false,
  });
  const failure = await resolving.then(
    () => undefined,
    (reason: unknown) => reason,
  );

  if (isStorageError(failure)) return failure;

  throw new Error(`The credential was not refused: ${String(failure)}`);
}

const accountKey = { accountKey: "c3Rvd2FnZQ==" };
const accessToken = { accessToken: "eyJ0eXAiOiJKV1QifQ.e30." };

test.each([accountKey, accessToken])("%j resolves to itself", async (held) => {
  expect(await resolveCredentials(held, { forceRefresh: false })).toEqual(held);
});

test("a function is called with what it was asked for", async () => {
  const resolve = vi.fn<() => AzureBlobCredentials>(() => accessToken);

  await resolveCredentials(resolve, { forceRefresh: true });

  expect(resolve).toHaveBeenCalledWith({ forceRefresh: true });
});

test("nothing is held between two calls, the form of the credential included", async () => {
  const answers: AzureBlobCredentials[] = [accessToken, accountKey];
  const resolve = vi.fn<() => AzureBlobCredentials>(() => answers.shift() ?? accessToken);

  await resolveCredentials(resolve, { forceRefresh: false });

  expect(await resolveCredentials(resolve, { forceRefresh: false })).toEqual(accountKey);
  expect(resolve).toHaveBeenCalledTimes(2);
});

test.each([
  [{}, "accountKey"],
  [{ ...accountKey, ...accessToken }, "accessToken"],
  [{ ...accessToken, sasToken: "sv=2026-04-06" }, "sasToken"],
  [{ accountKey: "" }, "accountKey"],
  [{ accessToken: "" }, "accessToken"],
  [{ accessToken: 42 }, "accessToken"],
  [{ accountKey: "not base64!" }, "accountKey"],
  [{ accountKey: "=" }, "accountKey"],
])("%j is refused naming `%s`", async (credentials, field) => {
  const failure = await refusalOf(credentials);

  expect(failure.code).toBe("InvalidCredentials");
  expect(failure.message).toContain(field);
  expect(failure.attempts).toBe(0);
  expect(failure.provider).toBe("azure-blob");
});

test("a resolved value that is no object is refused", async () => {
  expect((await refusalOf("key")).code).toBe("InvalidCredentials");
});

test("`fromEnv` reads the account key from `AZURE_STORAGE_KEY`", () => {
  stubProcessEnv((name) => (name === "AZURE_STORAGE_KEY" ? "c3Rvd2FnZQ==" : undefined));

  expect(fromEnv()).toEqual({ accountKey: "c3Rvd2FnZQ==" });
});

test("`fromEnv` refuses an empty `AZURE_STORAGE_KEY` by name", () => {
  stubProcessEnv((name) => (name === "AZURE_STORAGE_KEY" ? "" : undefined));

  let failure: unknown;

  try {
    fromEnv();
  } catch (thrown) {
    failure = thrown;
  }

  expect(isStorageError(failure) && failure.code).toBe("InvalidCredentials");
  expect(isStorageError(failure) && failure.message).toContain("AZURE_STORAGE_KEY");
  expect(isStorageError(failure) && failure.attempts).toBe(0);
});

test("`fromEnv` reads nothing but `AZURE_STORAGE_KEY`", () => {
  const read = vi.fn<(name: string) => string | undefined>(() => "c3Rvd2FnZQ==");

  stubProcessEnv(read);
  fromEnv();

  expect(read.mock.calls.map(([name]) => name)).toEqual(["AZURE_STORAGE_KEY"]);
});
