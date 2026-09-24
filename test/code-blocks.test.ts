import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, expect, test } from "vitest";

// Spec 10: every `ts` block in a README and in the spec compiles against the built
// declarations, so this test reads `packages/*/dist` and needs `pnpm build` in front of it.
const repository = fileURLToPath(new URL("../", import.meta.url));

const documents = [
  "README.md",
  "packages/core/README.md",
  "packages/adapter-memory/README.md",
  "packages/adapter-fs/README.md",
  "packages/adapter-s3/README.md",
  "packages/conformance/README.md",
  "docs/spec.md",
];

/** The package whose declarations the blocks of a spec section are written against. */
const packageOfSpecSection: Readonly<Record<string, string>> = {
  "4": "core",
  "5": "adapter-memory",
  "6": "adapter-fs",
  "7": "adapter-s3",
  "8": "conformance",
};

interface CodeBlock {
  readonly name: string;
  readonly document: string;
  readonly firstCodeLine: number;
  readonly source: string;
  readonly specSection?: string;
}

const read = async (path: string): Promise<string> =>
  await readFile(join(repository, path), "utf8");

function codeBlocksOf(document: string, text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = text.split("\n");
  let specSection: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const section = /^## (\d+)\./u.exec(lines[index] ?? "")?.[1];

    if (section !== undefined) specSection = section;
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(lines[index] ?? "");

    if (opening === null) continue;

    const fence = opening[1] ?? "";
    const info = opening[2]?.trim() ?? "";

    if (fence.startsWith("`") && info.includes("`")) continue;

    const typescript = /^(?:ts|typescript)(?=\s|$)|^\{\.(?:ts|typescript)(?=\s|\})/u.test(info);

    const start = index + 1;
    let end = start;

    for (; end < lines.length; end += 1) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/u.exec(lines[end] ?? "")?.[1];

      if (closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length) break;
    }

    if (end === lines.length) {
      if (typescript)
        throw new Error(`${document}:${start} opens a TypeScript block it never closes`);
      break;
    }

    if (typescript) {
      blocks.push({
        name: `${document}:${start + 1}`,
        document,
        firstCodeLine: start + 1,
        source: lines.slice(start, end).join("\n"),
        specSection: document === "docs/spec.md" ? specSection : undefined,
      });
    }
    index = end;
  }

  return blocks;
}

test("TypeScript fences accept indentation, longer markers, tildes and attributes", () => {
  const source = [
    "  ````typescript title=example.ts",
    "const first = 1;",
    "```",
    "  ````",
    " ~~~ts {.example}",
    "const second = 2;",
    " ~~~",
    "```{.typescript}",
    "const third = 3;",
    "```",
  ].join("\n");

  expect(
    codeBlocksOf("README.md", source).map(({ firstCodeLine, source: code }) => [
      firstCodeLine,
      code,
    ]),
  ).toEqual([
    [2, "const first = 1;\n```"],
    [6, "const second = 2;"],
    [9, "const third = 3;"],
  ]);
});

test("unsupported fences do not expose their contents or hide later TypeScript", () => {
  const source = [
    "````javascript",
    "```ts",
    "not TypeScript",
    "```",
    "````",
    "~~~typescript",
    "const present = true;",
    "~~~",
  ].join("\n");

  expect(
    codeBlocksOf("README.md", source).map(({ firstCodeLine, source: code }) => [
      firstCodeLine,
      code,
    ]),
  ).toEqual([[7, "const present = true;"]]);
});

const blocks: CodeBlock[] = (
  await Promise.all(documents.map(async (document) => codeBlocksOf(document, await read(document))))
).flat();

/** Every name a package exports, read from the declarations its build wrote. */
async function exportsOf(name: string): Promise<string[]> {
  const declarations = await read(`packages/${name}/dist/index.d.ts`);
  const declared = [
    ...declarations.matchAll(
      /^export (?:declare )?(?:function|const|class|interface|type) (\w+)/gmu,
    ),
  ].map((match) => match[1] ?? "");
  const listed = [...declarations.matchAll(/^export (?:type )?\{([^}]*)\}/gmu)].flatMap((match) =>
    (match[1] ?? "").split(",").map((entry) => entry.replace(/^\s*type\s+/u, "").trim()),
  );

  return [...declared, ...listed].filter((entry) => entry !== "");
}

const declaredNamesOf = (source: string): Set<string> =>
  new Set(
    [
      ...source.matchAll(
        /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|class|function|const)\s+(\w+)/gmu,
      ),
    ].map((match) => match[1] ?? ""),
  );

/**
 * A spec block states a package's surface and names the types it does not declare itself,
 * as the package does through its own imports. Those names are imported on one line in
 * front of the block, so that a line of the block keeps its number plus one.
 */
async function importLineFor(block: CodeBlock): Promise<string> {
  if (block.specSection === undefined) return "";

  const name = packageOfSpecSection[block.specSection];

  if (name === undefined) throw new Error(`${block.name} lies in no section of a package`);

  const declared = declaredNamesOf(block.source);
  const statements = await Promise.all(
    [...new Set(["core", name])].map(async (from) => {
      const names = (await exportsOf(from)).filter((entry) => !declared.has(entry));

      return `import type { ${names.join(", ")} } from "@stowage/${from}";`;
    }),
  );

  return statements.join(" ");
}

// The spec states signatures without their bodies, which a `.ts` file reports as a missing
// function or constructor implementation, or as a `const` without its value. A README block
// is a program and gets no pass.
const signatureOnlyDiagnostics = new Set(["TS1155", "TS2390", "TS2391"]);

interface Compilation {
  readonly error: Error | null;
  readonly stdout: string;
  readonly stderr: string;
}

const diagnostics = new Map<string, string[]>();
let directory = "";

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "stowage-code-blocks-"));

  // A README block imports a test framework as its reader would; the link lets that import
  // resolve from outside the repository.
  await symlink(join(repository, "node_modules"), join(directory, "node_modules"), "dir");
  await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));

  const files = await Promise.all(
    blocks.map(async (block, index) => {
      const file = `block-${index}.ts`;

      await writeFile(
        join(directory, file),
        `${await importLineFor(block)}\n${block.source}\nexport {};\n`,
      );

      return file;
    }),
  );

  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      extends: join(repository, "tsconfig.base.json"),
      compilerOptions: {
        strictPropertyInitialization: false,
        paths: { "@stowage/*": [join(repository, "packages/*/dist/index.d.ts")] },
      },
      files: [
        ...files,
        // The conformance README hands its cases to `bun:test` and `Deno.test`, which the
        // harnesses declare for a type check on Node, and so does this one.
        join(repository, "harness/bun/src/bun-test.d.ts"),
        join(repository, "harness/deno/src/deno.d.ts"),
      ],
    }),
  );

  const found = diagnosticsOf(await compile(directory), blocks);

  for (const [name, messages] of found) diagnostics.set(name, messages);
});

function diagnosticsOf(
  output: Compilation,
  codeBlocks: readonly CodeBlock[],
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let recognized = 0;

  for (const line of `${output.stdout}\n${output.stderr}`.split("\n")) {
    if (!/(?:^|: )error TS\d+: /u.test(line)) continue;

    recognized += 1;
    const match = /^block-(\d+)\.ts\((\d+),(\d+)\): error (TS\d+): (.*)$/u.exec(line);
    const block = match === null ? undefined : codeBlocks[Number(match[1])];

    if (match === null || block === undefined) {
      found.set("outside", [...(found.get("outside") ?? []), line]);
      continue;
    }
    if (block.specSection !== undefined && signatureOnlyDiagnostics.has(match[4] ?? "")) continue;

    const documentLine = block.firstCodeLine + Number(match[2]) - 2;

    found.set(block.name, [
      ...(found.get(block.name) ?? []),
      `${block.document}:${documentLine}:${match[3]} ${match[4]}: ${match[5]}`,
    ]);
  }

  if (output.error !== null && recognized === 0) {
    found.set("outside", [
      ...(found.get("outside") ?? []),
      `Compiler failed without a TypeScript diagnostic: ${output.error.message}`,
    ]);
  }

  return found;
}

test("global TypeScript errors and compiler failures cannot pass unnoticed", () => {
  expect(
    diagnosticsOf(
      { error: new Error("exited with code 2"), stdout: "error TS18003: No inputs", stderr: "" },
      [],
    ),
  ).toEqual(new Map([["outside", ["error TS18003: No inputs"]]]));
  expect(
    diagnosticsOf({ error: new Error("spawn failed"), stdout: "", stderr: "failed to start" }, []),
  ).toEqual(
    new Map([["outside", ["Compiler failed without a TypeScript diagnostic: spawn failed"]]]),
  );
});

test("file-scoped TypeScript errors are mapped back to documentation lines", () => {
  const block: CodeBlock = {
    name: "README.md:10",
    document: "README.md",
    firstCodeLine: 10,
    source: "const value = missing;",
  };

  expect(
    diagnosticsOf(
      {
        error: new Error("exited with code 2"),
        stdout: "block-0.ts(2,15): error TS2304: Cannot find name 'missing'.",
        stderr: "",
      },
      [block],
    ),
  ).toEqual(new Map([[block.name, ["README.md:10:15 TS2304: Cannot find name 'missing'."]]]));
});

afterAll(async () => {
  if (directory !== "") await rm(directory, { recursive: true, force: true });
});

async function compile(project: string): Promise<Compilation> {
  const tsc = join(repository, "node_modules/typescript/bin/tsc");

  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [tsc, "--pretty", "false"],
      { cwd: project },
      (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      },
    );
  });
}

test("the documents hold code blocks to compile", () => {
  expect(blocks.length).toBeGreaterThan(0);
});

test.each(blocks)("$name compiles against the built declarations", (block) => {
  expect(diagnostics.get(block.name) ?? []).toEqual([]);
});

test("nothing outside the code blocks fails to compile", () => {
  expect(diagnostics.get("outside") ?? []).toEqual([]);
});
