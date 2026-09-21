// A cursor carries the position itself rather than naming an entry the storage kept, so
// that it continues a listing in another process, where no storage of this run is left
// (spec 4.6). The tag is what tells a cursor this adapter produced from any other string.
const cursorTag = "stowage-memory-1:";

const unitDigits = 4;
const hexPosition = new RegExp(`^(?:[\\da-f]{${unitDigits}})*$`);

/** The key a page ended on, as the opaque string that continues from there. */
export function encodeCursor(after: string): string {
  return btoa(`${cursorTag}${hexOf(after)}`);
}

/** The key the cursor continues from, or `undefined` for one this adapter did not produce. */
export function decodeCursor(cursor: string): string | undefined {
  let decoded: string;

  try {
    decoded = atob(cursor);
  } catch {
    return undefined;
  }

  if (!decoded.startsWith(cursorTag)) return undefined;

  const position = decoded.slice(cursorTag.length);

  return hexPosition.test(position) ? keyOf(position) : undefined;
}

// A key may hold a lone surrogate, which spec 4.8 allows and no text encoding of the
// runtime carries through, so the position goes out one UTF-16 code unit at a time.
function hexOf(key: string): string {
  const units: string[] = [];

  for (let index = 0; index < key.length; index += 1) {
    units.push(key.charCodeAt(index).toString(16).padStart(unitDigits, "0"));
  }

  return units.join("");
}

function keyOf(position: string): string {
  const units: string[] = [];

  for (let index = 0; index < position.length; index += unitDigits) {
    units.push(String.fromCharCode(Number.parseInt(position.slice(index, index + unitDigits), 16)));
  }

  return units.join("");
}
