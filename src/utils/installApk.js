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
 * Download `url` and open the system installer for it.
 *
 * `onProgress` receives `{ fraction, written, total }`. `fraction` and `total`
 * are null when the server sends no Content-Length, so the UI can show an
 * indeterminate state rather than a bar stuck at zero — `written` is always
 * real, which is why it is reported separately rather than folded into a
 * percentage.
 *
 * Resolves once the installer has been launched — Android owns the flow from
 * that point, and there is no callback for whether the user accepted.
 */
export async function downloadAndInstallApk(url, { fileName, onProgress } = {}) {
  if (Platform.OS !== 'android') {
    throw new InstallError('APK installation is only possible on Android.');
  }
  if (!url) throw new InstallError('No download link for this release.');

  const name = fileName || url.split('/').pop() || 'update.apk';
  const target = `${FileSystem.cacheDirectory}${name}`;

  // A partial file from an interrupted attempt would otherwise be handed to the
  // installer as-is and rejected as corrupt.
  await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});

  let result;
  try {
    const download = FileSystem.createDownloadResumable(url, target, {}, (progress) => {
      if (!onProgress) return;
      const written = progress.totalBytesWritten;
      // Android reports -1 for a response with no Content-Length; treating that
      // as a total would render "0.0 MB" and a bar that never moves.
      const total = progress.totalBytesExpectedToWrite > 0
        ? progress.totalBytesExpectedToWrite
        : null;
      onProgress({ fraction: total ? written / total : null, written, total });
    });
    result = await download.downloadAsync();
  } catch (err) {
    throw new InstallError('The download failed. Check your connection and try again.', {
      kind: INSTALL_ERRORS.DOWNLOAD,
      cause: err,
    });
  }

  if (!result?.uri) {
    throw new InstallError('The download did not complete.');
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

  let contentUri;
  try {
    contentUri = await FileSystem.getContentUriAsync(result.uri);
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
      return { uri: result.uri, size: info.size };
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
