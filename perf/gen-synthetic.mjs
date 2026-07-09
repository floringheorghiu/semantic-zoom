// perf/gen-synthetic.mjs
//
// PERF HARNESS (Task 3.4) — NOT a `fixtures/` oracle.
//
// Generates a ~1 MB / ~10,000-paragraph markdown document with a VALID,
// D6-hashed semantic-zoom payload appended at EOF. The output is written to
// `perf/synthetic-1mb.md` (gitignored) and is consumed by the Rust extraction
// timing test `src-tauri/tests/perf_extract.rs`.
//
// Contract it must honour so the Rust pipeline accepts it:
//   * A1: `docHash` = sha256 hex of ALL bytes preceding the payload marker.
//   * A2: every paragraph `span {start,end}` is a BYTE range into that same
//         pre-payload region.
//   * A4/D6: paragraph id = `P-<sha256(spanBytes)[:8]>-<ordinal>` (ordinal is the
//         0-based count among identical-hash slices, in document order); section
//         id = `S-<sha256(leadingBlockBytes)[:8]>-<ordinal>`; meta ids are
//         positional `M1..`.
//   * validate(): every paragraph.parent is a section, every section.parent is a
//         meta, every section.children entry is a real paragraph.
//
// If the Rust pipeline rejects the output, fix THIS generator — never the Rust.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'synthetic-1mb.md');

const N_META = 10;
const N_SECTIONS = 200; // 20 sections per meta
const PARAS_PER_SECTION = 50; // 200 * 50 = 10,000 paragraphs
const MARKER_HEAD = '<!-- semantic-zoom:payload:v1';
const MARKER_TAIL = '-->';

const hash8 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);
const hashHex = (buf) => createHash('sha256').update(buf).digest('hex');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- Build the pre-payload markdown body first, tracking byte offsets. --------
const chunks = [];
let byteCursor = 0;
const push = (text) => {
  chunks.push(text);
  byteCursor += Buffer.byteLength(text, 'utf8');
};

const meta = {};
const sections = {};
const paragraphs = {};
const order = { meta: [], sections: [], paragraphs: [] };

// Ordinal bookkeeping: 0-based count among identical-hash slices, doc order.
const pOrdinal = new Map();
const sOrdinal = new Map();
const nextOrdinal = (map, h) => {
  const n = map.get(h) ?? 0;
  map.set(h, n + 1);
  return n;
};

let sectionCounter = 0;

for (let m = 0; m < N_META; m++) {
  const mid = `M${m + 1}`;
  const sectionsPerMeta = N_SECTIONS / N_META;
  const metaChildren = [];

  // A meta-level H1 heading (visible prose; meta ids stay positional so this
  // block is not hashed into the id, but it is part of the pre-payload bytes).
  push(`# Meta ${m + 1}: synthetic narrative slot\n\n`);

  for (let sInMeta = 0; sInMeta < sectionsPerMeta; sInMeta++) {
    const sIdx = sectionCounter++;

    // Section leading block = the heading line (its bytes seed the S id per D6).
    const heading = `## Section ${sIdx}: generated grouping`;
    const sHash = hash8(Buffer.from(heading, 'utf8'));
    const sOrd = nextOrdinal(sOrdinal, sHash);
    const sid = `S-${sHash}-${sOrd}`;

    push(`${heading}\n\n`);

    const sChildren = [];
    for (let p = 0; p < PARAS_PER_SECTION; p++) {
      // Unique, ASCII, ~100-byte prose so bytes (and hence hashes) vary.
      const globalIdx = order.paragraphs.length;
      const text =
        `Paragraph ${globalIdx} in section ${sIdx}. ` +
        `Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.`;

      const start = byteCursor;
      push(text);
      const end = byteCursor;
      push('\n\n'); // block separator (outside the hashed span)

      const pHash = hash8(Buffer.from(text, 'utf8'));
      const pOrd = nextOrdinal(pOrdinal, pHash);
      const pid = `P-${pHash}-${pOrd}`;

      paragraphs[pid] = {
        id: pid,
        level: 0,
        parent: sid,
        kind: 'prose',
        span: { start, end },
        html: `<p>${esc(text)}</p>`,
      };
      order.paragraphs.push(pid);
      sChildren.push(pid);
    }

    sections[sid] = {
      id: sid,
      level: -1,
      parent: mid,
      children: sChildren,
      title: `Section ${sIdx}`,
      body: `Plain-English walkthrough of section ${sIdx}.`,
    };
    order.sections.push(sid);
    metaChildren.push(sid);
  }

  meta[mid] = {
    id: mid,
    level: -2,
    children: metaChildren,
    title: `Meta ${m + 1}`,
    body: `Accomplished / blockers / next steps for narrative slot ${m + 1}.`,
  };
  order.meta.push(mid);
}

// Body ends with "\n\n" (last block separator); the marker is appended directly
// so the pre-payload region is EXACTLY this body — nothing injected between.
const body = chunks.join('');
const docHash = hashHex(Buffer.from(body, 'utf8'));

const table = { version: 1, docHash, meta, sections, paragraphs, order };
const json = JSON.stringify(table); // strings contain no `-->`, so no A3 escaping needed

const out = `${body}${MARKER_HEAD}\n${json}\n${MARKER_TAIL}`;
writeFileSync(OUT, out, 'utf8');

const bytes = Buffer.byteLength(out, 'utf8');
const bodyBytes = Buffer.byteLength(body, 'utf8');
console.log(`Wrote ${OUT}`);
console.log(`  total file size : ${bytes} bytes (${(bytes / 1_048_576).toFixed(2)} MiB)`);
console.log(`  pre-payload body: ${bodyBytes} bytes (${(bodyBytes / 1_048_576).toFixed(2)} MiB)`);
console.log(`  paragraphs      : ${order.paragraphs.length}`);
console.log(`  sections        : ${order.sections.length}`);
console.log(`  meta            : ${order.meta.length}`);
