const utf8 = new TextEncoder();

/**
 * ADR 0009: Web Crypto defines SHA-256 as one shot over a `BufferSource` and has no
 * incremental form, so the adapter holds what it hashes whole.
 */
export async function sha256Hex(data: BufferSource | string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytesOf(data)));
}

export async function hmacSha256(key: BufferSource, data: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  return await crypto.subtle.sign("HMAC", imported, utf8.encode(data));
}

export function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesOf(data: BufferSource | string): BufferSource {
  return typeof data === "string" ? utf8.encode(data) : data;
}
