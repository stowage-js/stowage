import { expect, test } from "vitest";

import type { S3Credentials } from "./credentials.ts";
import { type PresignedRequest, presignRequest, signRequest, type SignedRequest } from "./sign.ts";

/**
 * The published AWS SigV4 test suite, case by case, as `awslabs/aws-c-auth` carries it
 * under `tests/aws-signing-test-suite/v4`. The cases that expect a normalized path are
 * left out and their `-unnormalized` halves taken instead, because S3 signs the path as
 * it stands (spec 7.4).
 */
interface SigV4Vector {
  readonly name: string;
  readonly method: string;
  /** Written as the request line carries it, which the signer is what percent-encodes. */
  readonly path: string;
  readonly query: readonly (readonly [string, string])[];
  readonly headers: readonly (readonly [string, string])[];
  readonly sessionToken?: string;
  readonly payloadHash: string;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

const vectors: readonly SigV4Vector[] = [
  {
    name: "get-vanilla",
    method: "GET",
    path: "/",
    query: [],
    headers: [],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `GET
/

host:example.amazonaws.com
x-amz-date:20150830T123600Z

host;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63`,
    signature: "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  },
  {
    name: "get-unreserved",
    method: "GET",
    path: "/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    query: [],
    headers: [],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `GET
/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz

host:example.amazonaws.com
x-amz-date:20150830T123600Z

host;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
6a968768eefaa713e2a6b16b589a8ea192661f098f37349f4e2c0082757446f9`,
    signature: "07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f",
  },
  {
    name: "get-utf8",
    method: "GET",
    path: "/ሴ",
    query: [],
    headers: [],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `GET
/%E1%88%B4

host:example.amazonaws.com
x-amz-date:20150830T123600Z

host;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
2a0a97d02205e45ce2e994789806b19270cfbbb0921b278ccf58f5249ac42102`,
    signature: "8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85",
  },
  {
    name: "get-space-unnormalized",
    method: "GET",
    path: "/example space/",
    query: [],
    headers: [],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `GET
/example%20space/

host:example.amazonaws.com
x-amz-date:20150830T123600Z

host;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
63ee75631ed7234ae61b5f736dfc7754cdccfedbff4b5128a915706ee9390d86`,
    signature: "652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741",
  },
  {
    name: "get-slashes-unnormalized",
    method: "GET",
    path: "//example//",
    query: [],
    headers: [],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `GET
//example//

host:example.amazonaws.com
x-amz-date:20150830T123600Z

host;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
528ec3105ee1f34ab014bb0a1a45da0ed2742a4fea3555149e5b4d5d201eb240`,
    signature: "87cca117541a147f6df867677d98a7d80dff226d2bfca9e4ffa899665623c7e5",
  },
  {
    name: "get-relative-unnormalized",
    method: "GET",
    path: "/example/..",
    query: [],
    headers: [],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `GET
/example/..

host:example.amazonaws.com
x-amz-date:20150830T123600Z

host;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
0511f456aa502b456d135fcb9d749374a55228f9dbeedda1eacf659e05b0615b`,
    signature: "eca7ead57bb5aa5c8e28007acd4ff04e1ff9a0ff3b237ec1554a184887ff9282",
  },
  {
    name: "get-vanilla-query-order-key-case",
    method: "GET",
    path: "/",
    query: [
      ["Param2", "value2"],
      ["Param1", "value1"],
    ],
    headers: [],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `GET
/
Param1=value1&Param2=value2
host:example.amazonaws.com
x-amz-date:20150830T123600Z

host;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0`,
    signature: "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
  },
  {
    name: "get-vanilla-query-order-encoded",
    method: "GET",
    path: "/",
    query: [
      ["Param-3", "Value3"],
      ["Param", "Value2"],
      ["ሴ", "Value1"],
    ],
    headers: [],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `GET
/
%E1%88%B4=Value1&Param=Value2&Param-3=Value3
host:example.amazonaws.com
x-amz-date:20150830T123600Z

host;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
868294f5c38bd141c4972a373a76654f1418a8e4fc18b2e7903ae45e8ae0ec71`,
    signature: "371d3713e185cc334048618a97f809c9ffe339c62934c032af5a0e595648fcac",
  },
  {
    name: "get-vanilla-query-unreserved",
    method: "GET",
    path: "/",
    query: [
      [
        "-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
        "-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
      ],
    ],
    headers: [],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `GET
/
-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz=-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz
host:example.amazonaws.com
x-amz-date:20150830T123600Z

host;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
c30d4703d9f799439be92736156d47ccfb2d879ddf56f5befa6d1d6aab979177`,
    signature: "9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197",
  },
  {
    name: "get-vanilla-utf8-query",
    method: "GET",
    path: "/",
    query: [["ሴ", "bar"]],
    headers: [],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `GET
/
%E1%88%B4=bar
host:example.amazonaws.com
x-amz-date:20150830T123600Z

host;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
eb30c5bed55734080471a834cc727ae56beb50e5f39d1bff6d0d38cb192a7073`,
    signature: "2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04",
  },
  {
    name: "get-vanilla-with-session-token",
    method: "GET",
    path: "/",
    query: [],
    headers: [],
    sessionToken: "6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267",
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `GET
/

host:example.amazonaws.com
x-amz-date:20150830T123600Z
x-amz-security-token:6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267

host;x-amz-date;x-amz-security-token
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
067b36aa60031588cea4a4cde1f21215227a047690c72247f1d70b32fbbfad2b`,
    signature: "07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8",
  },
  {
    name: "get-header-key-duplicate",
    method: "GET",
    path: "/",
    query: [],
    headers: [
      ["My-Header1", "value2"],
      ["My-Header1", "value2"],
      ["My-Header1", "value1"],
    ],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `GET
/

host:example.amazonaws.com
my-header1:value2,value2,value1
x-amz-date:20150830T123600Z

host;my-header1;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
dc7f04a3abfde8d472b0ab1a418b741b7c67174dad1551b4117b15527fbe966c`,
    signature: "c9d5ea9f3f72853aea855b47ea873832890dbdd183b4468f858259531a5138ea",
  },
  {
    name: "get-header-value-order",
    method: "GET",
    path: "/",
    query: [],
    headers: [
      ["My-Header1", "value4"],
      ["My-Header1", "value1"],
      ["My-Header1", "value3"],
      ["My-Header1", "value2"],
    ],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `GET
/

host:example.amazonaws.com
my-header1:value4,value1,value3,value2
x-amz-date:20150830T123600Z

host;my-header1;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
31ce73cd3f3d9f66977ad3dd957dc47af14df92fcd8509f59b349e9137c58b86`,
    signature: "08c7e5a9acfcfeb3ab6b2185e75ce8b1deb5e634ec47601a50643f830c755c01",
  },
  {
    name: "get-header-value-trim",
    method: "GET",
    path: "/",
    query: [],
    headers: [
      ["My-Header1", " value1"],
      ["My-Header2", ' "a   b   c"'],
    ],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `GET
/

host:example.amazonaws.com
my-header1:value1
my-header2:"a b c"
x-amz-date:20150830T123600Z

host;my-header1;my-header2;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
a726db9b0df21c14f559d0a978e563112acb1b9e05476f0a6a1c7d68f28605c7`,
    signature: "acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736",
  },
  {
    name: "post-vanilla-query",
    method: "POST",
    path: "/",
    query: [["Param1", "value1"]],
    headers: [],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `POST
/
Param1=value1
host:example.amazonaws.com
x-amz-date:20150830T123600Z

host;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
9d659678c1756bb3113e2ce898845a0a79dbbc57b740555917687f1b3340fbbd`,
    signature: "28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11",
  },
  {
    name: "post-header-value-case",
    method: "POST",
    path: "/",
    query: [],
    headers: [["My-Header1", "VALUE1"]],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: `POST
/

host:example.amazonaws.com
my-header1:VALUE1
x-amz-date:20150830T123600Z

host;my-header1;x-amz-date
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
d51ced243e649e3de6ef63afbbdcbca03131a21a7103a1583706a64618606a93`,
    signature: "cdbc9802e29d2942e5e10b5bccfdd67c5f22c7c4e8ae67b53629efa58b974b7d",
  },
  {
    name: "post-x-www-form-urlencoded",
    method: "POST",
    path: "/",
    query: [],
    headers: [
      ["Content-Type", "application/x-www-form-urlencoded"],
      ["Content-Length", "13"],
      ["x-amz-content-sha256", "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e"],
    ],
    payloadHash: "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
    canonicalRequest: `POST
/

content-length:13
content-type:application/x-www-form-urlencoded
host:example.amazonaws.com
x-amz-content-sha256:9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e
x-amz-date:20150830T123600Z

content-length;content-type;host;x-amz-content-sha256;x-amz-date
9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e`,
    stringToSign: `AWS4-HMAC-SHA256
20150830T123600Z
20150830/us-east-1/service/aws4_request
b1edd1d03544c25390e32085d55b57acc9a3961bb59415ff86c45c3d89d16cfb`,
    signature: "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
  },
];

const vectorCredentials: S3Credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

const vectorDate = new Date("2015-08-30T12:36:00Z");

async function signVector(vector: SigV4Vector): Promise<SignedRequest> {
  return await signRequest({
    method: vector.method,
    host: "example.amazonaws.com",
    path: vector.path,
    query: vector.query,
    headers: vector.headers,
    payloadHash: vector.payloadHash,
    credentials:
      vector.sessionToken === undefined
        ? vectorCredentials
        : { ...vectorCredentials, sessionToken: vector.sessionToken },
    region: "us-east-1",
    service: "service",
    date: vectorDate,
  });
}

test.each(vectors)("$name builds the canonical request the suite states", async (vector) => {
  expect((await signVector(vector)).canonicalRequest).toBe(vector.canonicalRequest);
});

test.each(vectors)("$name builds the string to sign the suite states", async (vector) => {
  expect((await signVector(vector)).stringToSign).toBe(vector.stringToSign);
});

test.each(vectors)("$name signs as the suite states", async (vector) => {
  expect((await signVector(vector)).signature).toBe(vector.signature);
});

test.each(vectors)("$name carries the authorization the suite states", async (vector) => {
  const signedHeaders = vector.canonicalRequest.split("\n").at(-2);
  const signed = await signVector(vector);
  const authorization = new Map(signed.headers).get("authorization");

  expect(authorization).toBe(
    "AWS4-HMAC-SHA256 " +
      "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
      `SignedHeaders=${signedHeaders}, Signature=${vector.signature}`,
  );
});

test("the headers it hands back carry what it signed beside what it was given", async () => {
  const signed = await signVector({
    name: "one request",
    method: "PUT",
    path: "/object.txt",
    query: [],
    headers: [["content-type", "text/plain"]],
    sessionToken: "token",
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    canonicalRequest: "",
    stringToSign: "",
    signature: "",
  });

  expect(Object.fromEntries(signed.headers)).toMatchObject({
    "content-type": "text/plain",
    "x-amz-date": "20150830T123600Z",
    "x-amz-security-token": "token",
  });
});

// `fetch` sets `Host` from the URL and refuses the header, so the signature covers a
// name the request never carries.
test("it signs `host` without handing it back as a header to send", async () => {
  const [vanilla] = vectors;

  if (vanilla === undefined) throw new Error("The suite carries no vector");

  const signed = await signVector(vanilla);

  expect(signed.canonicalRequest).toContain("host:example.amazonaws.com");
  expect(new Map(signed.headers).has("host")).toBe(false);
});

/**
 * The query-signing example of the S3 API reference ("Authenticating Requests: Using
 * Query Parameters"), which AWS removed from the live reference and ADR 0011 cites from
 * an Internet Archive capture: a `GET` on `test.txt`, valid for 86400 seconds.
 */
const queryVector = {
  credentials: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
  canonicalRequest: `GET
/test.txt
X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host
host:examplebucket.s3.amazonaws.com

host
UNSIGNED-PAYLOAD`,
  stringToSign: `AWS4-HMAC-SHA256
20130524T000000Z
20130524/us-east-1/s3/aws4_request
3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04`,
  signature: "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
} as const;

async function presignQueryVector(
  overrides: { headers?: readonly (readonly [string, string])[]; sessionToken?: string } = {},
): Promise<PresignedRequest> {
  return await presignRequest({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    query: [],
    headers: overrides.headers ?? [],
    credentials:
      overrides.sessionToken === undefined
        ? queryVector.credentials
        : { ...queryVector.credentials, sessionToken: overrides.sessionToken },
    region: "us-east-1",
    service: "s3",
    date: new Date("2013-05-24T00:00:00Z"),
    expiresIn: 86_400,
  });
}

test("a presigned request builds the canonical request the reference states", async () => {
  expect((await presignQueryVector()).canonicalRequest).toBe(queryVector.canonicalRequest);
});

test("a presigned request builds the string to sign the reference states", async () => {
  expect((await presignQueryVector()).stringToSign).toBe(queryVector.stringToSign);
});

test("a presigned request carries the signature the reference states", async () => {
  const presigned = await presignQueryVector();

  expect(presigned.query.at(-1)).toEqual(["X-Amz-Signature", queryVector.signature]);
});

test("a presigned request signs the headers it binds beside `host`", async () => {
  const presigned = await presignQueryVector({
    headers: [
      ["content-type", "text/plain"],
      ["content-length", "12"],
    ],
  });

  expect(new Map(presigned.query).get("X-Amz-SignedHeaders")).toBe(
    "content-length;content-type;host",
  );
  expect(presigned.canonicalRequest).toContain(
    "content-length:12\ncontent-type:text/plain\nhost:examplebucket.s3.amazonaws.com\n",
  );
});

// The session token goes into the query it signs rather than into a header, because
// whoever calls the URL sends no header the signer chose.
test("a presigned request signs the session token into its query", async () => {
  const presigned = await presignQueryVector({ sessionToken: "token" });

  expect(new Map(presigned.query).get("X-Amz-Security-Token")).toBe("token");
  expect(presigned.canonicalRequest).toContain("X-Amz-Security-Token=token");
});
