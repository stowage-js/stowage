export const defaultContentType = "application/octet-stream";

/**
 * The table spec 6 has the adapter derive a content type from, kept to the types a file
 * below a root is likely to carry: nothing here reads the bytes, and no dependency comes
 * into a package that promises a runtime dependency outside `@stowage` for nothing.
 */
const contentTypes = new Map<string, string>([
  ["avif", "image/avif"],
  ["css", "text/css"],
  ["csv", "text/csv"],
  ["gif", "image/gif"],
  ["gz", "application/gzip"],
  ["htm", "text/html"],
  ["html", "text/html"],
  ["ico", "image/vnd.microsoft.icon"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["js", "text/javascript"],
  ["json", "application/json"],
  ["md", "text/markdown"],
  ["mjs", "text/javascript"],
  ["mp3", "audio/mpeg"],
  ["mp4", "video/mp4"],
  ["otf", "font/otf"],
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["svg", "image/svg+xml"],
  ["tar", "application/x-tar"],
  ["ttf", "font/ttf"],
  ["txt", "text/plain"],
  ["wasm", "application/wasm"],
  ["wav", "audio/wav"],
  ["webm", "video/webm"],
  ["webp", "image/webp"],
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["xml", "application/xml"],
  ["yaml", "application/yaml"],
  ["yml", "application/yaml"],
  ["zip", "application/zip"],
]);

/** The type the key's extension names, and `application/octet-stream` for every other key. */
export function contentTypeOf(key: string): string {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");

  // A name beginning with a dot is a name and not an extension, so `.gitignore` is no
  // more typed than a name that carries no dot at all.
  if (dot < 1) return defaultContentType;

  return contentTypes.get(name.slice(dot + 1).toLowerCase()) ?? defaultContentType;
}
