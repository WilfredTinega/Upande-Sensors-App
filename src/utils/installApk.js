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
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';

/** FLAG_GRANT_READ_URI_PERMISSION — without it the installer cannot read the file. */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

const INSTALL_ACTION = 'android.intent.action.INSTALL_PACKAGE';
const APK_MIME = 'application/vnd.android.package-archive';

export class InstallError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'InstallError';
    this.cause = cause;
  }
}

/**
 * Download `url` and open the system installer for it.
 *
 * `onProgress` receives 0..1, or null when the server sends no Content-Length
 * (the UI shows an indeterminate state rather than a bar stuck at zero).
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
      const total = progress.totalBytesExpectedToWrite;
      onProgress(total > 0 ? progress.totalBytesWritten / total : null);
    });
    result = await download.downloadAsync();
  } catch (err) {
    throw new InstallError('The download failed. Check your connection and try again.', {
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

  try {
    await IntentLauncher.startActivityAsync(INSTALL_ACTION, {
      data: contentUri,
      flags: FLAG_GRANT_READ_URI_PERMISSION,
      type: APK_MIME,
    });
  } catch (err) {
    // The usual cause is "Install unknown apps" being off for this app. Android
    // shows that settings prompt itself when it can; when it cannot, the intent
    // simply fails and the user needs telling why.
    throw new InstallError(
      'Android would not open the installer. Allow this app to install unknown apps in Settings, then try again.',
      { cause: err },
    );
  }

  return { uri: result.uri, size: info.size };
}
