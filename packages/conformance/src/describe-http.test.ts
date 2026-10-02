import { expect, test } from "vitest";

import { type ConformanceFramework } from "./describe.ts";
import { describeHttpConformance } from "./describe-http.ts";
import { httpConformanceCases } from "./http-cases/index.ts";
import type { HttpConformanceTarget } from "./http-target.ts";
import { stubStorage } from "./stubs.ts";

const target: HttpConformanceTarget = {
  name: "stub",
  createStorage: () => stubStorage(),
  url: (answer, key) => new URL(`http://server.test/${answer}/${encodeURIComponent(key)}`),
};

test("every HTTP case becomes one test inside `<name> over HTTP`, with the cleanup behind", () => {
  const suites: string[] = [];
  const tests: string[] = [];
  const framework: ConformanceFramework = {
    describe: (name, body) => {
      suites.push(name);
      body();
    },
    test: (name) => void tests.push(name),
  };

  describeHttpConformance(target, framework);

  expect(suites).toEqual(["stub over HTTP"]);
  expect(tests).toEqual([...httpConformanceCases.map((source) => source.name), "cleanup"]);
});

test("the HTTP list holds the serving cases of spec 14.9 that answer a whole object", () => {
  expect(httpConformanceCases.map((source) => source.name)).toEqual([
    "serve/whole",
    "serve/headers",
    "serve/disposition",
    "serve/head",
    "serve/not-found",
    "serve/method-not-allowed",
    "serve/ignored-range",
  ]);
});

test("every HTTP case is `fast`", () => {
  expect(new Set(httpConformanceCases.map((source) => source.cost))).toEqual(new Set(["fast"]));
});
