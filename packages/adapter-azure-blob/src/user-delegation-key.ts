import { answeredRequest, malformedAnswer, parseAnswer, readAnswerText } from "./answer.ts";
import type { AzureBlobConfiguration } from "./configuration.ts";
import { send } from "./request.ts";
import type { UserDelegationKey } from "./sas.ts";
import { inStorage } from "./storage-error.ts";

/**
 * Spec 8.9: one `Get User Delegation Key` for one presigned URL, valid from `start` to
 * `expiry`, and kept nowhere (ADR 0022). It is an ordinary request under spec 8.3 and 8.5,
 * so it is repeated as every other one is. The service answers it under a bearer token
 * alone, and the refusal of a principal without `generateUserDelegationKey` is
 * `AuthorizationPermissionMismatch`, which spec 8.8 maps to `AccessDenied`.
 */
export async function requestUserDelegationKey(
  configuration: AzureBlobConfiguration,
  window: { readonly start: string; readonly expiry: string },
  operation: string,
  key: string,
): Promise<UserDelegationKey> {
  const subject = "the request for a user delegation key";
  const response = await send(configuration, {
    method: "POST",
    operation,
    toService: true,
    query: [
      ["restype", "service"],
      ["comp", "userdelegationkey"],
    ],
    headers: [["content-type", "application/xml"]],
    body: new TextEncoder().encode(
      `<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>${window.start}</Start><Expiry>${window.expiry}</Expiry></KeyInfo>`,
    ),
  }).catch((failure: unknown) => {
    // The request addresses the account and not the key, so the key the URL was asked
    // for is named on the failure here.
    throw inStorage(failure, configuration.container, operation, key);
  });
  const answered = answeredRequest(configuration.container, operation, subject, response);
  const root = parseAnswer(answered, await readAnswerText(answered, response));

  if (root.name !== "UserDelegationKey") {
    throw malformedAnswer(answered, `a <${root.name}> where a <UserDelegationKey> belongs`);
  }

  const field = (name: string): string => {
    const text = root.children.find((child) => child.name === name)?.text;

    if (text === undefined || text === "") throw malformedAnswer(answered, `no <${name}>`);

    return text;
  };

  return {
    signedOid: field("SignedOid"),
    signedTid: field("SignedTid"),
    signedStart: field("SignedStart"),
    signedExpiry: field("SignedExpiry"),
    signedService: field("SignedService"),
    signedVersion: field("SignedVersion"),
    value: field("Value"),
  };
}
