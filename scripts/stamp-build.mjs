#!/usr/bin/env node
/**
 * Stamp build provenance into app.json -> expo.extra, before `expo prebuild`
 * bakes it into the APK's embedded manifest.
 *
 * Only the source repository is recorded, and only because the in-app update
 * check needs it: a build should look for newer versions in the repo it was
 * actually produced by, so a fork's APK checks the fork rather than silently
 * offering upstream's releases to its users.
 *
 * Nothing volatile goes in here on purpose. The release job commits app.json
 * back to the branch, so a build timestamp would add a spurious diff to every
 * release commit; for the canonical repo this value never changes at all.
 *
 * Usage: node scripts/stamp-build.mjs --repo owner/name
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_JSON = resolve(ROOT, 'app.json');

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const repo = flagValue('repo');
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error(`Expected --repo owner/name, got: ${repo ?? '(nothing)'}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(APP_JSON, 'utf8'));
const previous = config.expo.extra?.githubRepo;
config.expo.extra = { ...config.expo.extra, githubRepo: repo };
writeFileSync(APP_JSON, `${JSON.stringify(config, null, 2)}\n`);

console.log(
  previous === repo
    ? `extra.githubRepo already ${repo}`
    : `extra.githubRepo ${previous ?? '(unset)'} -> ${repo}`,
);
