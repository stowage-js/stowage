export interface S3ErrorDocument {
  readonly code?: string;
  readonly message?: string;
}

/**
 * The `Code` and `Message` a provider answers a failed request with. The parser spec 7.4
 * puts in front of a listing reads a structure; a failure needs two texts out of one flat
 * element, and a body that is no error document — an HTML page from a proxy in between,
 * a body the provider left empty — leaves both unset rather than failing on its way to
 * reporting a failure.
 */
export function readErrorDocument(body: string): S3ErrorDocument {
  return { code: textOf(body, "Code"), message: textOf(body, "Message") };
}

function textOf(body: string, element: string): string | undefined {
  const found = new RegExp(`<${element}>([^<]*)</${element}>`, "u").exec(body);
  const text = found?.[1];

  return text === undefined ? undefined : decodeEntities(text);
}

const namedEntities: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

// Spec 4.10 passes the provider's message on word for word, and a message holding a key
// reaches here with its `&` and its `<` escaped. An entity that names nothing stays as it
// was written, which is what leaves an unescaped `&` in a message alone.
function decodeEntities(text: string): string {
  return text.replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, name: string) => {
    if (name.startsWith("#")) {
      const codePoint = Number(name.startsWith("#x") ? `0x${name.slice(2)}` : name.slice(1));

      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10_ff_ff
        ? String.fromCodePoint(codePoint)
        : entity;
    }

    return namedEntities.get(name.toLowerCase()) ?? entity;
  });
}
