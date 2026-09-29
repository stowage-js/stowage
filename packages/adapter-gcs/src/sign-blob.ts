import type { Resolvable } from "@stowage/core";

import { type AnsweredRequest, malformedAnswer, readAnswerJson } from "./answer.ts";
import type { GcsConfiguration } from "./configuration.ts";
import type { GcsCredentials } from "./credentials.ts";
import { fieldOf } from "./json.ts";
import { bytesOfBase64 } from "./private-key.ts";
import { encodeSegment, send } from "./request.ts";
import type { Sign } from "./signed-url.ts";

const iamCredentialsOrigin = "https://iamcredentials.googleapis.com";

const utf8 = new TextEncoder();

/** Who `signBlob` signs as, under whose token, for which call of the storage. */
export interface BlobSigning {
  readonly serviceAccount: string;
  readonly credentials: Resolvable<GcsCredentials>;
  readonly operation: string;
  readonly key: string;
}

/**
 * Spec 9.9: one `signBlob` of the IAM Credentials API per URL, kept nowhere. It is an ordinary
 * request of the adapter under spec 9.3 and 9.5, carrying the signer's token rather than the
 * storage's, and it addresses the service account under `projects/-`, since the adapter knows
 * no project (ADR 0033).
 */
export function signBlobAs(configuration: GcsConfiguration, signing: BlobSigning): Sign {
  // `@` is left as it stands: a path segment may hold it, and Google's clients send it so.
  const account = encodeSegment(signing.serviceAccount).replaceAll("%40", "@");

  return async (bytes) => {
    const response = await send(configuration, {
      method: "POST",
      operation: signing.operation,
      origin: iamCredentialsOrigin,
      credentials: signing.credentials,
      key: signing.key,
      path: `/v1/projects/-/serviceAccounts/${account}:signBlob`,
      headers: [["content-type", "application/json"]],
      body: utf8.encode(JSON.stringify({ payload: base64Of(bytes) })),
    });
    const answered: AnsweredRequest = {
      bucket: configuration.bucket,
      operation: signing.operation,
      key: signing.key,
      subject: "the request to `signBlob`",
      response,
    };
    const signedBlob = fieldOf(await readAnswerJson(answered), "signedBlob");

    if (typeof signedBlob !== "string" || signedBlob === "") {
      throw malformedAnswer(answered, "no `signedBlob`");
    }

    try {
      return bytesOfBase64(signedBlob);
    } catch (failure) {
      throw malformedAnswer(answered, "a `signedBlob` that is no base64", failure);
    }
  };
}

function base64Of(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
