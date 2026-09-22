import type { StorageErrorCode } from "./errors.ts";

/**
 * The code the status decides on its own, or `undefined` for a status that decides
 * nothing. It is the fallback of spec 4.10: an adapter maps a provider code first and
 * reaches here where it recognizes none.
 */
export function errorCodeForStatus(status: number): StorageErrorCode | undefined {
  if (status >= 200 && status <= 299) return undefined;

  if (status === 401) return "InvalidCredentials";
  if (status === 403) return "AccessDenied";
  if (status === 404) return "NotFound";

  return "ProviderError";
}

/** Whether the status names a condition that may be gone a moment later (spec 4.10). */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}
