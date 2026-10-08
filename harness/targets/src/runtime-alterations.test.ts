import { describe, expect, test } from "vitest";

import { noLengthOnStream } from "./runtime-alterations.ts";

const restoredLength = async (
  method: string,
  answer: Response,
): Promise<string | null | undefined> =>
  (await noLengthOnStream.restore(method, answer))?.get("content-length");

describe("noLengthOnStream", () => {
  test("gives a `206` the length of the range its `Content-Range` names", async () => {
    const answer = new Response("2345", {
      status: 206,
      headers: { "content-range": "bytes 2-5/16" },
    });

    expect(await restoredLength("GET", answer)).toBe("4");
  });

  test("gives a `200` the length of its body, which it still hands over", async () => {
    const answer = new Response("0123456789abcdef");
    const headers = await noLengthOnStream.restore("GET", answer);

    expect(headers?.get("content-length")).toBe("16");
    expect(await answer.text()).toBe("0123456789abcdef");
  });

  test.each([
    [
      "a `200` carrying a length",
      "GET",
      new Response("abc", { headers: { "content-length": "3" } }),
    ],
    ["a `HEAD`", "HEAD", new Response(null)],
    ["a `304`", "GET", new Response(null, { status: 304 })],
  ])("leaves %s as it came", async (_, method, answer) => {
    expect(await noLengthOnStream.restore(method, answer)).toBeUndefined();
  });
});
