import { expect, test } from "vitest";

import { readProviderFailure } from "./provider-code.ts";

// The table of spec 7.9, row by row, with the status the provider answers each code at.
test.each([
  ["NoSuchKey", 404, "NotFound"],
  ["NoSuchBucket", 404, "NotFound"],
  ["AccessDenied", 403, "AccessDenied"],
  ["InvalidAccessKeyId", 403, "InvalidCredentials"],
  ["SignatureDoesNotMatch", 403, "InvalidCredentials"],
  ["Unauthorized", 401, "InvalidCredentials"],
  ["ExpiredToken", 403, "Expired"],
  ["ExpiredRequest", 403, "Expired"],
  ["RequestTimeTooSkewed", 403, "InvalidRequest"],
  ["InvalidRange", 416, "InvalidRequest"],
  ["MetadataTooLarge", 400, "InvalidRequest"],
  ["EntityTooLarge", 400, "InvalidRequest"],
  ["EntityTooSmall", 400, "InvalidRequest"],
  ["InvalidPart", 400, "InvalidRequest"],
  ["InvalidPartOrder", 400, "InvalidRequest"],
  ["BadDigest", 400, "InvalidRequest"],
  ["MalformedXML", 400, "InvalidRequest"],
  ["InvalidDigest", 400, "InvalidRequest"],
  ["InvalidObjectName", 400, "InvalidKey"],
  ["KeyTooLongError", 400, "InvalidKey"],
  ["NoSuchUpload", 404, "ProviderError"],
  ["SlowDown", 503, "ProviderError"],
  ["TooManyRequests", 429, "ProviderError"],
  ["ServiceUnavailable", 503, "ProviderError"],
  ["InternalError", 500, "ProviderError"],
  ["RequestTimeout", 408, "ProviderError"],
])("`%s` at %i is `%s`", (providerCode, status, code) => {
  expect(readProviderFailure(providerCode, status, "get")).toEqual({ code });
});

test("a provider code the table does not hold falls to the status", () => {
  expect(readProviderFailure("SomethingNewEntirely", 403, "get")).toEqual({
    code: "AccessDenied",
  });
  expect(readProviderFailure(undefined, 404, "stat")).toEqual({ code: "NotFound" });
  expect(readProviderFailure(undefined, 418, "get")).toEqual({ code: "ProviderError" });
});

// Spec 7.9: the provider refusing the continuation token is the `cursor` the caller
// handed `list`, and nothing else the same code answers is one.
test("`InvalidArgument` names `cursor` where a listing asked and not elsewhere", () => {
  expect(readProviderFailure("InvalidArgument", 400, "list")).toEqual({
    code: "InvalidOption",
    option: "cursor",
  });
  expect(readProviderFailure("InvalidArgument", 400, "put")).toEqual({ code: "InvalidRequest" });
});

// Spec 7.1: a `HEAD` that meets the redirect carries no body to read the code out of.
test.each([
  ["PermanentRedirect", 301],
  [undefined, 301],
  ["PermanentRedirect", 400],
])("%s at %i names `region`", (providerCode, status) => {
  expect(readProviderFailure(providerCode, status, "get")).toEqual({
    code: "InvalidOption",
    option: "region",
  });
});
