import {
  decodeUserMetadataValue,
  encodeUserMetadataValue,
  isUserMetadataKey,
  parseXml,
  readEnvironment,
  userMetadataByteLength,
  XmlSyntaxError,
} from "../../../packages/core/src/index.ts";
import type { ConformanceFramework } from "../../../packages/conformance/src/describe.ts";
import {
  type SerializedConformanceError,
  serializeError,
} from "../../../packages/conformance/src/result.ts";

/**
 * A check of an export of spec 4.13 whose answer rests on what the runtime provides: sticky
 * and Unicode regular expressions, `atob` and `btoa`, the charsets `TextDecoder` knows and
 * whether `process` exists. The core's Vitest tests hold the rest and run on Node alone.
 */
interface CoreCheck {
  readonly name: string;
  readonly run: () => void;
}

export interface CoreCheckResult {
  readonly name: string;
  readonly error?: SerializedConformanceError;
}

const coreChecks: readonly CoreCheck[] = [
  {
    name: "`parseXml` reads elements, attributes, text and references",
    run() {
      const root = parseXml(
        '<?xml version="1.0" encoding="utf-8"?>\n<!-- answer -->\n<EnumerationResults ContainerName="stowage"><Blobs><Blob><Name Encoded="true">a%EF%BF%BE</Name><Key>a&amp;b&#x1F600;&#34;</Key><Prefix/></Blob></Blobs></EnumerationResults>',
      );
      const blob = root.children[0]?.children[0];

      assertSame(root.attributes, { ContainerName: "stowage" }, "the root's attributes");
      assertSame(
        blob?.children.map(({ name, attributes, text }) => [name, attributes, text]),
        [
          ["Name", { Encoded: "true" }, "a%EF%BF%BE"],
          ["Key", {}, 'a&b😀"'],
          ["Prefix", {}, ""],
        ],
        "the elements of the blob",
      );
    },
  },
  {
    name: "`parseXml` refuses CDATA, a DTD and a reference to U+0000",
    run() {
      for (const document of [
        "<Key><![CDATA[a]]></Key>",
        '<!DOCTYPE Key [<!ENTITY e "x">]><Key>&e;</Key>',
        "<Key>&#0;</Key>",
      ]) {
        assertThrows(() => parseXml(document), XmlSyntaxError, document);
      }
    },
  },
  {
    name: "`readEnvironment` answers a variable nothing set with an empty string",
    run() {
      assertSame(readEnvironment("STOWAGE_CORE_CHECK_UNSET"), "", "the unset variable");
    },
  },
  {
    name: "`isUserMetadataKey` tells tokens from identifiers",
    run() {
      assertSame(
        ["content-hash", "a_1", "grüße"].map((name) => [
          isUserMetadataKey(name, "token"),
          isUserMetadataKey(name, "identifier"),
        ]),
        [
          [true, false],
          [true, true],
          [false, false],
        ],
        "the keys",
      );
    },
  },
  {
    name: "`encodeUserMetadataValue` writes UTF-8 base64 encoded words",
    run() {
      assertSame(encodeUserMetadataValue("stowage"), "stowage", "a plain value");
      assertSame(
        encodeUserMetadataValue("grüße"),
        "=?UTF-8?B?Z3LDvMOfZQ==?=",
        "a value above ASCII",
      );
      assertSame(
        encodeUserMetadataValue("a  b", { always: true }),
        "=?UTF-8?B?YSAgYg==?=",
        "a value written with `always`",
      );

      const long = "a😀".repeat(40);

      assertSame(
        decodeUserMetadataValue(encodeUserMetadataValue(long)),
        long,
        "a value split into several words",
      );
    },
  },
  {
    name: "`decodeUserMetadataValue` reads both encodings in UTF-8 and ISO-8859-1",
    run() {
      assertSame(
        [
          "=?UTF-8?B?Z3I=?= =?UTF-8?B?w7zDn2U=?=",
          "=?utf-8?Q?gr=C3=BC=C3=9Fe_dich?=",
          "=?ISO-8859-1?Q?gr=FC=DFe?=",
          "=?UTF-8?B?/w==?=",
        ].map(decodeUserMetadataValue),
        ["grüße", "grüße dich", "grüße", "=?UTF-8?B?/w==?="],
        "the values",
      );
    },
  },
  {
    name: "`userMetadataByteLength` measures every key and its encoded value",
    run() {
      assertSame(
        userMetadataByteLength({ a: "b", greeting: "grüße" }),
        2 + "greeting".length + "=?UTF-8?B?Z3LDvMOfZQ==?=".length,
        "the byte length",
      );
    },
  },
];

export function runCoreChecks(): readonly CoreCheckResult[] {
  return coreChecks.map(({ name, run }) => {
    try {
      run();

      return { name };
    } catch (thrown) {
      return { name, error: serializeError(thrown) };
    }
  });
}

type Framework = Pick<ConformanceFramework, "describe" | "test">;

export function describeCore(framework: Framework): void {
  framework.describe("@stowage/core", () => {
    for (const { name, run } of coreChecks) framework.test(name, async () => run());
  });
}

/** What `runCoreChecks` answered inside a worker, reported as `describeCore` names it. */
export function describeCoreResults(
  framework: Framework,
  results: readonly CoreCheckResult[],
): void {
  framework.describe("@stowage/core", () => {
    for (const { name, error } of results) {
      framework.test(name, async () => {
        if (error !== undefined) throw Object.assign(new Error(), error);
      });
    }
  });
}

function assertSame(actual: unknown, expected: unknown, what: string): void {
  const [actualJson, expectedJson] = [JSON.stringify(actual), JSON.stringify(expected)];

  if (actualJson !== expectedJson) {
    throw new Error(`${what}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function assertThrows(act: () => unknown, type: new () => Error, what: string): void {
  try {
    act();
  } catch (thrown) {
    if (thrown instanceof type) return;

    throw new Error(`${what}: threw something other than a ${type.name}`, { cause: thrown });
  }

  throw new Error(`${what}: threw nothing`);
}
