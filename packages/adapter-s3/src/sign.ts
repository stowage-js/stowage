import {
  canonicalHeaders,
  encodePath,
  encodeQuery,
  type HeaderField,
  type QueryParameter,
} from "./canonical.ts";
import type { S3Credentials } from "./credentials.ts";
import { hex, hmacSha256, sha256Hex } from "./hash.ts";

export const signingAlgorithm = "AWS4-HMAC-SHA256";

export interface SignableRequest {
  readonly method: string;
  readonly host: string;
  /** Written as the request carries it; `encodePath` is what percent-encodes it. */
  readonly path: string;
  readonly query: readonly QueryParameter[];
  /** What the request carries beside `host`, `x-amz-date` and the session token. */
  readonly headers: readonly HeaderField[];
  readonly payloadHash: string;
  readonly credentials: S3Credentials;
  readonly region: string;
  /** `"s3"` for every request the adapter sends; the published vectors sign `"service"`. */
  readonly service: string;
  readonly date: Date;
}

export interface SignedRequest {
  /** What to send. `host` is signed and left out: `fetch` sets it from the URL. */
  readonly headers: readonly HeaderField[];
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

export async function signRequest(request: SignableRequest): Promise<SignedRequest> {
  const amzDate = amzDateOf(request.date);
  const scope = `${amzDate.slice(0, 8)}/${request.region}/${request.service}/aws4_request`;
  const toSend: readonly HeaderField[] = [
    ...request.headers,
    ["x-amz-date", amzDate],
    ...sessionTokenField(request.credentials),
  ];
  const canonical = canonicalHeaders([...toSend, ["host", request.host]]);
  const canonicalRequest = [
    request.method,
    encodePath(request.path),
    encodeQuery(request.query),
    canonical.lines,
    canonical.names,
    request.payloadHash,
  ].join("\n");
  const stringToSign = [signingAlgorithm, amzDate, scope, await sha256Hex(canonicalRequest)].join(
    "\n",
  );
  const signature = hex(
    await hmacSha256(await signingKey(request, amzDate.slice(0, 8)), stringToSign),
  );
  const authorization =
    `${signingAlgorithm} Credential=${request.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${canonical.names}, Signature=${signature}`;

  return {
    headers: [...toSend, ["authorization", authorization]],
    canonicalRequest,
    stringToSign,
    signature,
  };
}

/** `20150830T123600Z`, which is what `x-amz-date` and the credential scope are written in. */
export function amzDateOf(date: Date): string {
  return `${date.toISOString().replaceAll(/[.:-]/gu, "").slice(0, 15)}Z`;
}

function sessionTokenField(credentials: S3Credentials): readonly HeaderField[] {
  if (credentials.sessionToken === undefined) return [];

  return [["x-amz-security-token", credentials.sessionToken]];
}

async function signingKey(request: SignableRequest, dateStamp: string): Promise<ArrayBuffer> {
  const utf8 = new TextEncoder();
  const date = await hmacSha256(
    utf8.encode(`AWS4${request.credentials.secretAccessKey}`),
    dateStamp,
  );
  const region = await hmacSha256(date, request.region);
  const service = await hmacSha256(region, request.service);

  return await hmacSha256(service, "aws4_request");
}
