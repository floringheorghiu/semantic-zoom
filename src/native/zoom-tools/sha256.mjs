// sha256.mjs — dependency-free, synchronous SHA-256 (FIPS 180-4).
//
// Why not `node:crypto` or `crypto.subtle`: this module is imported by BOTH
// the Node CLI (tools/semantic-zoom-tools/scripts/*.mjs) and the Tauri
// webview (src/native/engine-b-remote.ts) — it has to be plain, portable
// ESM with no Node built-ins. `crypto.subtle.digest` exists in both
// environments but is Promise-only, and `tests/segment.test.mjs` (an
// unmodifiable oracle, per CLAUDE.md) calls `segment()` synchronously —
// `const { blocks } = segment(source)` — so the hash underneath it must
// stay synchronous too. A small from-scratch implementation is the only
// option that is simultaneously portable and sync.
//
// Operates on Uint8Array in, hex string out — never on Node's `Buffer`.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

/** @param {Uint8Array} message @returns {Uint8Array} 32-byte digest */
export function sha256(message) {
  const bitLen = message.length * 8;
  // Padding: 0x80, then zeros, then 8-byte big-endian bit length, total
  // length a multiple of 64 bytes.
  const paddedLen = (((message.length + 9 + 63) / 64) | 0) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(message);
  padded[message.length] = 0x80;
  // bitLen fits in 32 bits for any realistic document; high 32 bits are 0.
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const H = H0.slice();
  const w = new Uint32Array(64);

  for (let chunk = 0; chunk < paddedLen; chunk += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(chunk + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }

    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i], false);
  return out;
}

function toHex(bytes) {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** SHA-256 of a UTF-8 string, full 64-char hex digest. */
export function sha256HexOfString(text) {
  return toHex(sha256(new TextEncoder().encode(text)));
}

/** SHA-256 of raw bytes, full 64-char hex digest. */
export function sha256HexOfBytes(bytes) {
  return toHex(sha256(bytes));
}

/** D6's `hash8`: first 8 hex chars of SHA-256(text), text given as UTF-8 string. */
export function contentHash8(text) {
  return sha256HexOfString(text).slice(0, 8);
}
