import { isStorageError } from "../../../packages/core/src/index.ts";
import { fromEnv, type S3Credentials } from "../../../packages/adapter-s3/src/index.ts";

/** What `fromEnv` yields inside a worker, as the worker reports it. */
export type FromEnvOutcome =
  | { readonly credentials: S3Credentials }
  | { readonly refusal: { readonly code: string; readonly message: string } };

export function fromEnvOutcome(): FromEnvOutcome {
  try {
    return { credentials: fromEnv() };
  } catch (error) {
    if (!isStorageError(error)) throw error;

    return { refusal: { code: error.code, message: error.message } };
  }
}
