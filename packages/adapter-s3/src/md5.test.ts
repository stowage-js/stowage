import { expect, test } from "vitest";

import { md5Base64 } from "./md5.ts";

const utf8 = new TextEncoder();

/** The hex digests of RFC 1321, appendix A.5. */
const suite: readonly (readonly [string, string])[] = [
  ["", "d41d8cd98f00b204e9800998ecf8427e"],
  ["a", "0cc175b9c0f1b6a831c399e269772661"],
  ["abc", "900150983cd24fb0d6963f7d28e17f72"],
  ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
  ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
  [
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    "d174ab98d277d9f5a5611c2c9f419d9f",
  ],
  [
    "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
    "57edf4a22be3c955ac49da2e2107b67a",
  ],
];

function base64OfHex(digest: string): string {
  return btoa(
    String.fromCharCode(...(digest.match(/../g) ?? []).map((pair) => parseInt(pair, 16))),
  );
}

test.each(suite)("the digest of %j is the one RFC 1321 lists", (message, digest) => {
  expect(md5Base64(utf8.encode(message))).toBe(base64OfHex(digest));
});

test("a message filling the last block to the length field pads into another block", () => {
  // 56 bytes leave no room for the length in the block they end, so it spills over.
  expect(md5Base64(utf8.encode("a".repeat(56)))).toBe(
    base64OfHex("3b0c8ac703f828b04c6c197006d17218"),
  );
});
