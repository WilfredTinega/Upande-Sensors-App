#!/usr/bin/env node
/**
 * Build a JavaScript-only update and lay it out as static files.
 *
 * A patch release (1.0.5 -> 1.0.6) cannot contain native changes, so it does not
 * need a 74MB APK — it needs the JS bundle and its assets, which is about a
 * megabyte. This produces the tree GitHub Pages then serves:
 *
 *   ota/android/<runtime>/manifest.json     the Expo Updates manifest
 *   ota/android/<runtime>/bundles/...        the JS bundle
 *   ota/android/<runtime>/assets/...         fonts, images
 *
 * ── Why a static host can work at all ────────────────────────────────────────
 *
 * The Expo Updates protocol sends the runtime version as a *request header*, and
 * no static file server can vary a response on a header. But `updates.url` is
 * baked into each build, and `scripts/version.mjs` writes the runtime into it —
 * so a 1.0.x app only ever requests the 1.0 manifest and a 1.1 app only ever
 * requests 1.1. The compatibility gate moves from the server to the URL, where a
 * static host can honour it, and it becomes impossible to hand a 1.0 device a
 * 1.1 bundle.
 *
 * ── What this does NOT do ────────────────────────────────────────────────────
 *
 * No code signing. `expo-updates` supports signed manifests, and a static host
 * can serve a signature just as well as a manifest — but the key has to be
 * generated and stored as a secret first, so it is a deliberate follow-up rather
 * than something to half-do here. Until then the trust boundary is HTTPS and
 * write access to the Pages branch.
 *
 * Usage:
 *   node scripts/publish-ota.mjs              # build into ./ota
 *   node scripts/publish-ota.mjs --out dist   # somewhere else
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_JSON = join(ROOT, 'app.json');

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const OUT = resolve(ROOT, outFlag === -1 ? 'ota' : args[outFlag + 1] || 'ota');

const appConfig = JSON.parse(readFileSync(APP_JSON, 'utf8'));
const { version, runtimeVersion } = appConfig.expo;
if (!runtimeVersion) {
  console.error('app.json has no expo.runtimeVersion — run `node scripts/version.mjs --apply` first.');
  process.exit(2);
}

const EXPORT_DIR = join(ROOT, '.ota-export');
rmSync(EXPORT_DIR, { recursive: true, force: true });

console.log(`Exporting ${version} (runtime ${runtimeVersion})…`);
execFileSync(
  'npx',
  ['expo', 'export', '--platform', 'android', '--output-dir', EXPORT_DIR],
  { cwd: ROOT, stdio: 'inherit' },
);

/** Every file under `dir`, as paths relative to it. */
function walk(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full, base) : [relative(base, full)];
  });
}

/**
 * The hash the client verifies, in the encoding the protocol wants: base64url
 * of the raw SHA-256, with the padding stripped. Hex would be silently rejected.
 */
function hashOf(path) {
  return createHash('sha256').update(readFileSync(path)).digest('base64url');
}

const metadata = JSON.parse(readFileSync(join(EXPORT_DIR, 'metadata.json'), 'utf8'));
const android = metadata.fileMetadata?.android;
if (!android) {
  console.error('The export produced no android metadata — nothing to publish.');
  process.exit(1);
}

const runtimeDir = join(OUT, 'android', runtimeVersion);
rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(runtimeDir, { recursive: true });

// Copy the export wholesale; the manifest below points into it by relative path.
for (const sub of ['bundles', 'assets']) {
  const from = join(EXPORT_DIR, sub);
  if (existsSync(from)) cpSync(from, join(runtimeDir, sub), { recursive: true });
}

const base = (appConfig.expo.updates?.url || '').replace(/\/manifest\.json$/, '');
if (!base) {
  console.error('app.json has no expo.updates.url — nothing to build absolute asset URLs from.');
  process.exit(2);
}

const assetEntry = (relPath, key) => ({
  hash: hashOf(join(runtimeDir, relPath)),
  key,
  contentType: relPath.endsWith('.js') ? 'application/javascript' : 'application/octet-stream',
  fileExtension: `.${relPath.split('.').pop()}`,
  url: `${base}/${relPath.split(/[\\/]/).join('/')}`,
});

const manifest = {
  // A new id per publish: this is the identity the client compares against what
  // it is already running, so reusing one would make an update invisible.
  id: randomUUID(),
  createdAt: new Date().toISOString(),
  runtimeVersion,
  launchAsset: {
    ...assetEntry(android.bundle, 'bundle'),
    contentType: 'application/javascript',
  },
  assets: (android.assets || []).map((asset) => {
    const relPath = join('assets', asset.path.replace(/^assets[\\/]/, ''));
    const onDisk = existsSync(join(runtimeDir, relPath)) ? relPath : asset.path;
    return { ...assetEntry(onDisk, asset.path), fileExtension: `.${asset.ext}` };
  }),
  metadata: {},
  extra: {
    // Carried so the app can show which release a bundle came from; the protocol
    // itself only cares about `id` and `runtimeVersion`.
    appVersion: version,
    publishedAt: new Date().toISOString(),
  },
};

writeFileSync(join(runtimeDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
rmSync(EXPORT_DIR, { recursive: true, force: true });

const bytes = walk(runtimeDir).reduce((sum, f) => sum + statSync(join(runtimeDir, f)).size, 0);
console.log(
  `\nWrote ${relative(ROOT, runtimeDir)}\n` +
    `  version ${version}, runtime ${runtimeVersion}, id ${manifest.id}\n` +
    `  ${manifest.assets.length + 1} files, ${(bytes / 1048576).toFixed(1)} MB\n` +
    `  serve at ${base}/manifest.json`,
);
