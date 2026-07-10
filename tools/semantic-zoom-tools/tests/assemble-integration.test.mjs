// End-to-end CLI tests — spawn the real scripts as subprocesses (rather than
// importing main() directly) so they're exercised exactly as the skill and
// a human actually invoke them, including argv parsing and process exit
// codes. Each test works in its own temp copy so runs never interfere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
  try {
    run(script, args);
    assert.fail(`expected ${script} ${args.join(' ')} to fail, but it succeeded`);
  } catch (e) {
    return e.stderr ?? e.message;
  }
}

const SIMPLE_MD = '# Title\n\nOne paragraph.\n\nAnother paragraph.\n';

function segmentSimple(dir) {
  const mdPath = join(dir, 'doc.md');
  writeFileSync(mdPath, SIMPLE_MD, 'utf8');
  const segments = JSON.parse(run('segment.mjs', [mdPath]));
  return { mdPath, segments };
}

test('re-running assemble.mjs on an already-tagged file converges to byte-identical output (idempotency)', () => {
  withTempDir((dir) => {
    const { mdPath, segments } = segmentSimple(dir);
    const layers = {
      meta: [{ title: 'Meta', body: 'body', sections: ['s1'] }],
      sections: [{ key: 's1', title: 'Section', body: 'body', paragraphs: segments.blocks.map((b) => b.id) }],
    };
    const layersPath = join(dir, 'layers.json');
    writeFileSync(layersPath, JSON.stringify(layers), 'utf8');

    run('assemble.mjs', [mdPath, layersPath]);
    const first = readFileSync(mdPath, 'utf8');
    run('assemble.mjs', [mdPath, layersPath]);
    const second = readFileSync(mdPath, 'utf8');

    assert.equal(first, second);
  });
});

test('a non-contiguous section grouping is rejected, not silently accepted', () => {
  withTempDir((dir) => {
    const { mdPath, segments } = segmentSimple(dir);
    const ids = segments.blocks.map((b) => b.id);
    assert.ok(ids.length >= 3, 'fixture needs at least 3 blocks for a real gap');
    const layers = {
      meta: [{ title: 'Meta', body: 'body', sections: ['s1'] }],
      // Skips the middle id — not a contiguous run.
      sections: [{ key: 's1', title: 'Section', body: 'body', paragraphs: [ids[0], ids[2]] }],
    };
    const layersPath = join(dir, 'layers.json');
    writeFileSync(layersPath, JSON.stringify(layers), 'utf8');

    const stderr = runExpectFailure('assemble.mjs', [mdPath, layersPath]);
    assert.match(stderr, /contiguous/i);
  });
});

test('assemble.mjs + validate.mjs agree: a freshly assembled file always validates clean', () => {
  withTempDir((dir) => {
    const { mdPath, segments } = segmentSimple(dir);
    const layers = {
      meta: [{ title: 'Meta', body: 'body', sections: ['s1'] }],
      sections: [{ key: 's1', title: 'Section', body: 'body', paragraphs: segments.blocks.map((b) => b.id) }],
    };
    const layersPath = join(dir, 'layers.json');
    writeFileSync(layersPath, JSON.stringify(layers), 'utf8');

    run('assemble.mjs', [mdPath, layersPath]);
    // validate.mjs exits 0 with no output on success; execFileSync throwing
    // means it didn't.
    assert.doesNotThrow(() => run('validate.mjs', [mdPath]));
  });
});

test('a document whose own prose describes the marker syntax tags correctly instead of truncating (bug #3, end-to-end)', () => {
  withTempDir((dir) => {
    const mdPath = join(dir, 'doc.md');
    const content =
      '# About the format\n\n' +
      'This format uses a `<!-- semantic-zoom:payload:v1 ... -->` marker at the end.\n\n' +
      'This second paragraph must still exist after assembly.\n';
    writeFileSync(mdPath, content, 'utf8');
    const segments = JSON.parse(run('segment.mjs', [mdPath]));
    assert.equal(segments.blocks.length, 3, 'heading + 2 prose paragraphs, none swallowed');

    const layers = {
      meta: [{ title: 'Meta', body: 'body', sections: ['s1'] }],
      sections: [{ key: 's1', title: 'Section', body: 'body', paragraphs: segments.blocks.map((b) => b.id) }],
    };
    writeFileSync(join(dir, 'layers.json'), JSON.stringify(layers), 'utf8');
    run('assemble.mjs', [mdPath, join(dir, 'layers.json')]);

    const assembled = readFileSync(mdPath, 'utf8');
    assert.match(assembled, /This second paragraph must still exist after assembly\./);
    assert.doesNotThrow(() => run('validate.mjs', [mdPath]));
  });
});
