#!/usr/bin/env node
/**
 * Re-baseline the sha256 fingerprints in .pet-builder.json.
 *
 * The template-hash check in tools/doctor.mjs is a drift tripwire: it fails
 * whenever one of the listed critical files no longer matches its recorded
 * hash. That is correct for accidental edits, and annoying for intentional
 * ones (adding a dependency, wiring a new engine, ...). This script is the
 * "yes, I meant it" button.
 *
 * Usage:
 *   node tools/sync-critical-hashes.mjs           rewrite .pet-builder.json
 *   node tools/sync-critical-hashes.mjs --check   report drift only, change nothing
 *
 * After running it, always confirm with: npm run doctor
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const manifestPath = path.join(root, '.pet-builder.json');
const checkOnly = process.argv.includes('--check');

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const hashes = manifest.criticalFileHashes;
if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) {
  console.error('sync-critical-hashes: .pet-builder.json has no criticalFileHashes object.');
  process.exit(1);
}

const total = Object.keys(hashes).length;
const changed = [];
const unreadable = [];

for (const relative of Object.keys(hashes)) {
  let actual;
  try {
    actual = createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex');
  } catch (error) {
    unreadable.push({ relative, error: error instanceof Error ? error.message : String(error) });
    continue;
  }
  if (actual !== hashes[relative]) {
    changed.push({ relative, from: hashes[relative], to: actual });
    hashes[relative] = actual;
  }
}

if (unreadable.length > 0) {
  console.error('sync-critical-hashes: these files are missing or unreadable:');
  for (const item of unreadable) console.error(`- ${item.relative}: ${item.error}`);
  console.error('Fix that first; fingerprints of missing files must not be invented.');
  process.exit(1);
}

if (changed.length === 0) {
  console.log(`sync-critical-hashes: all ${total} fingerprints already match. Nothing to do.`);
  process.exit(0);
}

console.log(`${checkOnly ? 'drift detected' : 're-baselined'}: ${changed.length} of ${total} file(s)`);
for (const item of changed) {
  console.log(`- ${item.relative}`);
  console.log(`    was ${item.from}`);
  console.log(`    now ${item.to}`);
}

if (checkOnly) {
  console.log('\ndry run: .pet-builder.json was NOT modified.');
  process.exit(1);
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log('\n.pet-builder.json updated. Confirm with: npm run doctor');
