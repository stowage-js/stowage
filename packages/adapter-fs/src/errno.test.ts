import { isStorageError, StorageError, type StorageErrorCode } from "@stowage/core";
import { expect, test } from "vitest";

import { asFailure, type FsAccess, fsErrorFrom } from "./errno.ts";

const failure = { root: "/root", operation: "get", access: "read" } as const;

const syscallError = (code: string): Error =>
  Object.assign(new Error(`${code}: it failed, open '/root/object'`), { code });

/** The table of spec 6, read row by row on the side the access names. */
const rows: readonly {
  errno: string;
  access: FsAccess;
  code: StorageErrorCode;
  retryable: boolean;
}[] = [
  { errno: "ENOENT", access: "read", code: "NotFound", retryable: false },
  { errno: "ENOENT", access: "write", code: "NotFound", retryable: false },
  { errno: "EISDIR", access: "read", code: "NotFound", retryable: false },
  { errno: "EISDIR", access: "write", code: "InvalidRequest", retryable: false },
  { errno: "ENOTDIR", access: "read", code: "NotFound", retryable: false },
  { errno: "ENOTDIR", access: "write", code: "InvalidRequest", retryable: false },
  { errno: "EACCES", access: "read", code: "AccessDenied", retryable: false },
  { errno: "EPERM", access: "write", code: "AccessDenied", retryable: false },
  { errno: "ENAMETOOLONG", access: "read", code: "InvalidKey", retryable: false },
  { errno: "EMFILE", access: "read", code: "ProviderError", retryable: true },
  { errno: "EBUSY", access: "write", code: "ProviderError", retryable: true },
  { errno: "EAGAIN", access: "read", code: "ProviderError", retryable: true },
  { errno: "EXDEV", access: "read", code: "ProviderError", retryable: false },
];

test.each(rows)("reports $errno on a $access as $code", ({ errno, access, code, retryable }) => {
  const reported = fsErrorFrom(syscallError(errno), { ...failure, access });

  expect(reported.code).toBe(code);
  expect(reported.retryable).toBe(retryable);
  expect(reported.providerCode).toBe(errno);
});

test("carries the bucket, the operation and the message the syscall reported", () => {
  const thrown = syscallError("ENOENT");
  const reported = fsErrorFrom(thrown, { ...failure, key: "object" });

  expect(reported.bucket).toBe("/root");
  expect(reported.provider).toBe("fs");
  expect(reported.operation).toBe("get");
  expect(reported.key).toBe("object");
  expect(reported.message).toBe(thrown.message);
  expect(reported.cause).toBe(thrown);
  // The adapter sends nothing a second time, so the count is the attempt that failed.
  expect(reported.attempts).toBe(1);
});

test("reports what carries no errno as a ProviderError nothing may repeat", () => {
  const reported = fsErrorFrom("a string nobody threw on purpose", failure);

  expect(reported.code).toBe("ProviderError");
  expect(reported.providerCode).toBeUndefined();
  expect(reported.retryable).toBe(false);
});

test("carries a refusal it already shaped and the runtime's AbortError through", () => {
  const refusal = new StorageError({
    code: "InvalidRequest",
    message: "already shaped",
    operation: "put",
    bucket: "/root",
    provider: "fs",
    attempts: 0,
  });
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });

  expect(asFailure(refusal, failure)).toBe(refusal);
  expect(asFailure(aborted, failure)).toBe(aborted);
  expect(isStorageError(asFailure(syscallError("ENOENT"), failure))).toBe(true);
});
