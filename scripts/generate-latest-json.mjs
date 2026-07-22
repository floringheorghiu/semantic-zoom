#!/usr/bin/env node
// generate-latest-json.mjs — assembles latest.json (the Tauri updater's
// manifest format) from the just-built, just-signed macOS update artifact
// plus the GitHub release notes for this tag. Run in CI (release.yml)
// AFTER `gh release create` has published the release (so its notes exist)
// and AFTER `npm run build:dmg` has produced the signed .app.tar.gz.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const tag = process.argv[2];
if (!tag) {
  console.error('usage: generate-latest-json.mjs <tag>');
  process.exit(1);
}
const version = tag.replace(/^v/, '');

const macosDir = 'src-tauri/target/release/bundle/macos';
const files = readdirSync(macosDir);
const tarballName = files.find((f) => f.endsWith('.app.tar.gz'));
const sigName = files.find((f) => f.endsWith('.app.tar.gz.sig'));
if (!tarballName || !sigName) {
  console.error(`generate-latest-json: no .app.tar.gz/.sig found in ${macosDir}`);
  process.exit(1);
}
const signature = readFileSync(`${macosDir}/${sigName}`, 'utf8').trim();

const notes = execSync(`gh release view "${tag}" --json body -q .body`, { encoding: 'utf8' });
const arch = execSync('uname -m', { encoding: 'utf8' }).trim() === 'arm64' ? 'aarch64' : 'x86_64';
const platformKey = `darwin-${arch}`;

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    [platformKey]: {
      signature,
      url: `https://github.com/floringheorghiu/semantic-zoom/releases/download/${tag}/${tarballName}`,
    },
  },
};

writeFileSync('latest.json', JSON.stringify(manifest, null, 2));
console.log(`generate-latest-json: wrote latest.json for ${platformKey} ${version}`);
