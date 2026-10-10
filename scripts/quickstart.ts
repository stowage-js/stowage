import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const repository = fileURLToPath(new URL("../", import.meta.url));

const installLine = /^```sh\nnpm install ([^\n]+)\n```$/mu;

/** The packages the root README's install line names. */
export function packagesOfInstallLine(readme: string): string[] {
  const names = installLine.exec(readme)?.[1];

  if (names === undefined) throw new Error("The README names no `npm install` line");

  return names.split(" ");
}

const rootOption = /root: "[^"]*"/u;

/** The README's first `ts` block, with its storage rooted in `root`. */
export function quickstartOf(readme: string, root: string): string {
  const block = /^```ts\n([\s\S]*?)^```$/mu.exec(readme)?.[1] ?? "";

  if (!rootOption.test(block)) throw new Error("The first block names no `root`");

  return block.replace(rootOption, `root: ${JSON.stringify(root)}`);
}

/** `names` and every stowage package they depend on, in order of their names. */
export function withStowageDependencies(
  names: readonly string[],
  dependenciesOf: (name: string) => readonly string[],
): string[] {
  const found = new Set<string>();
  const visit = (name: string): void => {
    if (found.has(name)) return;

    found.add(name);
    for (const dependency of dependenciesOf(name)) visit(dependency);
  };

  for (const name of names) visit(name);

  return [...found].toSorted();
}

interface Manifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

const directoryOf = (name: string): string =>
  join(repository, "packages", name.replace("@stowage/", ""));

async function manifestIn(directory: string): Promise<Manifest> {
  const manifest: Manifest = JSON.parse(
    await readFile(join(repository, "packages", directory, "package.json"), "utf8"),
  );

  return manifest;
}

// ADR 0069: the first block of the root README, run from the packed packages in a project of its
// own, the way a reader who copies it runs it.
if (import.meta.main) {
  const readme = await readFile(join(repository, "README.md"), "utf8");
  // A directory without a manifest, such as one an editor leaves under `packages`, is no package.
  const manifests = await Promise.all(
    (await readdir(join(repository, "packages"))).map(
      async (directory) => await manifestIn(directory).catch(() => undefined),
    ),
  );
  const dependenciesOf = (name: string): string[] =>
    Object.keys(manifests.find((manifest) => manifest?.name === name)?.dependencies ?? {}).filter(
      (dependency) => dependency.startsWith("@stowage/"),
    );

  const workspace = await mkdtemp(join(tmpdir(), "stowage-quickstart-"));
  const packs = join(workspace, "packs");
  const app = join(workspace, "app");
  const root = join(workspace, "storage");

  try {
    await Promise.all([packs, app, root].map(async (directory) => await mkdir(directory)));

    await Promise.all(
      withStowageDependencies(packagesOfInstallLine(readme), dependenciesOf).map(
        async (name) =>
          await run("pnpm", ["pack", "--pack-destination", packs], { cwd: directoryOf(name) }),
      ),
    );

    const tarballs = (await readdir(packs)).map((file) => join(packs, file));

    await writeFile(join(app, "package.json"), '{ "name": "quickstart", "private": true }\n');
    // Offline, so that a stowage package the tarballs miss fails the install instead of arriving
    // from the registry at its published version rather than the one under test.
    await run("npm", ["install", "--offline", "--no-audit", "--no-fund", ...tarballs], {
      cwd: app,
    });
    await writeFile(join(app, "quickstart.mjs"), quickstartOf(readme, root));

    const { stdout } = await run(process.execPath, ["quickstart.mjs"], { cwd: app });

    process.stdout.write(stdout);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
