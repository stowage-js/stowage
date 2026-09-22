import { expect, test } from "vitest";

import { readErrorDocument } from "./error-document.ts";

test("it reads the code and the message a provider answered with", () => {
  expect(
    readErrorDocument(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message><Key>absent.txt</Key><RequestId>abc</RequestId></Error>',
    ),
  ).toEqual({ code: "NoSuchKey", message: "The specified key does not exist." });
});

test.each([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&apos;", "'"],
  ["&#39;", "'"],
  ["&#x2F;", "/"],
])("the entity %s is read as %s", (entity, character) => {
  expect(readErrorDocument(`<Message>a${entity}b</Message>`).message).toBe(`a${character}b`);
});

// Spec 4.10 passes the message on word for word, so what is no entity stays as written.
test("what is no entity is left as it stands", () => {
  expect(readErrorDocument("<Message>100 &percnt; &amp; a &lone</Message>").message).toBe(
    "100 &percnt; & a &lone",
  );
});

test.each([
  ["a body the provider left empty", ""],
  ["an HTML page from something in between", "<html><body>502 Bad Gateway</body></html>"],
  ["an error document without the two elements", "<Error><RequestId>abc</RequestId></Error>"],
])("%s carries neither code nor message", (_case, body) => {
  expect(readErrorDocument(body)).toEqual({ code: undefined, message: undefined });
});
