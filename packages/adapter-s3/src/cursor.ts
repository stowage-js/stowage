// The shape of `adapter-memory`'s cursor under a tag of its own: spec 4.13 fixes what
// `@stowage/core` publishes for an adapter to call, and an adapter depends on no other
// adapter, so each carries one implementation.
//
// The position inside is the provider's continuation token, which S3 hands out opaque
// and takes back from any process. The tag is what tells a cursor this adapter produced
// from any other string before a request goes out; a position the provider no longer
// continues from is refused by the provider instead (spec 7.9).
const cursorTag = "stowage-s3-1:";

const unitDigits = 4;
const hexPosition = new RegExp(`^(?:[\\da-f]{${unitDigits}})*$`);

/** The provider's continuation token, as the opaque string that continues from there. */
export function encodeCursor(continuationToken: string): string {
  return btoa(`${cursorTag}${hexOf(continuationToken)}`);
}

/** The token the cursor continues from, or `undefined` for one this adapter did not produce. */
export function decodeCursor(cursor: string): string | undefined {
  let decoded: string;

  try {
    decoded = atob(cursor);
  } catch {
    return undefined;
  }

  if (!decoded.startsWith(cursorTag)) return undefined;

  const position = decoded.slice(cursorTag.length);

  return position.length > 0 && hexPosition.test(position) ? tokenOf(position) : undefined;
}

// Neither vendor promises the token stays ASCII, and `btoa` takes nothing else, so the
// token goes out one UTF-16 code unit at a time.
function hexOf(token: string): string {
  const units: string[] = [];

  for (let index = 0; index < token.length; index += 1) {
    units.push(token.charCodeAt(index).toString(16).padStart(unitDigits, "0"));
  }

  return units.join("");
}

function tokenOf(position: string): string {
  const units: string[] = [];

  for (let index = 0; index < position.length; index += unitDigits) {
    units.push(String.fromCharCode(Number.parseInt(position.slice(index, index + unitDigits), 16)));
  }

  return units.join("");
}
