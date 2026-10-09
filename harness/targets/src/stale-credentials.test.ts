import { expect, test } from "vitest";

import type { ResolverOptions } from "../../../packages/core/src/index.ts";
import { staleResolver } from "./stale-credentials.ts";

test("answers the stale credential until it is asked to refresh", async () => {
  const resolve = staleResolver("stale", "fresh", () => undefined);

  await expect(resolve()).resolves.toBe("stale");
  await expect(resolve({ forceRefresh: false })).resolves.toBe("stale");
  await expect(resolve({ forceRefresh: true })).resolves.toBe("fresh");
});

// ADR 0066: a recovered `stat` resolves again for its second `HEAD`, without `forceRefresh`.
test("keeps the fresh credential after the refresh, whatever it is asked", async () => {
  const resolve = staleResolver("stale", "fresh", () => undefined);

  await resolve({ forceRefresh: true });

  await expect(resolve({ forceRefresh: false })).resolves.toBe("fresh");
  await expect(resolve()).resolves.toBe("fresh");
});

test("reports every refresh it is asked for", async () => {
  let refreshes = 0;
  const resolve = staleResolver("stale", "fresh", () => {
    refreshes += 1;
  });

  await resolve();
  await resolve({ forceRefresh: true });
  await resolve({ forceRefresh: false });
  await resolve({ forceRefresh: true });

  expect(refreshes).toBe(2);
});

test("asks a fresh resolver with the options it was asked with", async () => {
  const asked: (ResolverOptions | undefined)[] = [];
  const resolve = staleResolver(
    "stale",
    (options?: ResolverOptions) => {
      asked.push(options);

      return "fresh";
    },
    () => undefined,
  );

  await resolve({ forceRefresh: true });
  await resolve({ forceRefresh: false });

  expect(asked).toEqual([{ forceRefresh: true }, { forceRefresh: false }]);
});
