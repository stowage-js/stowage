// The bytes a storage holds sit in a buffer of their own, which is what `digest`
// takes: `BufferSource` rules out a view on a `SharedArrayBuffer`.
export async function etagOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
