import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { argv, stdout } from "node:process";

import { realEndpoints } from "./configuration.ts";
import { type FirstRunPoint, type FirstRunTest, firstRunPoints } from "./first-run.ts";

/** The part of one test in Vitest's JSON report that the table reads. */
export interface JsonAssertion {
  readonly ancestorTitles: readonly string[];
  readonly title: string;
  readonly status: string;
  readonly failureMessages: readonly string[] | null;
  readonly meta: { readonly observed?: string };
}

/** The part of Vitest's JSON report that the table reads. */
export interface JsonResults {
  readonly testResults: readonly { readonly assertionResults: readonly JsonAssertion[] }[];
}

/**
 * One job of the scheduled run and what Vitest reported. `label` is the job's artifact,
 * `<provider>-<runtime>` as `conformance-full.yml` names it: `aws-s3-node-24`, `r2-workerd`.
 */
export interface FirstRunRun {
  readonly label: string;
  readonly results: JsonResults;
}

/**
 * Spec 13: the run reports on each point it settles, one column per endpoint and runtime.
 * A promise it disproves is withdrawn by hand; the table is what that decision reads.
 */
export function firstRunReport(runs: readonly FirstRunRun[]): string {
  const header = ["Point", ...runs.map((each) => each.label)];
  const rows = firstRunPoints.map((point) =>
    [point.promise].concat(
      runs.map((each) => (isAsked(point, each.label) ? cellFor(point, each.results) : "—")),
    ),
  );

  return [
    "## Settled by the first run",
    "",
    tableRow(header),
    tableRow(header.map(() => "---")),
    ...rows.map(tableRow),
    "",
    "A promise this run disproves is withdrawn from `docs/spec.md` in a minor release (spec 10).",
    "",
  ].join("\n");
}

function isAsked(point: FirstRunPoint, label: string): boolean {
  const provider = realEndpoints.find((name) => label.startsWith(`${name}-`));
  const runtime = provider === undefined ? label : label.slice(provider.length + 1);
  const { askedOf } = point;

  if (askedOf?.provider !== undefined && askedOf.provider !== provider) return false;

  return askedOf?.runtime === undefined || runtime.startsWith(askedOf.runtime);
}

function cellFor(point: FirstRunPoint, results: JsonResults): string {
  const outcomes = point.tests.map((wanted) => ({
    title: wanted.title,
    outcome: outcomeOf(findAssertion(results, wanted), wanted),
  }));
  const [first] = outcomes;

  if (first !== undefined && outcomes.every((each) => each.outcome === first.outcome)) {
    return first.outcome;
  }

  return outcomes.map((each) => `${each.title}: ${each.outcome}`).join("<br>");
}

/** Where `describeCases` skips a case, the factory it lacked is part of the test's name. */
const skippedSuffix = /^ \(skipped: (?<reason>.+)\)$/u;

function findAssertion(results: JsonResults, wanted: FirstRunTest): JsonAssertion | undefined {
  return results.testResults
    .flatMap((file) => file.assertionResults)
    .find(
      (each) =>
        each.ancestorTitles.includes(wanted.suite) &&
        (each.title === wanted.title || skippedReason(each, wanted) !== undefined),
    );
}

function skippedReason(assertion: JsonAssertion, wanted: FirstRunTest): string | undefined {
  if (!assertion.title.startsWith(wanted.title)) return undefined;

  return skippedSuffix.exec(assertion.title.slice(wanted.title.length))?.groups?.["reason"];
}

function outcomeOf(assertion: JsonAssertion | undefined, wanted: FirstRunTest): string {
  if (assertion === undefined) return "not run";

  const skipped = skippedReason(assertion, wanted);

  if (skipped !== undefined) return `not settled: no \`${skipped}\``;

  if (assertion.status === "failed") {
    const [message = ""] = assertion.failureMessages ?? [];
    const [firstLine = ""] = message.split("\n");

    return `disproved: ${firstLine}`;
  }

  if (assertion.status !== "passed") return "not run";

  return assertion.meta.observed ?? "held";
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.map((cell) => cell.replaceAll("|", "\\|").replaceAll("\n", " ")).join(" | ")} |`;
}

/**
 * The report job of `conformance-full.yml` downloads each job's `results.json` into a
 * directory named after the job, which becomes the column.
 */
async function readRuns(directory: string): Promise<FirstRunRun[]> {
  const labels = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();

  return await Promise.all(
    labels.map(async (label) => ({
      label,
      results: JSON.parse(await readFile(join(directory, label, "results.json"), "utf8")),
    })),
  );
}

if (import.meta.main) {
  const [, , directory = "results"] = argv;

  stdout.write(firstRunReport(await readRuns(directory)));
}
