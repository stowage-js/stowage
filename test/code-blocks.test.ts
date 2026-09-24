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
  /** The line of the document the block's first line of code stands on. */
  readonly line: number;
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
    if (lines[index] !== "```ts") continue;

    const start = index + 1;
    const end = lines.indexOf("```", start);

    blocks.push({
      name: `${document}:${start + 1}`,
      document,
      line: start + 1,
      source: lines.slice(start, end).join("\n"),
      specSection: document === "docs/spec.md" ? specSection : undefined,
    });
    index = end;
  }

  return blocks;
}

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

  const output = await compile(directory);

  for (const line of output.split("\n").filter((entry) => entry.includes(": error TS"))) {
    const match = /^block-(\d+)\.ts\((\d+),(\d+)\): error (TS\d+): (.*)$/u.exec(line);
    const block = match === null ? undefined : blocks[Number(match[1])];

    if (match === null || block === undefined) {
      diagnostics.set("outside", [...(diagnostics.get("outside") ?? []), line]);
      continue;
    }
    if (block.specSection !== undefined && signatureOnlyDiagnostics.has(match[4] ?? "")) continue;

    const documentLine = block.line + Number(match[2]) - 2;

    diagnostics.set(block.name, [
      ...(diagnostics.get(block.name) ?? []),
      `${block.document}:${documentLine}:${match[3]} ${match[4]}: ${match[5]}`,
    ]);
  }
});

afterAll(async () => {
  if (directory !== "") await rm(directory, { recursive: true, force: true });
});

async function compile(project: string): Promise<string> {
  const tsc = join(repository, "node_modules/typescript/bin/tsc");

  // `tsc` exits non-zero on the first error and reports every one on stdout regardless, and
  // a compiler that fails to start says why on stderr, which lands outside every block.
  return await new Promise((resolve) => {
    execFile(
      process.execPath,
      [tsc, "--pretty", "false"],
      { cwd: project },
      (_, stdout, stderr) => {
        resolve(`${stdout}${stderr}`);
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
