import { expect, test } from "vitest";

import {
  batchBody,
  type BatchSubresponse,
  readSubresponses,
  type SubresponseReading,
} from "./batch.ts";

const asSent = (contentId: string) => contentId;

function subresponsesIn(reading: SubresponseReading): readonly BatchSubresponse[] {
  if (!("subresponses" in reading)) throw new Error(`Unread: ${JSON.stringify(reading)}`);

  return reading.subresponses;
}

test("the body carries each subrequest as an HTTP request numbered by its place in the batch", () => {
  const body = batchBody("batch_b", [
    {
      method: "DELETE",
      path: "/c/a%20b",
      headers: [["x-ms-date", "Tue, 29 Sep 2026 10:00:00 GMT"]],
    },
    { method: "DELETE", path: "/c/d", headers: [] },
  ]);

  expect(new TextDecoder().decode(body)).toBe(
    "--batch_b\r\n" +
      "Content-Type: application/http\r\n" +
      "Content-Transfer-Encoding: binary\r\n" +
      "Content-ID: 0\r\n\r\n" +
      "DELETE /c/a%20b HTTP/1.1\r\n" +
      "x-ms-date: Tue, 29 Sep 2026 10:00:00 GMT\r\n" +
      "Content-Length: 0\r\n\r\n\r\n" +
      "--batch_b\r\n" +
      "Content-Type: application/http\r\n" +
      "Content-Transfer-Encoding: binary\r\n" +
      "Content-ID: 1\r\n\r\n" +
      "DELETE /c/d HTTP/1.1\r\n" +
      "Content-Length: 0\r\n\r\n\r\n" +
      "--batch_b--\r\n",
  );
});

test("a subrequest's head keeps its blank line, since the line break before a delimiter is the delimiter's", () => {
  const body = new TextDecoder().decode(
    batchBody("batch_b", [{ method: "DELETE", path: "/c/d", headers: [] }]),
  );
  const [part] = body.split("\r\n--batch_b--");

  expect(part).toMatch(/Content-Length: 0\r\n\r\n$/u);
});

test("the subresponses come back in the order of the subrequests, paired by `Content-ID`", () => {
  const reading = readSubresponses(
    "multipart/mixed; boundary=batchresponse_1",
    "--batchresponse_1\r\n" +
      "Content-Type: application/http\r\n" +
      "Content-ID: 1\r\n\r\n" +
      "HTTP/1.1 404 The specified blob does not exist.\r\n" +
      "x-ms-error-code: BlobNotFound\r\n" +
      "Content-Type: application/xml\r\n\r\n" +
      "<Error><Code>BlobNotFound</Code></Error>\r\n" +
      "--batchresponse_1\r\n" +
      "Content-Type: application/http\r\n" +
      "Content-ID: 0\r\n\r\n" +
      "HTTP/1.1 202 Accepted\r\n" +
      "x-ms-delete-type-permanent: true\r\n\r\n\r\n" +
      "--batchresponse_1--\r\n",
    2,
    asSent,
  );

  const subresponses = subresponsesIn(reading);
  const [first, second] = subresponses;

  expect(subresponses).toHaveLength(2);
  expect(first).toMatchObject({ contentId: "0", status: 202, body: "" });
  expect(first?.headers.get("x-ms-delete-type-permanent")).toBe("true");
  expect(second).toMatchObject({
    contentId: "1",
    status: 404,
    body: "<Error><Code>BlobNotFound</Code></Error>",
  });
  expect(second?.headers.get("x-ms-error-code")).toBe("BlobNotFound");
});

const behindResponse = (contentId: string) => `response-${contentId}`;

/** How GCS answers a batch: lines ending in LF, and each bare `Content-ID` echoed behind `response-`. */
const gcsAnswer =
  "--batch_pK7JBAk73-E=_AA5eFwv4m2Q=\n" +
  "Content-Type: application/http\n" +
  "Content-ID: response-0\n\n" +
  "HTTP/1.1 204 No Content\n" +
  "Content-Length: 0\n\n\n" +
  "--batch_pK7JBAk73-E=_AA5eFwv4m2Q=\n" +
  "Content-Type: application/http\n" +
  "Content-ID: response-1\n\n" +
  "HTTP/1.1 404 Not Found\n" +
  "Content-Type: application/json; charset=UTF-8\n\n" +
  '{"error":{"code":404,"message":"No such object: b/a"}}\n' +
  "--batch_pK7JBAk73-E=_AA5eFwv4m2Q=--\n";

test.each([
  ["bare", "multipart/mixed; boundary=batch_pK7JBAk73-E=_AA5eFwv4m2Q="],
  ["quoted", 'multipart/mixed; boundary="batch_pK7JBAk73-E=_AA5eFwv4m2Q="'],
])("an answer in LF lines under a %s boundary is read", (_label, contentType) => {
  const reading = readSubresponses(contentType, gcsAnswer, 2, behindResponse);

  const subresponses = subresponsesIn(reading);

  expect(subresponses.map(({ contentId, status }) => [contentId, status])).toEqual([
    ["response-0", 204],
    ["response-1", 404],
  ]);
  expect(subresponses[0]?.body).toBe("");
  expect(subresponses[1]?.headers.get("content-type")).toBe("application/json; charset=UTF-8");
  expect(subresponses[1]?.body).toBe('{"error":{"code":404,"message":"No such object: b/a"}}');
});

test("a `Content-ID` in another form than the one the adapter names is unexpected", () => {
  expect(
    readSubresponses(
      "multipart/mixed; boundary=batch_pK7JBAk73-E=_AA5eFwv4m2Q=",
      gcsAnswer,
      2,
      asSent,
    ),
  ).toEqual({
    unreadable: 'an answer for unexpected Content-ID "response-0"',
  });
});

const accepted = (contentId: string) =>
  `--b\r\nContent-Type: application/http\r\nContent-ID: ${contentId}\r\n\r\nHTTP/1.1 202 Accepted\r\n\r\n\r\n`;

test.each<[string, string | null, string, string]>([
  ["no Content-Type", null, `${accepted("0")}--b--\r\n`, "an answer that is no batch of responses"],
  [
    "no boundary",
    "multipart/mixed",
    `${accepted("0")}--b--\r\n`,
    "an answer that is no batch of responses",
  ],
  [
    "no closing boundary",
    "multipart/mixed; boundary=b",
    accepted("0"),
    "an answer that is no batch of responses",
  ],
  [
    "a part without `Content-ID`",
    "multipart/mixed; boundary=b",
    "--b\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 202 Accepted\r\n\r\n\r\n--b--\r\n",
    "an answer that is no batch of responses",
  ],
  [
    "a part without a status line",
    "multipart/mixed; boundary=b",
    "--b\r\nContent-ID: 0\r\n\r\nAccepted\r\n\r\n\r\n--b--\r\n",
    "an answer that is no batch of responses",
  ],
  [
    "a part with a broken header",
    "multipart/mixed; boundary=b",
    "--b\r\nContent-ID: 0\r\n\r\nHTTP/1.1 202 Accepted\r\nno colon\r\n\r\n\r\n--b--\r\n",
    "an answer that is no batch of responses",
  ],
  [
    "an unexpected `Content-ID`",
    "multipart/mixed; boundary=b",
    `${accepted("0")}${accepted("2")}--b--\r\n`,
    'an answer for unexpected Content-ID "2"',
  ],
  [
    "a `Content-ID` that is no place",
    "multipart/mixed; boundary=b",
    `${accepted("0")}${accepted("01")}--b--\r\n`,
    'an answer for unexpected Content-ID "01"',
  ],
  [
    "two answers to one subrequest",
    "multipart/mixed; boundary=b",
    `${accepted("0")}${accepted("1")}${accepted("1")}--b--\r\n`,
    'two answers for Content-ID "1"',
  ],
])("an answer with %s is unreadable", (_label, contentType, body, unreadable) => {
  expect(readSubresponses(contentType, body, 2, asSent)).toEqual({ unreadable });
});

test("an answer that leaves subrequests unanswered names the first of them", () => {
  expect(
    readSubresponses("multipart/mixed; boundary=b", `${accepted("1")}--b--\r\n`, 3, asSent),
  ).toEqual({ unanswered: 0 });
});

test("an answer to no subrequests holds no subresponses", () => {
  expect(readSubresponses("multipart/mixed; boundary=b", "--b--\r\n", 0, asSent)).toEqual({
    subresponses: [],
  });
});
