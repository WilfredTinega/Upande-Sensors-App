/**
 * Checking GitHub Releases for a newer build of this app.
 *
 * Deliberately not on the Frappe client: this talks to api.github.com, carries
 * no session, and must keep working when the site is unreachable — an update is
 * often exactly what someone reaches for when the app is misbehaving.
 *
 * Unauthenticated GitHub API calls are limited to 60 per hour *per IP*. A
 * clinic or farm office puts every phone behind one NAT address, so a poll on
 * every launch would exhaust the budget for everyone. Hence: checks happen only
 * when the user asks, and a rate-limit response is reported as a temporary
 * condition with a link to the web page, which is not rate limited.
 */

import * as SecureStore from 'expo-secure-store';

import { GITHUB_REPO, RELEASES_URL } from '../config';

const API_ROOT = 'https://api.github.com';
const TIMEOUT_MS = 15000;

/** One automatic check per device per day; the manual button ignores this. */
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const CACHE_KEY = 'update_check_v1';

/** Distinguishable so the UI can explain the cause instead of "check failed". */
export const UPDATE_ERRORS = {
  OFFLINE: 'offline',
  TIMEOUT: 'timeout',
  RATE_LIMITED: 'rate_limited',
  NO_RELEASES: 'no_releases',
  FAILED: 'failed',
};

export class UpdateCheckError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'UpdateCheckError';
    this.kind = kind;
  }
}

/**
 * Numeric-segment comparison, ignoring a leading `v`. Returns 1 when `a` is
 * newer, -1 when older, 0 when equal.
 *
 * Padding the shorter side with zeros makes `1.1` and `1.1.0` compare equal
 * rather than ordering by segment count.
 */
export function compareVersions(a, b) {
  const parse = (v) =>
    String(v ?? '')
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

/**
 * Where the release workflow always puts the APK.
 *
 * The atom feed carries no asset list, so on the rate-limited path there is
 * nothing to read a download link from. The release job names every asset
 * `upande_sensors_v<version>.apk` and attaches it to tag `v<version>`, which
 * makes the URL derivable — see "Name the artifact after the release" in
 * .github/workflows/release.yml. If that naming ever changes, this must too.
 */
function predictedApkUrl(version) {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${version}/upande_sensors_v${version}.apk`;
}

/** The `.apk` attached to a release, or null when only sources were published. */
function findApkAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find((a) => typeof a?.name === 'string' && a.name.toLowerCase().endsWith('.apk')) ?? null;
}

/**
 * How an update can be delivered — and it is the version number that decides.
 *
 * `major.minor` is the compatibility boundary, because that is exactly what the
 * odometer in `scripts/version.mjs` already means: a normal merge bumps the
 * patch, and `--bump minor` is the deliberate signal that something native
 * changed. So:
 *
 *   1.0.5 -> 1.0.6   same runtime. Only JavaScript can have changed, so the
 *                    update is a bundle of a few hundred KB.
 *   1.0.9 -> 1.1.0   the runtime moved. New native code, a new permission, an
 *                    SDK bump — none of which a JS bundle can carry — so it is
 *                    the full ~74MB APK or nothing.
 *
 * This is not a convention the app has to police: it is the same string
 * `expo-updates` uses as its own `runtimeVersion` gate, so a bundle published
 * for runtime "1.0" is *refused* by a 1.1 build rather than half-applied. The
 * rule and its enforcement are the same fact.
 */
export const UPDATE_KINDS = {
  /** Deliverable as a JS bundle — fast, small, no reinstall. */
  JS: 'js',
  /** Needs a new APK: the native side changed. */
  NATIVE: 'native',
};

/** The `runtimeVersion` a given app version belongs to, e.g. "1.0" for 1.0.6. */
export function runtimeVersionOf(version) {
  const parts = String(version || '').trim().split('.');
  if (parts.length < 2) return null;
  const major = Number.parseInt(parts[0], 10);
  const minor = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return `${major}.${minor}`;
}

/**
 * Which delivery an upgrade needs. Null when there is nothing to compare.
 *
 * Deliberately does NOT check which is newer — `compareVersions` already owns
 * that, and answering "is this an upgrade" here as well would give two places
 * the chance to disagree. This answers only "if we were to move between these
 * two, what would it take".
 */
export function updateKind(installed, latest) {
  const from = runtimeVersionOf(installed);
  const to = runtimeVersionOf(latest);
  if (!from || !to) return null;
  return from === to ? UPDATE_KINDS.JS : UPDATE_KINDS.NATIVE;
}

/** Byte count as MB, or null when the size is unknown. Exported for the
 *  download progress line, which learns the real size from Content-Length. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

/**
 * Fetch the newest published release. Throws UpdateCheckError; never resolves
 * to a half-populated object, so callers can trust every field they read.
 */
export async function fetchLatestRelease() {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${API_ROOT}/repos/${GITHUB_REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    });
  } catch {
    if (timedOut) {
      throw new UpdateCheckError(UPDATE_ERRORS.TIMEOUT, 'GitHub did not respond in time.');
    }
    throw new UpdateCheckError(UPDATE_ERRORS.OFFLINE, 'Could not reach GitHub.');
  } finally {
    clearTimeout(timer);
  }

  // GitHub answers an exhausted quota with 403 (or 429) plus a zeroed remaining
  // header — a plain 403 without it would be a genuine permission problem.
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining === '0' || response.status === 429) {
      throw new UpdateCheckError(
        UPDATE_ERRORS.RATE_LIMITED,
        'GitHub is rate limiting this network. Try again later.',
      );
    }
    throw new UpdateCheckError(UPDATE_ERRORS.FAILED, 'GitHub refused the request.');
  }

  // 404 here means "no release published yet", not a broken repo path: the
  // repo is public, so an unreachable repo would not have got this far.
  if (response.status === 404) {
    throw new UpdateCheckError(UPDATE_ERRORS.NO_RELEASES, 'No release has been published yet.');
  }

  if (!response.ok) {
    throw new UpdateCheckError(UPDATE_ERRORS.FAILED, `GitHub returned ${response.status}.`);
  }

  let release;
  try {
    release = await response.json();
  } catch {
    throw new UpdateCheckError(UPDATE_ERRORS.FAILED, 'GitHub sent a response the app could not read.');
  }

  const version = String(release?.tag_name ?? '').replace(/^v/i, '');
  if (!version) {
    throw new UpdateCheckError(UPDATE_ERRORS.NO_RELEASES, 'The latest release has no version tag.');
  }

  const asset = findApkAsset(release);
  return {
    version,
    notes: typeof release?.body === 'string' ? release.body.trim() : '',
    publishedAt: release?.published_at ?? null,
    pageUrl: release?.html_url || RELEASES_URL,
    // Without an attached APK the only honest action is to open the release
    // page and let the person see what is actually there.
    downloadUrl: asset?.browser_download_url ?? null,
    assetName: asset?.name ?? null,
    size: formatBytes(asset?.size),
    sizeBytes: asset?.size ?? null,
  };
}

/**
 * The releases atom feed, used when the JSON API is rate limited.
 *
 * `github.com` is a normal web endpoint and is not part of the 60-per-hour API
 * quota — verified directly: while api.github.com was returning 403 with
 * `x-ratelimit-remaining: 0`, this feed still answered 200 from the same
 * address. It carries the tag and the notes but no asset list, so the result
 * points at the release page rather than straight at an APK.
 */
async function fetchLatestReleaseViaAtom() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let xml;
  try {
    const response = await fetch(`https://github.com/${GITHUB_REPO}/releases.atom`, {
      headers: { Accept: 'application/atom+xml' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new UpdateCheckError(UPDATE_ERRORS.FAILED, `Release feed returned ${response.status}.`);
    }
    xml = await response.text();
  } catch (err) {
    if (err instanceof UpdateCheckError) throw err;
    throw new UpdateCheckError(UPDATE_ERRORS.OFFLINE, 'Could not reach GitHub.');
  } finally {
    clearTimeout(timer);
  }

  // Entries are newest-first, and the tag is the last path segment of the id.
  const entry = xml.split('<entry>')[1];
  const tag = entry?.match(/<id>[^<]*\/([^/<]+)<\/id>/)?.[1];
  const version = String(tag ?? '').replace(/^v/i, '');
  if (!version) {
    throw new UpdateCheckError(UPDATE_ERRORS.NO_RELEASES, 'No release has been published yet.');
  }

  return {
    version,
    notes: '',
    publishedAt: entry?.match(/<updated>([^<]+)<\/updated>/)?.[1] ?? null,
    pageUrl: `${RELEASES_URL}/tag/${tag}`,
    // Derived rather than read, because the feed has no asset list. A wrong
    // guess surfaces as a failed download with the release page still one tap
    // away, which beats hiding the button on every rate-limited check.
    downloadUrl: predictedApkUrl(version),
    assetName: `upande_sensors_v${version}.apk`,
    // Unknown until the download starts — the feed carries no asset metadata,
    // so the size is filled in from Content-Length once bytes begin arriving.
    size: null,
    sizeBytes: null,
  };
}

/**
 * Compare the running build against the newest release.
 * Returns `{ ...release, current, available }`.
 */
export async function checkForUpdate(currentVersion) {
  let release;
  try {
    release = await fetchLatestRelease();
  } catch (err) {
    // Rate limiting is a property of the network, not of this device, so a
    // shared office IP would otherwise make the feature useless for everyone at
    // once. The feed has no asset list, hence only used as a fallback.
    if (err?.kind === UPDATE_ERRORS.RATE_LIMITED) {
      release = await fetchLatestReleaseViaAtom();
    } else {
      throw err;
    }
  }

  const result = {
    ...release,
    current: currentVersion ?? null,
    available: compareVersions(release.version, currentVersion) > 0,
    // What this upgrade would take: a JS bundle within the same runtime, or a
    // full APK across runtimes. Carried on the release so every consumer reads
    // one verdict rather than re-deriving it.
    kind: updateKind(currentVersion, release.version),
    runtime: runtimeVersionOf(currentVersion),
    releaseRuntime: runtimeVersionOf(release.version),
  };

  await SecureStore.setItemAsync(
    CACHE_KEY,
    JSON.stringify({ at: Date.now(), result }),
  ).catch(() => {});

  return result;
}

/** The last successful check, or null. Never throws. */
export async function readCachedUpdate() {
  try {
    const raw = await SecureStore.getItemAsync(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.result || typeof parsed.at !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Check at most once per `AUTO_CHECK_INTERVAL_MS`, returning the cached result
 * in between. Resolves to null instead of throwing: a background check that
 * fails should leave the UI exactly as it was, not raise an error at someone
 * who never asked for it.
 */
export async function autoCheckForUpdate(currentVersion) {
  const cached = await readCachedUpdate();

  // A cached verdict is only meaningful for the build that produced it — after
  // an update it would still claim one is available.
  const stale =
    !cached ||
    Date.now() - cached.at > AUTO_CHECK_INTERVAL_MS ||
    cached.result?.current !== (currentVersion ?? null);

  if (!stale) return cached.result;

  try {
    return await checkForUpdate(currentVersion);
  } catch {
    return cached && cached.result?.current === (currentVersion ?? null) ? cached.result : null;
  }
}
