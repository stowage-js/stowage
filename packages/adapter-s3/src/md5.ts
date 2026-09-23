/** The per-round shift amounts of RFC 1321, section 3.4. */
const shifts: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** `floor(abs(sin(i + 1)) × 2^32)`, the table T of RFC 1321, section 3.4. */
const sines: readonly number[] = Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 2 ** 32) >>> 0,
);

const blockBytes = 64;

type State = [a: number, b: number, c: number, d: number];

/**
 * The base64 of the MD5 digest, which is the form `Content-MD5` carries. `DeleteObjects`
 * is the one request AWS refuses without an integrity header, and ADR 0009 sends no
 * `x-amz-checksum-*`; Web Crypto offers no MD5 and `node:crypto` is not on every runtime
 * of spec 2, so the digest is computed here.
 */
export function md5Base64(message: Uint8Array): string {
  const digest = md5(message);

  return btoa(String.fromCharCode(...digest));
}

function md5(message: Uint8Array): Uint8Array {
  const padded = pad(message);
  const words = new DataView(padded.buffer);
  const state: State = [0x67_45_23_01, 0xef_cd_ab_89, 0x98_ba_dc_fe, 0x10_32_54_76];

  for (let offset = 0; offset < padded.byteLength; offset += blockBytes) {
    compress(state, words, offset);
  }

  const digest = new Uint8Array(16);
  const view = new DataView(digest.buffer);

  for (const [index, word] of state.entries()) view.setUint32(index * 4, word, true);

  return digest;
}

/** A `1` bit, zeros up to 56 bytes into a block, and the bit length as 64 bits, low first. */
function pad(message: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = Math.ceil((message.byteLength + 9) / blockBytes) * blockBytes;
  const padded = new Uint8Array(length);
  const view = new DataView(padded.buffer);
  const bits = message.byteLength * 8;

  padded.set(message);
  padded[message.byteLength] = 0x80;
  view.setUint32(length - 8, bits >>> 0, true);
  view.setUint32(length - 4, Math.floor(bits / 2 ** 32), true);

  return padded;
}

function compress(state: State, words: DataView, offset: number): void {
  let [a, b, c, d] = state;

  for (let round = 0; round < 64; round += 1) {
    let mixed: number;
    let word: number;

    if (round < 16) {
      mixed = (b & c) | (~b & d);
      word = round;
    } else if (round < 32) {
      mixed = (d & b) | (~d & c);
      word = (5 * round + 1) % 16;
    } else if (round < 48) {
      mixed = b ^ c ^ d;
      word = (3 * round + 5) % 16;
    } else {
      mixed = c ^ (b | ~d);
      word = (7 * round) % 16;
    }

    const sum = (a + mixed + (sines[round] ?? 0) + words.getUint32(offset + word * 4, true)) >>> 0;
    const shift = shifts[round] ?? 0;

    a = d;
    d = c;
    c = b;
    b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
  }

  state[0] = (state[0] + a) >>> 0;
  state[1] = (state[1] + b) >>> 0;
  state[2] = (state[2] + c) >>> 0;
  state[3] = (state[3] + d) >>> 0;
}
