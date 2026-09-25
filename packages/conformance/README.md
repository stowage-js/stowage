# @stowage/conformance

The cases every stowage adapter has to pass, as plain cases a test framework maps onto its own
runner. An adapter written outside this repository passes the same cases as the ones inside it.

## Install

```sh
npm install --save-dev @stowage/conformance
```

## Write a target

A `ConformanceTarget` tells the suite how to construct the storage under test. `createStorage`
returns a storage the run may write to below any prefix, constructed from outside the adapter the
way a caller would construct it
([spec 8.3](https://github.com/stowage-js/stowage/blob/@stowage/conformance@0.1.0/docs/spec.md#83-what-the-target-promises)).

```ts
import { memoryStorage } from "@stowage/adapter-memory";
import type { ConformanceTarget } from "@stowage/conformance";

export const target: ConformanceTarget = {
  name: "@stowage/adapter-memory",
  createStorage: () => memoryStorage(),
};
```

The optional members widen the run:

- `cleanup(keyPrefix)` runs once at the end, and defaults to `deleteAll(keyPrefix)` on a fresh
  storage. Every key a run writes begins with its prefix, so two runs against one bucket do not
  interfere.
- `createStorageWithBadCredentials`, `createStorageWithExpiredCredentials` and
  `createStorageWithDeniedCredentials` return storages whose credential the provider refuses, has
  expired, or accepts for reading alone. A case that needs a factory the target leaves out is
  reported `skipped`.

## Fill the declaration

The suite reads what the storage supports from its `capabilities`, once per run, before the first
case. The storage lists every name out of `capabilityNames` it implements, each once, and the list
is fixed when it is constructed
([spec 4.9](https://github.com/stowage-js/stowage/blob/@stowage/conformance@0.1.0/docs/spec.md#49-capabilities)).
Every storage the target creates in one run declares the same; two configurations are two targets.

A case whose `requires` the storage declares runs its `run` half. A case missing a name of its
`requires` runs the `runWithout` half, which checks what the storage does without the capability: most refuse the
call with `Unsupported` naming it, `presignedUrls` has `presignGet` and `presignPut` absent from the
storage, and a few check the weaker behavior, such as a copy whose destination reads `{}`
([spec 8.5](https://github.com/stowage-js/stowage/blob/@stowage/conformance@0.1.0/docs/spec.md#85-cases)).
An adapter refuses such a call like this:

```ts
import { StorageError } from "@stowage/core";

export function refuseUserMetadata(bucket: string): StorageError {
  return new StorageError({
    code: "Unsupported",
    message: "This storage keeps no user metadata",
    operation: "put",
    bucket,
    provider: "my-provider",
    attempts: 0,
    capability: "userMetadata",
  });
}
```

`expectUnsupported(call, capability)` asserts that refusal in a test of the adapter's own.

## Run the cases

`describeConformance(target, framework)` maps every case onto the `describe` and `test` of the
framework it is handed
([spec 8.2](https://github.com/stowage-js/stowage/blob/@stowage/conformance@0.1.0/docs/spec.md#82-running-the-suite)).
It runs the `fast` cases, and both tiers with `includeSlow: true`.

Vitest:

```ts
import { memoryStorage } from "@stowage/adapter-memory";
import { describeConformance } from "@stowage/conformance";
import { describe, test } from "vitest";

describeConformance(
  { name: "@stowage/adapter-memory", createStorage: () => memoryStorage() },
  { describe, test, includeSlow: true },
);
```

`bun:test`:

```ts
import { describe, test } from "bun:test";

import { memoryStorage } from "@stowage/adapter-memory";
import { describeConformance } from "@stowage/conformance";

describeConformance(
  { name: "@stowage/adapter-memory", createStorage: () => memoryStorage() },
  { describe, test },
);
```

`Deno.test` has no `describe` beside it, so a block becomes the leading part of each test's name:

```ts
import { memoryStorage } from "@stowage/adapter-memory";
import { describeConformance } from "@stowage/conformance";

const enclosingNames: string[] = [];

describeConformance(
  { name: "@stowage/adapter-memory", createStorage: () => memoryStorage() },
  {
    describe(name, body) {
      enclosingNames.push(name);

      try {
        body();
      } finally {
        enclosingNames.pop();
      }
    },
    test(name, body) {
      Deno.test([...enclosingNames, name].join(" > "), body);
    },
  },
);
```

## Run the cases on `workerd`

`workerd` has no test framework. `runAll(target)` runs every case and returns the results, which a
worker answers with for the process that started it to report:

```ts
import { memoryStorage } from "@stowage/adapter-memory";
import { runAll } from "@stowage/conformance";

export default {
  async fetch(): Promise<Response> {
    const results = await runAll({
      name: "@stowage/adapter-memory",
      createStorage: () => memoryStorage(),
    });
    const failed = results.filter((result) => result.status === "failed");

    return Response.json(results, { status: failed.length === 0 ? 200 : 500 });
  },
};
```

A failed result carries the error as `name`, `message`, `stack` and, for a `StorageError`, `code`.

## Read an adapter

[`@stowage/adapter-memory`](https://github.com/stowage-js/stowage/tree/@stowage/adapter-memory@0.1.0/packages/adapter-memory/src)
is the implementation a third-party adapter is read against. It enforces the key rule exactly,
declares four of the five capabilities, and has no network in the way. The cases themselves are
written against the behavior of S3, not against it.

What the suite leaves to an adapter's own tests, such as flat memory during a large upload or the
retry curve, is listed in
[spec 8.4](https://github.com/stowage-js/stowage/blob/@stowage/conformance@0.1.0/docs/spec.md#84-what-the-suite-does-not-assert).

## Runtimes

Node 24 and later, Bun, Deno and `workerd` at the compatibility date `2026-09-01` without Node APIs. CI last ran green on Bun 1.4.2 and Deno 2.9.6.

The bundle measures 10.7 kB minified and gzipped, `@stowage/core` included.

## Specification

[`docs/spec.md` at `@stowage/conformance@0.1.0`](https://github.com/stowage-js/stowage/blob/@stowage/conformance@0.1.0/docs/spec.md#8-stowageconformance)
is the contract: a caller may rely on what it states and on nothing else this package happens to
export. The [terms it uses](https://github.com/stowage-js/stowage/blob/@stowage/conformance@0.1.0/CONTEXT.md)
and the [decisions behind it](https://github.com/stowage-js/stowage/tree/@stowage/conformance@0.1.0/docs/adr)
are at the same tag.

## License

MIT
