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

/** A dropped connection is normal for a file this size; one failure is not final. */
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

/**
 * Download `url` and return the file, without installing it.
 *
 * Split from the launch below because Android 10 and later refuse to start an
 * activity from the background. A download that finishes while the app is not
 * foregrounded must therefore be *held*, and the installer opened when the app
 * is next active — otherwise the update silently never installs, which is the
 * one failure this whole path exists to avoid.
 *
 * `onProgress` receives `{ fraction, written, total }`. `fraction` and `total`
 * are null when the server sends no Content-Length, so the UI can show an
 * indeterminate state rather than a bar stuck at zero — `written` is always
 * real, which is why it is reported separately rather than folded into a
 * percentage.
 */
export async function downloadApk(url, { fileName, onProgress, expectedBytes } = {}) {
  if (Platform.OS !== 'android') {
    throw new InstallError('APK installation is only possible on Android.');
  }
  if (!url) throw new InstallError('No download link for this release.');

  const name = fileName || url.split('/').pop() || 'update.apk';
  /**
   * Downloaded into the app's files directory, not its cache.
   *
   * Android evicts cache directories under storage pressure, and it does not
   * wait for a 74MB write to finish first — which is one way a long download
   * dies with a bare `java.io.IOException` and nothing else to go on. The files
   * directory is not evictable. Expo's FileProvider exposes both
   * (`files-path` and `cache-path` in file_system_provider_paths.xml), so
   * `getContentUriAsync` works from either.
   */
  const dir = FileSystem.documentDirectory || FileSystem.cacheDirectory;
  const target = `${dir}${name}`;

  /**
   * Clear out every APK here first, not just this one's name.
   *
   * A partial file from an interrupted attempt would otherwise be handed to the
   * installer as-is and rejected as corrupt. And because these now live in the
   * files directory rather than the cache, Android will never reclaim them — one
   * 74MB APK per release would sit there for good. Sweeping on the way in is
   * the only safe moment: the installer reads the file asynchronously after the
   * intent is handed over, so deleting straight after launching it would pull
   * the update out from under the installer.
   */
  try {
    for (const entry of await FileSystem.readDirectoryAsync(dir)) {
      if (entry.toLowerCase().endsWith('.apk')) {
        await FileSystem.deleteAsync(`${dir}${entry}`, { idempotent: true }).catch(() => {});
      }
    }
  } catch {
    // Unreadable directory is not a reason to refuse the download; the
    // same-named target is removed below regardless.
  }
  await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});

  /**
   * Checked before starting, because the release APK is ~74MB and a phone that
   * cannot hold it fails partway through with a generic write error. Saying so
   * up front is the difference between "the download failed" and something the
   * user can act on.
   *
   * `expectedBytes` is the caller's hint; without one, a conservative floor is
   * used rather than skipping the check.
   */
  try {
    const free = await FileSystem.getFreeDiskStorageAsync();
    const needed = (expectedBytes || 80 * 1024 * 1024) * 1.1;
    if (free != null && free < needed) {
      throw new InstallError(
        `Not enough free space for the update — about ${Math.ceil(needed / 1048576)}MB is ` +
          `needed and ${Math.floor(free / 1048576)}MB is free.`,
        { kind: INSTALL_ERRORS.DOWNLOAD },
      );
    }
  } catch (err) {
    // Only our own refusal propagates; an unavailable API must not block a
    // download that would have worked.
    if (err instanceof InstallError) throw err;
  }

  const report = (progress) => {
    if (!onProgress) return;
    const written = progress.totalBytesWritten;
    // Android reports -1 for a response with no Content-Length; treating that
    // as a total would render "0.0 MB" and a bar that never moves.
    const total =
      progress.totalBytesExpectedToWrite > 0 ? progress.totalBytesExpectedToWrite : null;
    onProgress({ fraction: total ? written / total : null, written, total });
  };

  /**
   * Retried, because a 74MB transfer to a phone drops.
   *
   * A truncated stream surfaces as a bare `java.io.IOException` with no detail,
   * and one dropped connection should not mean no update.
   *
   * Each attempt starts clean: a fresh resumable over a deleted file.
   * `resumeAsync` is deliberately not used — it only resumes from state captured
   * by `pauseAsync`, so after a thrown error there is no resume data and it
   * would restart anyway, with the added risk of appending to bytes already on
   * disk. Honest restart beats a corrupt APK the installer rejects.
   */
  let result;
  let lastError;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      if (attempt > 1) {
        await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
        // A moment before retrying; an immediate retry usually meets the same
        // dead connection.
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt - 1)));
      }
      const download = FileSystem.createDownloadResumable(url, target, {}, report);
      result = await download.downloadAsync();
      if (result?.uri) break;
    } catch (err) {
      lastError = err;
      if (typeof __DEV__ !== 'undefined' && __DEV__) {
        console.warn(`[update] download attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed:`, err);
      }
    }
  }

  if (!result?.uri) {
    const err = lastError;
    /**
     * The reason is carried into the message, not just the `cause`.
     *
     * "The download failed. Check your connection and try again." was reported
     * for a source that was demonstrably healthy, and the actual reason — a
     * reload killing a 74MB transfer, no space, a dead socket — was only ever in
     * a `cause` nobody printed. A wrong diagnosis costs more than a long
     * sentence.
     */
    const reason = err?.message ? ` (${err.message})` : '';
    throw new InstallError(
      `The download failed after ${DOWNLOAD_ATTEMPTS} attempts${reason}. ` +
        'Check your connection and try again.',
      { kind: INSTALL_ERRORS.DOWNLOAD, cause: err },
    );
  }
  if (result.status && (result.status < 200 || result.status >= 300)) {
    throw new InstallError(`The server returned ${result.status} for the update file.`);
  }

  // An HTML error page saved under a .apk name is still a "successful"
  // download; size is the cheap tell before the installer rejects it.
  const info = await FileSystem.getInfoAsync(result.uri);
  if (!info.exists || !info.size) {
    throw new InstallError('The downloaded file is empty.');
  }

  return { uri: result.uri, size: info.size };
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
