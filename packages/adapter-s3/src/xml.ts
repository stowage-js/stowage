/** The five entities XML defines without a DTD, for the failure read around the parser. */
export const predefinedEntities: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

const xmlEscapes: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Text as it stands inside an element of a request document stowage writes. */
export function escapeXml(text: string): string {
  return text.replaceAll(/[&<>"']/gu, (character) => xmlEscapes[character] ?? character);
}
