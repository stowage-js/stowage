import type { Resolvable, ResolverOptions } from "../../../packages/core/src/index.ts";

/**
 * The resolver of spec 14.3's `createStorageWithStaleCredentials`: `stale` until it is asked
 * with `forceRefresh: true`, `fresh` from then on. It keeps the fresh credential because a
 * recovered `stat` on S3 resolves again without `forceRefresh` for its second `HEAD`
 * (ADR 0066), and a resolver that answered by the option alone would hand that one the stale
 * credential.
 */
export function staleResolver<Credential>(
  stale: Credential,
  fresh: Resolvable<Credential>,
  onRefresh: () => void,
): (options?: ResolverOptions) => Promise<Credential> {
  let refreshed = false;

  return async (options) => {
    if (options?.forceRefresh === true) {
      refreshed = true;
      onRefresh();
    }

    if (!refreshed) return stale;

    return isResolver(fresh) ? await fresh(options) : fresh;
  };
}

// No credential of an adapter is a function, which `typeof` alone cannot tell a generic type.
function isResolver<Credential>(
  source: Resolvable<Credential>,
): source is (options?: ResolverOptions) => Credential | Promise<Credential> {
  return typeof source === "function";
}
