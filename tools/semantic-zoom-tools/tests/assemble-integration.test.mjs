// End-to-end CLI tests — spawn the real scripts as subprocesses (rather than
// importing main() directly) so they're exercised exactly as the skill and
// a human actually invoke them, including argv parsing and process exit
// codes. Each test works in its own temp copy so runs never interfere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'zoom-tools-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(script, args) {
  return execFileSync('node', [join(SCRIPTS, script), ...args], { encoding: 'utf8' });
}

function runExpectFailure(script, args) {
  let failed = false;
  let stderr = '';
  try {
    run(script, args);
  } catch (e) {
    failed = true;
    stderr = e.stderr ?? e.message;
  }
  // The assertion lives OUTSIDE the try — an earlier version put assert.fail
  // inside it, where the catch swallowed its AssertionError and returned it
  // as if it were stderr, letting a should-have-failed command pass.
  assert.ok(failed, `expected ${script} ${args.join(' ')} to fail, but it succeeded`);
  return stderr;
}

const SIMPLE_MD = '# Title\n\nOne paragraph.\n\nAnother paragraph.\n';

/** One section holding `ids` under one meta node — the minimal valid layers. */
function makeLayers(ids, sectionOverrides = {}) {
  return {
    meta: [{ title: 'Meta', body: 'body', sections: ['s1'] }],
    sections: [{ key: 's1', title: 'Section', body: 'body', paragraphs: ids, ...sectionOverrides }],
  };
}

/** Write doc + segment it + write layers covering all blocks; returns paths. */
function setUp(dir, md = SIMPLE_MD, layersFor = (ids) => makeLayers(ids)) {
  const mdPath = join(dir, 'doc.md');
  writeFileSync(mdPath, md, 'utf8');
  const segments = JSON.parse(run('segment.mjs', [mdPath]));
  const layersPath = join(dir, 'layers.json');
  writeFileSync(layersPath, JSON.stringify(layersFor(segments.blocks.map((b) => b.id))), 'utf8');
  return { mdPath, layersPath, segments };
}

test('re-running assemble.mjs on an already-tagged file converges to byte-identical output (idempotency)', () => {
  withTempDir((dir) => {
    const { mdPath, layersPath } = setUp(dir);
    run('assemble.mjs', [mdPath, layersPath]);
    const first = readFileSync(mdPath, 'utf8');
    run('assemble.mjs', [mdPath, layersPath]);
    const second = readFileSync(mdPath, 'utf8');
    assert.equal(first, second);
  });
});

test('a non-contiguous section grouping is rejected, not silently accepted', () => {
  withTempDir((dir) => {
    const { mdPath, layersPath, segments } = setUp(dir);
    const ids = segments.blocks.map((b) => b.id);
    assert.ok(ids.length >= 3, 'fixture needs at least 3 blocks for a real gap');
    // Skips the middle id — not a contiguous run.
    writeFileSync(layersPath, JSON.stringify(makeLayers([ids[0], ids[2]])), 'utf8');
    const stderr = runExpectFailure('assemble.mjs', [mdPath, layersPath]);
    assert.match(stderr, /contiguous/i);
  });
});

test('assemble.mjs + validate.mjs agree: a freshly assembled file always validates clean', () => {
  withTempDir((dir) => {
    const { mdPath, layersPath } = setUp(dir);
    run('assemble.mjs', [mdPath, layersPath]);
    run('validate.mjs', [mdPath]); // exits nonzero (throws) on any finding
  });
});

test('a document whose own prose describes the marker syntax tags correctly instead of truncating (bug #3, end-to-end)', () => {
  withTempDir((dir) => {
    const content =
      '# About the format\n\n' +
      'This format uses a `<!-- semantic-zoom:payload:v1 ... -->` marker at the end.\n\n' +
      'This second paragraph must still exist after assembly.\n';
    const { mdPath, layersPath, segments } = setUp(dir, content);
    assert.equal(segments.blocks.length, 3, 'heading + 2 prose paragraphs, none swallowed');
    run('assemble.mjs', [mdPath, layersPath]);
    const assembled = readFileSync(mdPath, 'utf8');
    assert.match(assembled, /This second paragraph must still exist after assembly\./);
    run('validate.mjs', [mdPath]);
  });
});

test('content appended AFTER the payload survives re-assembly as document body (no silent data loss)', () => {
  withTempDir((dir) => {
    const { mdPath, layersPath } = setUp(dir);
    run('assemble.mjs', [mdPath, layersPath]);
    // Append after the (invisible) payload comment — the natural EOF append.
    // Includes a stray '-->' to also cover the first-tail detection rule.
    writeFileSync(mdPath, readFileSync(mdPath, 'utf8') + '\nAppended paragraph: A --> B.\n', 'utf8');
    // Refresh flow: re-segment (content changed), rebuild layers, re-assemble.
    const segments = JSON.parse(run('segment.mjs', [mdPath]));
    writeFileSync(layersPath, JSON.stringify(makeLayers(segments.blocks.map((b) => b.id))), 'utf8');
    run('assemble.mjs', [mdPath, layersPath]);
    const out = readFileSync(mdPath, 'utf8');
    const preMarker = out.slice(0, out.indexOf('<!-- semantic-zoom:payload:v1'));
    assert.match(preMarker, /Appended paragraph: A --> B\./, 'appended text must move into the body, not be deleted');
    run('validate.mjs', [mdPath]);
  });
});

test('a section body quoting the marker head text is escaped in the payload, keeping the file detectable and idempotent', () => {
  withTempDir((dir) => {
    const quotingBody = 'The file ends with a <!-- semantic-zoom:payload:v1 marker block.';
    const { mdPath, layersPath } = setUp(dir, SIMPLE_MD, (ids) => makeLayers(ids, { body: quotingBody }));
    run('assemble.mjs', [mdPath, layersPath]);
    const out = readFileSync(mdPath, 'utf8');
    // Exactly ONE literal head in the file bytes: the real marker. The
    // quoted copy inside the JSON must be escaped so neither this tool's
    // detection nor the app's rfind can land on it.
    const occurrences = out.split('<!-- semantic-zoom:payload:v1').length - 1;
    assert.equal(occurrences, 1);
    // And the escaped body round-trips: re-assembly stays byte-identical.
    run('assemble.mjs', [mdPath, layersPath]);
    assert.equal(readFileSync(mdPath, 'utf8'), out);
    run('validate.mjs', [mdPath]);
  });
});

test('a damaged payload at EOF fails loudly instead of being silently embedded as content', () => {
  withTempDir((dir) => {
    const { mdPath, layersPath } = setUp(dir);
    run('assemble.mjs', [mdPath, layersPath]);
    // Corrupt the payload: truncate the middle of the JSON.
    const tagged = readFileSync(mdPath, 'utf8');
    const head = tagged.indexOf('<!-- semantic-zoom:payload:v1');
    const corrupted = tagged.slice(0, head + 120) + '\n-->\n';
    writeFileSync(mdPath, corrupted, 'utf8');
    const stderr = runExpectFailure('assemble.mjs', [mdPath, layersPath]);
    assert.match(stderr, /damaged|corrupt/i);
    assert.match(stderr, /delete the block|version control/i, 'error must tell the user how to recover');
  });
});

test('the CLI runs even when invoked through a symlinked path containing spaces (guard regression)', () => {
  withTempDir((dir) => {
    const { mdPath, layersPath } = setUp(dir);
    // A dir name with a space, containing a symlink to the real script —
    // both conditions individually broke the previous naive URL-string
    // guard, making the script exit 0 without doing anything.
    const weird = join(dir, 'weird path');
    mkdirSync(weird);
    const link = join(weird, 'assemble-link.mjs');
    symlinkSync(join(SCRIPTS, 'assemble.mjs'), link);
    const stdout = execFileSync('node', [link, mdPath, layersPath], { encoding: 'utf8' });
    assert.match(stdout, /assembled:/, 'main() must actually run through the symlinked, space-containing path');
    run('validate.mjs', [mdPath]);
  });
});
