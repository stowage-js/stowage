// The shape of `adapter-memory`'s cursor under a tag of its own: spec 4.13 fixes what
// `@stowage/core` publishes for an adapter to call, and an adapter depends on no other
// adapter, so each carries one implementation.
//
// The position inside is the provider's `NextMarker`, which Azure hands out opaque and
// takes back from any process. The tag is what tells a cursor this adapter produced from
// any other string before a request goes out; a marker the provider no longer continues
// from is refused by the provider instead, with a code spec 13 has a run record.
const cursorTag = "stowage-azure-blob-1:";

const unitDigits = 4;
const hexPosition = new RegExp(`^(?:[\\da-f]{${unitDigits}})*$`);

/** The provider's marker, as the opaque string that continues from there. */
export function encodeCursor(marker: string): string {
  return btoa(`${cursorTag}${hexOf(marker)}`);
}

/** The marker the cursor continues from, or `undefined` for one this adapter did not produce. */
export function decodeCursor(cursor: string): string | undefined {
  let decoded: string;

  try {
    decoded = atob(cursor);
  } catch {
    return undefined;
  }

  if (!decoded.startsWith(cursorTag)) return undefined;

  const position = decoded.slice(cursorTag.length);

  return position.length > 0 && hexPosition.test(position) ? markerOf(position) : undefined;
}

// Azure does not promise the marker stays ASCII, and `btoa` takes nothing else, so the
// marker goes out one UTF-16 code unit at a time.
function hexOf(marker: string): string {
  const units: string[] = [];

  for (let index = 0; index < marker.length; index += 1) {
    units.push(marker.charCodeAt(index).toString(16).padStart(unitDigits, "0"));
  }

  return units.join("");
}

function markerOf(position: string): string {
  const units: string[] = [];

  for (let index = 0; index < position.length; index += unitDigits) {
    units.push(String.fromCharCode(Number.parseInt(position.slice(index, index + unitDigits), 16)));
  }

  return units.join("");
}
