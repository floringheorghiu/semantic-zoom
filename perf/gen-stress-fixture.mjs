// perf/gen-stress-fixture.mjs
//
// PERF HARNESS (Task 2.5) — NOT a `fixtures/` oracle.
//
// Generates the "5,000-line agent log with ~40 code blocks" that
// docs/Implementation_Plan.md §4.3 names as the focus-mask Instruments
// acceptance-test artifact ("open a 5,000-line agent log with ~40 code
// blocks, hold ⌥ and arrow the caret across group boundaries continuously
// for 10 s. Instruments → Core Animation must show no main-thread frame
// > 8 ms attributable to the mask, and no memory growth from layer
// promotion.").
//
// Shares the exact D6 id-derivation logic with gen-synthetic.mjs (Task 3.4)
// so the output is a valid `Native` payload the app can actually open.
// Output is written to `perf/stress-fixture.md` (gitignored).
//
// If the Rust pipeline rejects the output, fix THIS generator — never the Rust.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'stress-fixture.md');

const N_META = 5;
const SECTIONS_PER_META = 8; // 5 * 8 = 40 sections = 40 code blocks (one per section)
const PROSE_PARAS_PER_SECTION = 55; // tuned so total body lands near 5,000 lines
const MARKER_HEAD = '<!-- semantic-zoom:payload:v1';
const MARKER_TAIL = '-->';

const hash8 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);
const hashHex = (buf) => createHash('sha256').update(buf).digest('hex');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

const pOrdinal = new Map();
const sOrdinal = new Map();
const nextOrdinal = (map, h) => {
  const n = map.get(h) ?? 0;
  map.set(h, n + 1);
  return n;
};

const TOOL_NAMES = ['Read', 'Edit', 'Bash', 'Write', 'Grep'];
const LOG_VERBS = [
  'Inspected', 'Patched', 'Ran the test suite after modifying', 'Reverted',
  'Diffed', 'Reviewed the failing assertion in', 'Re-ran the linter over',
  'Traced the stack overflow back to',
];

let sectionCounter = 0;
let codeBlockCounter = 0;

for (let m = 0; m < N_META; m++) {
  const mid = `M${m + 1}`;
  const metaChildren = [];

  push(`# Agent session ${m + 1}: ${TOOL_NAMES[m % TOOL_NAMES.length]}-heavy log slot\n\n`);

  for (let sInMeta = 0; sInMeta < SECTIONS_PER_META; sInMeta++) {
    const sIdx = sectionCounter++;
    const heading = `## Step ${sIdx}: ${LOG_VERBS[sIdx % LOG_VERBS.length]} src/module_${sIdx}.ts`;
    const sHash = hash8(Buffer.from(heading, 'utf8'));
    const sOrd = nextOrdinal(sOrdinal, sHash);
    const sid = `S-${sHash}-${sOrd}`;

    push(`${heading}\n\n`);

    const sChildren = [];

    for (let p = 0; p < PROSE_PARAS_PER_SECTION; p++) {
      const globalIdx = order.paragraphs.length;
      const text =
        `Log entry ${globalIdx}: ${LOG_VERBS[(sIdx + p) % LOG_VERBS.length]} ` +
        `\`src/module_${sIdx}.ts\` at line ${100 + p * 7}, cross-checking against the ` +
        `expected behavior described in the task brief before moving to the next file.`;

      const start = byteCursor;
      push(text);
      const end = byteCursor;
      push('\n\n');

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

    // One fenced code block per section => N_META * SECTIONS_PER_META code blocks.
    codeBlockCounter++;
    const codeLines = [
      `$ npm test -- module_${sIdx}`,
      '',
      `FAIL  src/module_${sIdx}.test.ts`,
      `  ✗ handles the edge case (12 ms)`,
      '',
      `    expected 200 to equal 204`,
      '',
      `      at Object.<anonymous> (src/module_${sIdx}.test.ts:${40 + sIdx}:5)`,
      '',
      `Tests: 1 failed, 14 passed, 15 total`,
    ];
    const codeText = codeLines.join('\n');

    push('```text\n');
    const codeStart = byteCursor;
    push(codeText); // span covers ONLY this — must match what's hashed below
    const codeEnd = byteCursor;
    push('\n```');
    push('\n\n');

    const codeHash = hash8(Buffer.from(codeText, 'utf8'));
    const codeOrd = nextOrdinal(pOrdinal, codeHash);
    const codePid = `P-${codeHash}-${codeOrd}`;

    paragraphs[codePid] = {
      id: codePid,
      level: 0,
      parent: sid,
      kind: 'code',
      span: { start: codeStart, end: codeEnd },
      html: `<pre><code>${esc(codeText)}</code></pre>`,
      lang: 'text',
    };
    order.paragraphs.push(codePid);
    sChildren.push(codePid);

    sections[sid] = {
      id: sid,
      level: -1,
      parent: mid,
      children: sChildren,
      title: `Step ${sIdx}`,
      body: `Synthetic stress-fixture section ${sIdx} (Task 2.5 §4.3 acceptance artifact).`,
    };
    order.sections.push(sid);
    metaChildren.push(sid);
  }

  meta[mid] = {
    id: mid,
    level: -2,
    children: metaChildren,
    title: `Agent session ${m + 1}`,
    body: `Synthetic stress-fixture meta slot ${m + 1} (Task 2.5 §4.3 acceptance artifact).`,
  };
  order.meta.push(mid);
}

const body = chunks.join('');
const docHash = hashHex(Buffer.from(body, 'utf8'));

const table = { version: 1, docHash, meta, sections, paragraphs, order };
const json = JSON.stringify(table);

const out = `${body}${MARKER_HEAD}\n${json}\n${MARKER_TAIL}`;
writeFileSync(OUT, out, 'utf8');

const bodyLines = body.split('\n').length;
console.log(`Wrote ${OUT}`);
console.log(`  pre-payload body lines: ${bodyLines} (target ~5,000)`);
console.log(`  code blocks           : ${codeBlockCounter} (target ~40)`);
console.log(`  paragraphs             : ${order.paragraphs.length}`);
console.log(`  sections               : ${order.sections.length}`);
console.log(`  meta                   : ${order.meta.length}`);
