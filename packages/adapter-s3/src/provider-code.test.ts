import { expect, test } from "vitest";

import { type ProviderAnswer, type ProviderFailure, readProviderFailure } from "./provider-code.ts";

/** One answer, with the two fields every case here fixes filled in. */
function answered(answer: Partial<ProviderAnswer> & { status: number }): ProviderFailure {
  return readProviderFailure({ operation: "get", method: "GET", ...answer });
}

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
  ["InvalidRequest", 400, "InvalidRequest"],
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
  expect(answered({ providerCode, status })).toMatchObject({ code });
});

test("a provider code the table does not hold falls to the status", () => {
  expect(answered({ providerCode: "SomethingNewEntirely", status: 403 }).code).toBe("AccessDenied");
  expect(answered({ status: 404, operation: "stat" }).code).toBe("NotFound");
  expect(answered({ status: 418 }).code).toBe("ProviderError");
});

// Spec 4.10: the provider's message travels word for word, and the status is what a
// `HEAD` leaves as the whole of what there is to say.
test("the message is the provider's, or the status where it sent none", () => {
  expect(
    answered({ status: 404, providerMessage: "The specified key does not exist." }).message,
  ).toBe("The specified key does not exist.");
  expect(answered({ status: 404, method: "HEAD" }).message).toBe(
    "The provider answered 404 to `HEAD`",
  );
});

// Spec 7.9: the provider refusing the continuation token is the `cursor` the caller
// handed `list`, and nothing else the same code answers is one.
test("`InvalidArgument` names `cursor` where a continued listing asked and not elsewhere", () => {
  const listing = answered({
    providerCode: "InvalidArgument",
    status: 400,
    operation: "list",
    hasContinuationToken: true,
  });

  expect(listing.code).toBe("InvalidOption");
  expect(listing.message).toContain("`cursor`");
  expect(answered({ providerCode: "InvalidArgument", status: 400, operation: "list" }).code).toBe(
    "InvalidRequest",
  );
  expect(answered({ providerCode: "InvalidArgument", status: 400, operation: "put" }).code).toBe(
    "InvalidRequest",
  );
});

// Spec 7.1: a `HEAD` that meets the redirect carries no body to read the code out of.
test.each([
  ["PermanentRedirect", 301],
  [undefined, 301],
  ["PermanentRedirect", 400],
])("%s at %i names `region`", (providerCode, status) => {
  const failure = answered({ providerCode, status, bucketRegion: "eu-west-1" });

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("`region`");
  expect(failure.message).toContain("eu-west-1");
});
