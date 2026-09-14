import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

import { autoCheckForUpdate, checkForUpdate, UPDATE_ERRORS, UPDATE_KINDS } from '../api/updates';
import { downloadApk, launchInstaller } from '../utils/installApk';

/**
 * Whether a newer build exists, held app-wide — and fetching it when there is.
 *
 * Lifted out of the Account screen so the tab bar can badge itself: a check that
 * only runs when someone opens Account tells the people who never open Account
 * nothing, which is most people most of the time. There is no Play Store doing
 * this for us, so the app has to raise its hand.
 *
 * ── What "install in the background" can and cannot mean ─────────────────────
 *
 * The **download** is fully automatic and silent: found, fetched, and handed to
 * Android without anyone tapping anything.
 *
 * The **install itself cannot be silent.** Android reserves unattended
 * installation for privileged installers — a device-owner DPC (fully managed
 * enrolment), a platform-signed app in `/system/priv-app`, or root. An ordinary
 * app holding `REQUEST_INSTALL_PACKAGES`, which this one does, gets exactly one
 * concession: the OS stops blocking the attempt outright. It still shows its own
 * "Update this app?" screen, and no flag, intent or API on a normal build
 * suppresses it. That screen is the OS asking on the user's behalf, and it is
 * not ours to remove.
 *
 * So what is removed here is every step the *app* was adding: no confirmation
 * dialog, no second tap, no waiting on the Account screen. The update downloads
 * while the app is in use and the system installer opens by itself when it is
 * ready.
 *
 * ── Two update channels, two loops ───────────────────────────────────────────
 *
 * The above is the APK channel: a GitHub Releases check, once a day, for a
 * build whose *runtime* moved. Independent of it is the OTA channel below — the
 * JS bundle for a patch inside the same runtime, served by `updates.url`. That
 * one is checked on every launch and every return to the foreground (throttled
 * to once in five minutes) and applied without asking, because a patch is by
 * definition something the user should simply have. `checkAutomatically:
 * ON_LOAD` in app.json also lets the native side download at startup; its
 * result arrives through `useUpdates().isUpdatePending` and is applied by the
 * same path, so however the bundle got here it is installed the same way.
 */

const UpdateContext = createContext(null);

/** The running build, as stamped into app.json by the release workflow. */
export const APP_VERSION = Constants.expoConfig?.version ?? null;

const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

/**
 * Inside this window after launch a fetched bundle is applied by an immediate
 * restart, with no toast: nothing has been started that a restart could
 * interrupt, and there is barely anything on screen to explain it over. Past
 * it, the user is mid-task, so the restart is announced first.
 */
const OTA_LAUNCH_WINDOW_MS = 20 * 1000;
/** How long the "Updating…" toast is shown before the restart. */
const OTA_TOAST_MS = 2500;
/** At most one OTA check per foreground transition per this interval. */
const OTA_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const launchedAt = Date.now();

export function UpdateProvider({ children }) {
  const [update, setUpdate] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [installError, setInstallError] = useState(null);

  /**
   * Guards against a second attempt at the same build.
   *
   * A ref rather than state: it must be readable and writable without waiting
   * for a render, and changing it must not itself trigger one.
   *
   * `attempted` is what stops an auto-install looping. Declining Android's
   * installer is a legitimate answer, and re-downloading the same APK to ask
   * again would make the app impossible to use.
   */
  const attempted = useRef(new Set());
  const busy = useRef(false);

  /**
   * A downloaded APK waiting for the app to come back to the foreground.
   *
   * Android 10 and later refuse to start an activity from the background, so a
   * download that lands while the app is not visible cannot open the installer
   * then and there. Holding the file and launching on the next `active`
   * transition is the difference between "installs when you next look at the
   * app" and "silently never installs".
   */
  const pending = useRef(null);

  /* ── OTA: the JS bundle inside the same runtime ───────────────────────── */

  const [otaChecking, setOtaChecking] = useState(false);
  /** A bundle is downloaded and the restart is seconds away. Drives the toast. */
  const [otaReady, setOtaReady] = useState(false);
  const otaBusy = useRef(false);
  const otaLastCheck = useRef(0);
  const otaApplied = useRef(false);

  /**
   * Restart into a bundle that has finished downloading.
   *
   * Two timings, decided by how long the app has been up. Just after launch the
   * restart is immediate: nothing is in progress and there is nothing to
   * explain it over. Later, the toast is shown first, so that the app going
   * away and coming back reads as an update and not as a crash — which is what
   * an unannounced restart looks like, and what gets an app reinstalled.
   *
   * Guarded so it runs once per process: the native ON_LOAD download and this
   * hook's own fetch can both report the same bundle as pending.
   */
  const applyOta = useCallback(async () => {
    if (otaApplied.current) return;
    otaApplied.current = true;
    try {
      if (Date.now() - launchedAt >= OTA_LAUNCH_WINDOW_MS) {
        setOtaReady(true);
        await new Promise((resolve) => setTimeout(resolve, OTA_TOAST_MS));
      }
      await Updates.reloadAsync();
    } catch (err) {
      // A reload that fails leaves the bundle installed for the next launch.
      // Nothing to tell the user; the next cold start picks it up.
      otaApplied.current = false;
      setOtaReady(false);
      if (IS_DEV) console.log('[ota] reload', err?.message);
    }
  }, []);

  /**
   * Ask the update server whether a newer bundle exists, and install it if so.
   *
   * Every failure is swallowed. `checkForUpdateAsync` REJECTS — rather than
   * resolving `isAvailable: false` — when the server answers with anything but
   * a manifest: a 404, a Frappe error page, a site without `upande_sensors`'
   * OTA endpoint deployed yet. None of that is the user's problem, and none of
   * it is allowed to surface past a `__DEV__` console line.
   *
   * Never in development or Expo Go: `Updates.isEnabled` is false there, and a
   * Metro reload is the update mechanism.
   */
  const checkOta = useCallback(
    async ({ force = false } = {}) => {
      if (IS_DEV || !Updates.isEnabled) return;
      if (otaBusy.current || otaApplied.current) return;
      if (!force && Date.now() - otaLastCheck.current < OTA_CHECK_INTERVAL_MS) return;
      otaBusy.current = true;
      otaLastCheck.current = Date.now();
      setOtaChecking(true);
      try {
        const found = await Updates.checkForUpdateAsync();
        if (!found?.isAvailable) return;
        await Updates.fetchUpdateAsync();
        await applyOta();
      } catch (err) {
        if (IS_DEV) console.log('[ota] check', err?.message);
      } finally {
        otaBusy.current = false;
        setOtaChecking(false);
      }
    },
    [applyOta],
  );

  // Once at mount, then on every return to the foreground — a phone that stays
  // open all day on the Live screen should still pick up a fix published at
  // lunchtime. The interval guard keeps a screen-on/screen-off habit from
  // turning into a request per unlock.
  useEffect(() => {
    checkOta({ force: true });
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') checkOta();
    });
    return () => sub.remove();
  }, [checkOta]);

  /**
   * The native side's own download, from `checkAutomatically: ON_LOAD`.
   *
   * With that setting expo-updates checks and downloads at startup on its own,
   * but does not restart into the result until the NEXT launch — so without
   * this a fix would always be one launch behind. `isUpdatePending` flips when
   * that download completes, and the bundle is applied the same way as one this
   * hook fetched itself.
   */
  const { isUpdatePending } = Updates.useUpdates();
  useEffect(() => {
    if (IS_DEV || !Updates.isEnabled || !isUpdatePending) return;
    applyOta();
  }, [isUpdatePending, applyOta]);

  /* ── APK: the GitHub Releases check ───────────────────────────────────── */

  // One silent attempt per launch. `autoCheckForUpdate` throttles to once a day
  // across launches and swallows its own failures, so a phone that opens the
  // app twenty times offline makes at most one doomed request and shows nothing.
  useEffect(() => {
    let cancelled = false;
    autoCheckForUpdate(APP_VERSION).then((result) => {
      if (!cancelled && result) setUpdate((current) => current ?? result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** The Check for updates button: ignores the throttle, surfaces failures. */
  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const result = await checkForUpdate(APP_VERSION);
      setUpdate(result);
      return result;
    } catch (err) {
      setUpdate(null);
      setError({
        kind: err?.kind ?? UPDATE_ERRORS.FAILED,
        message: err?.message ?? 'The check could not be completed.',
      });
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  /**
   * Download a release and hand it to Android's installer.
   *
   * `auto` marks the unattended path. It is rate-limited to one attempt per
   * version per launch and reports failure only through `installError`, so a
   * background attempt can never interrupt with an alert about something the
   * user did not ask for. A manual press passes `auto: false` and the caller
   * decides how loudly to fail.
   *
   * Returns whether the installer was reached, not whether the user accepted —
   * Android owns the flow from that point and offers no callback.
   */
  /**
   * Apply a same-runtime update as a JavaScript bundle.
   *
   * A patch release cannot contain native changes — that is what the runtime
   * boundary means — so it arrives as a bundle of a megabyte or so instead of a
   * 74MB APK, and there is no installer and no reinstall. `reloadAsync` restarts
   * into it.
   *
   * Returns false rather than throwing when this route is unavailable, and that
   * has to hold for *every* way it can be unavailable, not just the tidy ones.
   * In Expo Go and in development `Updates.isEnabled` is false; a runtime with
   * nothing published yet simply has no update; and — the case that actually
   * bit — an update server that answers with anything other than a manifest
   * makes `checkForUpdateAsync` **reject**, not resolve to `isAvailable: false`.
   * A 404 from the static host is enough to do it.
   *
   * Unguarded, that rejection propagated out of here into `install`, whose catch
   * turned the whole attempt into an install error and skipped the APK below.
   * So a dead OTA host did not merely disable the fast path, it disabled
   * updating altogether — the opposite of the fallback this function exists to
   * make safe. Every failure is therefore a decline: the APK is the answer, and
   * choosing to try the fast path first can never cost the user the update.
   */
  const applyJsUpdate = useCallback(async () => {
    if (!Updates.isEnabled) return false;
    try {
      const found = await Updates.checkForUpdateAsync();
      if (!found?.isAvailable) return false;
      await Updates.fetchUpdateAsync();
      // Everything after this is on the other side of a restart.
      await Updates.reloadAsync();
      return true;
    } catch {
      return false;
    }
  }, []);

  const install = useCallback(
    async (target, { auto = false } = {}) => {
      const release = target || update;
      if (!release?.available) return false;
      // One download at a time, whoever asked.
      if (busy.current) return false;

      if (auto) {
        if (attempted.current.has(release.version)) return false;
        attempted.current.add(release.version);
      }

      busy.current = true;
      setDownloading(true);
      setProgress(null);
      setInstallError(null);
      try {
        /**
         * The fast path, tried first for anything inside the same runtime.
         *
         * If it succeeds the app has already restarted and nothing below runs.
         * If it declines — no bundle published, or updates disabled in this
         * build — the APK is still there as the answer, so choosing the fast
         * path can never cost the user the update.
         */
        if (release.kind === UPDATE_KINDS.JS && (await applyJsUpdate())) {
          return true;
        }

        if (!release.downloadUrl) {
          setInstallError({
            kind: null,
            message: 'This release has no download attached to it.',
            auto,
          });
          return false;
        }

        const file = await downloadApk(release.downloadUrl, {
          fileName: release.assetName,
          onProgress: setProgress,
          // The releases API reports the asset size, so the space check can be
          // exact rather than a guessed floor.
          expectedBytes: release.sizeBytes,
        });
        if (AppState.currentState !== 'active') {
          // Held rather than dropped — see `pending`.
          pending.current = file.uri;
          return false;
        }
        await launchInstaller(file.uri);
        return true;
      } catch (err) {
        setInstallError({
          kind: err?.kind ?? null,
          message: err?.message ?? 'The update could not be installed.',
          auto,
        });
        return false;
      } finally {
        busy.current = false;
        setDownloading(false);
        setProgress(null);
      }
    },
    [update, applyJsUpdate],
  );

  /**
   * Fetch and install as soon as a newer build is known about, without waiting
   * to be asked.
   *
   * A release with no attached APK is skipped rather than retried: there is
   * nothing to download, and the Account screen offers the releases page for
   * that case.
   *
   * Never automatic in development. The release APK is ~74MB, a Metro reload
   * kills the transfer partway through — which surfaced as "failed to download
   * update" against a source that was demonstrably fine — and an APK cannot
   * replace a running Expo Go session anyway, so every byte of it is wasted.
   * The Account button still triggers it by hand when the path itself needs
   * testing.
   */
  useEffect(() => {
    if (typeof __DEV__ !== 'undefined' && __DEV__) return;
    if (!update?.available) return;
    // A native update with no APK attached has nothing to fetch; a JS one does
    // not need an APK at all.
    if (update.kind !== UPDATE_KINDS.JS && !update.downloadUrl) return;
    install(update, { auto: true });
  }, [update, install]);

  /**
   * Launch a held installer as soon as the app is visible again.
   *
   * The file is cleared before launching, not after: a failed launch must not
   * leave it queued to be retried on every single foreground event.
   */
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active' || !pending.current) return;
      const uri = pending.current;
      pending.current = null;
      launchInstaller(uri).catch((err) => {
        setInstallError({
          kind: err?.kind ?? null,
          message: err?.message ?? 'The update could not be installed.',
          auto: true,
        });
      });
    });
    return () => sub.remove();
  }, []);

  const value = useMemo(
    () => ({
      update,
      checking,
      error,
      check,
      available: Boolean(update?.available),
      downloading,
      progress,
      installError,
      install,
      otaChecking,
      otaReady,
    }),
    [update, checking, error, check, downloading, progress, installError, install, otaChecking, otaReady],
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

/**
 * Safe outside the provider — returns a quiet default rather than throwing, so
 * a screen rendered before the tree is assembled simply shows no update.
 */
export function useUpdate() {
  return (
    useContext(UpdateContext) ?? {
      update: null,
      checking: false,
      error: null,
      check: async () => null,
      available: false,
      downloading: false,
      progress: null,
      installError: null,
      install: async () => false,
      otaChecking: false,
      otaReady: false,
    }
  );
}
