import { expect, test } from "vitest";

import { errorCodeForStatus, isTransientStatus } from "./status.ts";

test("a status a response succeeded with decides no code", () => {
  expect(errorCodeForStatus(200)).toBeUndefined();
  expect(errorCodeForStatus(206)).toBeUndefined();
});

test.each([
  [401, "InvalidCredentials"],
  [403, "AccessDenied"],
  [404, "NotFound"],
])("%i is %s", (status, code) => {
  expect(errorCodeForStatus(status)).toBe(code);
});

test.each([301, 400, 408, 429, 500, 503])("%i falls to `ProviderError`", (status) => {
  expect(errorCodeForStatus(status)).toBe("ProviderError");
});

test.each([408, 429, 500, 503, 599])("%i is transient", (status) => {
  expect(isTransientStatus(status)).toBe(true);
});

test.each([200, 301, 400, 403, 404, 600])("%i is not transient", (status) => {
  expect(isTransientStatus(status)).toBe(false);
});
