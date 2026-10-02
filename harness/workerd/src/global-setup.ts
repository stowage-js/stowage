import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "tsdown";

const harnessDirectory = fileURLToPath(new URL("..", import.meta.url));

/**
 * Once before every test file, since the build empties `dist` and a test file starting
 * `workerd` meanwhile would find its modules gone.
 */
export default async function setup(): Promise<void> {
  await bundleWorkers();
  await placeTrustedCertificate();
}

/**
 * `src/worker.ts` and `src/http-worker.ts`, each bundled alone into the one module its
 * config embeds: built together, they would share a chunk that neither config embeds. The
 * first build empties `dist`, and the second keeps what the first wrote.
 */
async function bundleWorkers(): Promise<void> {
  await bundle("worker", true);
  await bundle("http-worker", false);
}

async function bundle(name: string, clean: boolean): Promise<void> {
  await build({
    config: false,
    cwd: harnessDirectory,
    entry: { [name]: `src/${name}.ts` },
    outDir: "dist",
    clean,
    format: "esm",
    platform: "neutral",
    fixedExtension: false,
    dts: false,
    logLevel: "warn",
  });
}

/**
 * ADR 0023: `workerd.capnp` trusts the certificate `harness/azure-blob/start.sh` generates,
 * and `workerd` refuses to start on a missing or empty file. Where no Azurite was started, a
 * certificate whose key nobody holds stands in, so that the run reports the missing endpoint
 * as a failed check (ADR 0012) and the other adapters' results still arrive.
 */
async function placeTrustedCertificate(): Promise<void> {
  const trusted = join(harnessDirectory, "dist", "trusted-certificate.pem");

  try {
    await copyFile(join(harnessDirectory, "..", "azure-blob", "certificate", "cert.pem"), trusted);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;

    await copyFile(join(harnessDirectory, "placeholder-certificate.pem"), trusted);
  }
}
