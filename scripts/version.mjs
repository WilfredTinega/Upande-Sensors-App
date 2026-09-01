#!/usr/bin/env node
/**
 * Odometer versioning for the Expo app.
 *
 * Every merge to the release branch advances the version by exactly one step.
 * The digits roll over like an odometer with fixed limits:
 *
 *   patch (z) counts 0..99  — 1.0.99 + 1 -> 1.1.0
 *   minor (y) counts 0..49  — 1.49.99 + 1 -> 2.0.0
 *   major (x) is unbounded
 *
 * Because the limits are fixed, a version maps one-to-one onto a plain counter,
 * which is exactly what Android's versionCode wants:
 *
 *   versionCode = (major * 50 + minor) * 100 + patch
 *
 * So versionCode is dense, strictly increasing, and needs no external state.
 *
 * Single source of truth for the version is app.json -> expo.version.
 * package.json is kept in sync so `npm version`-style tooling stays honest.
 *
 * Usage:
 *   node scripts/version.mjs                 # print the next version (dry run)
 *   node scripts/version.mjs --json          # machine-readable, for CI outputs
 *   node scripts/version.mjs --apply         # write app.json + package.json
 *   node scripts/version.mjs --bump minor    # skip ahead to the next minor/major
 *   node scripts/version.mjs --notes         # print the release notes markdown
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_JSON = resolve(ROOT, 'app.json');
const PKG_JSON = resolve(ROOT, 'package.json');

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
const flagValue = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

function git(...args) {
  try {
    // stderr is swallowed: `git describe` on a repo with no tags is an expected
    // state (the first release), not something worth printing.
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** Most recent v* tag, or null on a repo that has never been released. */
function lastTag() {
  return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*') || null;
}

/**
 * Commits since the last tag. Records are NUL-separated so multi-line bodies
 * (where BREAKING CHANGE: footers live) survive parsing intact.
 */
function commitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const raw = git('log', range, '--no-merges', '--format=%H%x1f%s%x1f%b%x1e');
  if (!raw) return [];
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, subject, body] = record.split('\x1f');
      return { hash, subject: subject ?? '', body: body ?? '' };
    });
}

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s*(?<description>.+)$/i;

function parse(commit) {
  const match = HEADER.exec(commit.subject);
  const breaking =
    Boolean(match?.groups?.breaking) || /^BREAKING[ -]CHANGE:/m.test(commit.body);
  return {
    ...commit,
    type: match?.groups?.type?.toLowerCase() ?? null,
    scope: match?.groups?.scope ?? null,
    description: match?.groups?.description ?? commit.subject,
    breaking,
  };
}

/** Odometer limits: patch wraps at 100, minor wraps at 50. */
const PATCH_LIMIT = 100;
const MINOR_LIMIT = 50;

function parseVersion(version) {
  const parts = version.split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`Not a valid x.y.z version: ${version}`);
  }
  const [major, minor, patch] = parts;
  if (minor >= MINOR_LIMIT) {
    throw new Error(`Minor ${minor} in ${version} is out of range (max ${MINOR_LIMIT - 1}).`);
  }
  if (patch >= PATCH_LIMIT) {
    throw new Error(`Patch ${patch} in ${version} is out of range (max ${PATCH_LIMIT - 1}).`);
  }
  return { major, minor, patch };
}

/**
 * One odometer step. `bump` normally stays 'patch' — one merge, one click. The
 * 'minor'/'major' overrides skip the remaining digits, for when a release is
 * significant enough to deserve a round number.
 */
function nextVersion(current, bump = 'patch') {
  let { major, minor, patch } = parseVersion(current);

  if (bump === 'major') {
    return `${major + 1}.0.0`;
  }
  if (bump === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }

  if (patch >= PATCH_LIMIT) {
    patch = 0;
    minor += 1;
  }
  if (minor >= MINOR_LIMIT) {
    minor = 0;
    major += 1;
  }
  return `${major}.${minor}.${patch}`;
}

/**
 * Play Store requires a monotonically increasing integer. Since the odometer
 * limits are fixed, the version *is* a counter in disguise — just read it back
 * out. No external state, and it never collides or goes backwards.
 */
/**
 * The runtime a version belongs to: everything sharing `major.minor` can accept
 * the same JS bundle. Mirrors `runtimeVersionOf` in src/api/updates.js, which
 * is the app-side reader of the same rule.
 */
function runtimeVersionFor(version) {
  const { major, minor } = parseVersion(version);
  return `${major}.${minor}`;
}

function versionCodeFor(version) {
  const { major, minor, patch } = parseVersion(version);
  return (major * MINOR_LIMIT + minor) * PATCH_LIMIT + patch;
}

const SECTIONS = [
  ['feat', 'Features'],
  ['fix', 'Bug Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['docs', 'Documentation'],
  ['build', 'Build System'],
  ['ci', 'CI'],
  ['chore', 'Chores'],
];

function releaseNotes(version, commits, tag) {
  const line = (c) =>
    `- ${c.scope ? `**${c.scope}:** ` : ''}${c.description} (${c.hash.slice(0, 7)})`;

  const out = [`## v${version}`, ''];

  const breaking = commits.filter((c) => c.breaking);
  if (breaking.length) {
    out.push('### ⚠ BREAKING CHANGES', '', ...breaking.map(line), '');
  }

  for (const [type, heading] of SECTIONS) {
    const matching = commits.filter((c) => c.type === type && !c.breaking);
    if (matching.length) out.push(`### ${heading}`, '', ...matching.map(line), '');
  }

  const other = commits.filter(
    (c) => !c.breaking && !SECTIONS.some(([type]) => type === c.type),
  );
  if (other.length) out.push('### Other', '', ...other.map(line), '');

  if (commits.length === 0) out.push('_No commits since the previous release._', '');

  const repo = process.env.GITHUB_REPOSITORY;
  if (repo && tag) {
    out.push(
      `**Full changelog:** https://github.com/${repo}/compare/${tag}...v${version}`,
      '',
    );
  }

  return out.join('\n');
}

// --- main -------------------------------------------------------------------

const appConfig = JSON.parse(readFileSync(APP_JSON, 'utf8'));
const pkg = JSON.parse(readFileSync(PKG_JSON, 'utf8'));

const currentVersion = appConfig.expo.version;
const tag = lastTag();
const commits = commitsSince(tag).map(parse);
// Always one step per merge; --bump only exists to skip to a round number.
const bump = flagValue('bump') ?? 'patch';
const version = hasFlag('keep-version') ? currentVersion : nextVersion(currentVersion, bump);
const versionCode = versionCodeFor(version);

if (hasFlag('apply')) {
  appConfig.expo.version = version;
  appConfig.expo.android = { ...appConfig.expo.android, versionCode };
  /**
   * The compatibility gate for over-the-air updates, kept in step with the
   * version by the same command that sets it.
   *
   * `major.minor` is already what this odometer means: a normal merge bumps the
   * patch, and `--bump minor` is the deliberate "something native changed"
   * signal. Writing that pair as `runtimeVersion` makes the rule enforceable
   * rather than merely documented — `expo-updates` refuses a bundle whose
   * runtime does not match the installed build, so a 1.1.0 device can never be
   * handed a 1.0.x JS bundle, and a 1.0.x device is told to fetch the APK.
   *
   * Set even before an update server exists: it costs nothing, and it must
   * already be correct in the build that is running when one is turned on.
   */
  const runtime = runtimeVersionFor(version);
  appConfig.expo.runtimeVersion = runtime;
  /**
   * The update URL carries the runtime, and that is what makes a static host
   * viable at all.
   *
   * The Expo Updates protocol sends the runtime as a *request header*, which no
   * static file server can vary a response on. But `updates.url` is baked into
   * each build — so a 1.0.x APK only ever asks for the 1.0 manifest, and a 1.1
   * build only ever asks for 1.1. The gate moves from the server to the URL,
   * and it becomes physically impossible to hand a 1.0 device a 1.1 bundle.
   */
  if (appConfig.expo.updates?.url) {
    appConfig.expo.updates.url = appConfig.expo.updates.url.replace(
      /\/ota\/android\/[^/]+\/manifest\.json$/,
      `/ota/android/${runtime}/manifest.json`,
    );
  }
  writeFileSync(APP_JSON, `${JSON.stringify(appConfig, null, 2)}\n`);

  pkg.version = version;
  writeFileSync(PKG_JSON, `${JSON.stringify(pkg, null, 2)}\n`);
}

if (hasFlag('notes')) {
  process.stdout.write(releaseNotes(version, commits, tag));
} else if (hasFlag('json')) {
  process.stdout.write(
    `${JSON.stringify(
      {
        current: currentVersion,
        version,
        versionCode,
        runtimeVersion: runtimeVersionFor(version),
        bump,
        tag: `v${version}`,
        previousTag: tag,
        commitCount: commits.length,
        breaking: commits.filter((c) => c.breaking).length,
      },
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write(
    `${currentVersion} -> ${version} (${bump}, versionCode ${versionCode}, ` +
      `${commits.length} commit${commits.length === 1 ? '' : 's'} since ${tag ?? 'the beginning'})\n`,
  );
}
