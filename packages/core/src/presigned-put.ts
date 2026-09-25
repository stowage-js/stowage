/**
 * What `presignPut` resolves with on every adapter that declares `presignedUrls`, so the code
 * that uploads through it never names the provider (ADR 0022).
 */
export interface PresignedPut {
  readonly url: string;
  /** The headers the client sends beside the body. `Content-Length` is never among them. */
  readonly headers: Readonly<Record<string, string>>;
}
