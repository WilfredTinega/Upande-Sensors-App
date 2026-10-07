/**
 * Downloading a release APK and handing it to Android's package installer.
 *
 * Android will not install from a `file://` path — since Nougat that throws
 * FileUriExposedException — so the download is exposed through Expo's
 * FileProvider as a `content://` URI and the intent is granted read access to
 * it. `getContentUriAsync` only accepts paths inside the app's own storage,
 * which is why the APK lands in the cache directory rather than Downloads.
 *
 * The legacy expo-file-system entry point is deliberate: the SDK 54 `File` API
 * has no download-with-progress and no content-URI helper. The rest of the app
 * uses the new API for plain reads and writes; this is the one place that needs
 * the old surface.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';

/** FLAG_GRANT_READ_URI_PERMISSION — without it the installer cannot read the file. */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

const VIEW_ACTION = 'android.intent.action.VIEW';
const INSTALL_ACTION = 'android.intent.action.INSTALL_PACKAGE';
const UNKNOWN_SOURCES_SETTINGS = 'android.settings.MANAGE_UNKNOWN_APP_SOURCES';
const APK_MIME = 'application/vnd.android.package-archive';

/** A dropped connection is normal for a file this size: it is resumed, and only
 *  this many failures in a row without progress are final. */
const DOWNLOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

export const INSTALL_ERRORS = {
  DOWNLOAD: 'download',
  /** Almost always "Install unknown apps" being off for this app. */
  BLOCKED: 'blocked',
  FAILED: 'failed',
};

export class InstallError extends Error {
  constructor(message, { kind = INSTALL_ERRORS.FAILED, cause } = {}) {
    super(message);
    this.name = 'InstallError';
    this.kind = kind;
    this.cause = cause;
  }
}

/**
 * Open the per-app "Install unknown apps" screen.
 *
 * Android grants that permission per installing-app, and there is no way to
 * request it with a dialog — the user has to toggle it in Settings, so the most
 * we can do is land them on the right screen.
 */
export async function openUnknownAppSourcesSettings() {
  const pkg = Constants.expoConfig?.android?.package;
  await IntentLauncher.startActivityAsync(
    UNKNOWN_SOURCES_SETTINGS,
    pkg ? { data: `package:${pkg}` } : {},
  );
}

/** Where a release's APK lands: the files directory, not the cache — Android
 *  evicts the cache under storage pressure, mid-download. */
function apkPath(url, fileName) {
  const dir = FileSystem.documentDirectory || FileSystem.cacheDirectory;
  if (!dir) return null;
  return `${dir}${fileName || url.split('/').pop() || 'update.apk'}`;
}

async function sizeOf(uri) {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && !info.isDirectory ? info.size ?? 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * The local URI of a release that is already fully downloaded, or null. Only
 * trusted when the release's exact size is known — a partial file looks like
 * a whole one otherwise.
 */
export async function findDownloadedApk(url, { fileName, expectedBytes } = {}) {
  if (Platform.OS !== 'android' || !url || !expectedBytes) return null;
  const target = apkPath(url, fileName);
  if (!target) return null;
  return (await sizeOf(target)) === expectedBytes ? target : null;
}

/**
 * Download `url` and return the file, without installing it — Android 10+
 * refuses to start an activity from the background, so a download that lands
 * while the app is hidden is held and launched on the next foreground.
 * `onProgress` receives `{ fraction, written, total }` (fraction and total are
 * null without a Content-Length). The APK is kept
 * once complete, so the installer can be opened (and reopened after being
 * dismissed) without fetching it again.
 *
 * A dropped connection resumes from the bytes already on disk (an HTTP Range
 * request) instead of starting over, and so does a download cut off by the
 * app being closed. Resuming needs the release's exact size, which is also
 * what proves the result complete.
 */
export async function downloadApk(url, { fileName, onProgress, expectedBytes } = {}) {
  if (Platform.OS !== 'android') throw new InstallError('APK installation is only possible on Android.');
  if (!url) throw new InstallError('No download link for this release.');

  const target = apkPath(url, fileName);
  if (!target) throw new InstallError('No storage is available for the download.');
  const dir = target.slice(0, target.lastIndexOf('/') + 1);
  const expected = expectedBytes || null;

  const done = await findDownloadedApk(url, { fileName, expectedBytes });
  if (done) {
    onProgress?.({ fraction: 1, written: expected ?? 0, total: expected });
    return { uri: done, size: expected ?? 0 };
  }

  // Sweep every other APK (the files directory is never reclaimed); this
  // release's partial file stays, to be resumed. Never after launching: the
  // installer reads the file asynchronously.
  try {
    for (const entry of await FileSystem.readDirectoryAsync(dir)) {
      if (entry.toLowerCase().endsWith('.apk') && `${dir}${entry}` !== target) {
        await FileSystem.deleteAsync(`${dir}${entry}`, { idempotent: true }).catch(() => {});
      }
    }
  } catch {
    // An unreadable directory is no reason to refuse the download.
  }
  if (!expected) await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});

  try {
    const free = await FileSystem.getFreeDiskStorageAsync();
    const needed = ((expected ?? 80 * 1024 * 1024) - (await sizeOf(target))) * 1.1;
    if (free != null && free < needed) {
      throw new InstallError(
        `Not enough free space for the update — about ${Math.ceil(needed / 1048576)}MB is ` +
          `needed and ${Math.floor(free / 1048576)}MB is free.`,
        { kind: INSTALL_ERRORS.DOWNLOAD },
      );
    }
  } catch (err) {
    if (err instanceof InstallError) throw err;
  }

  const report = (progress) => {
    if (!onProgress) return;
    const written = progress.totalBytesWritten;
    const total = expected ?? (progress.totalBytesExpectedToWrite > 0 ? progress.totalBytesExpectedToWrite : null);
    onProgress({ fraction: total ? Math.min(written / total, 1) : null, written, total });
  };

  // Attempts that moved the download forward don't count against the limit:
  // only DOWNLOAD_ATTEMPTS failures in a row without a new byte give up.
  let lastError;
  let stalled = 0;
  while (stalled < DOWNLOAD_ATTEMPTS) {
    let have = expected ? await sizeOf(target) : 0;
    if (expected && have > expected) {
      // The server ignored the Range and appended a whole copy: start clean.
      await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
      have = 0;
    }
    if (expected && have === expected) return { uri: target, size: have };
    if (stalled > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * stalled));

    try {
      const download = FileSystem.createDownloadResumable(url, target, {}, report, have > 0 ? String(have) : undefined);
      const result = await download.downloadAsync();
      if (result?.status && (result.status < 200 || result.status >= 300)) {
        // An error page may have been appended to the partial file.
        await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
        throw new InstallError(`The server returned ${result.status} for the update file.`);
      }
      if (result?.uri && !expected) {
        // An HTML error page saved under a .apk name is still a "successful" download.
        const size = await sizeOf(result.uri);
        if (!size) throw new InstallError('The downloaded file is empty.');
        return { uri: result.uri, size };
      }
    } catch (err) {
      if (err instanceof InstallError) throw err;
      lastError = err;
      if (typeof __DEV__ !== 'undefined' && __DEV__) console.warn('[update] download interrupted:', err);
    }
    if (!expected || (await sizeOf(target)) <= have) stalled += 1;
    else stalled = 0;
  }

  throw new InstallError('The download keeps failing. Check your connection and try again.', {
    kind: INSTALL_ERRORS.DOWNLOAD,
    cause: lastError,
  });
}

/**
 * Open Android's package installer for an already-downloaded APK.
 *
 * This is as unattended as a normal app can be. Android reserves silent
 * installation for privileged installers — a device-owner DPC, a
 * platform-signed app in `/system/priv-app`, or root. `REQUEST_INSTALL_PACKAGES`
 * (declared in app.json) buys one thing only: the OS stops refusing the attempt.
 * It still shows its own "Update this app?" screen, and nothing available here
 * suppresses it.
 *
 * Resolves once the installer has been launched — Android owns the flow from
 * that point, and there is no callback for whether the user accepted.
 *
 * MUST be called with the app in the foreground; see `downloadApk`.
 */
export async function launchInstaller(fileUri) {
  if (Platform.OS !== 'android') {
    throw new InstallError('APK installation is only possible on Android.');
  }
  if (!fileUri) throw new InstallError('No downloaded update to install.');

  let contentUri;
  try {
    contentUri = await FileSystem.getContentUriAsync(fileUri);
  } catch (err) {
    throw new InstallError('Could not prepare the update for installation.', { cause: err });
  }

  // ACTION_VIEW first: it is the path a browser or file manager takes when you
  // tap a downloaded APK, so it is the one guaranteed to have a handler.
  // ACTION_INSTALL_PACKAGE has been deprecated since Android 10 and is kept
  // only as a fallback for devices whose launcher does not resolve the former.
  const attempts = [VIEW_ACTION, INSTALL_ACTION];
  let lastError;
  for (const action of attempts) {
    try {
      await IntentLauncher.startActivityAsync(action, {
        data: contentUri,
        type: APK_MIME,
        flags: FLAG_GRANT_READ_URI_PERMISSION,
      });
      return true;
    } catch (err) {
      lastError = err;
    }
  }

  // Both actions failing points at the permission rather than the intent: with
  // "Install unknown apps" off, Android refuses before any installer appears.
  throw new InstallError(
    'Android would not open the installer. Allow this app to install unknown apps, then try again.',
    { kind: INSTALL_ERRORS.BLOCKED, cause: lastError },
  );
}
