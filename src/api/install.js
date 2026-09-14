/**
 * The device register: which phones this app is installed on.
 *
 * The questions being answered are "how many devices are running this, what are
 * they, and which build is each signed-in person on". The unit is therefore a
 * (device, user) pair: the device identity is an id this file mints once and
 * keeps, and the account comes from the session the server sees. A shared phone
 * reports every person who signs in on it, not only the most recent, which is
 * why a sign-in reports unconditionally (see `reportInstall`).
 *
 * ── What is sent, and what is deliberately not ───────────────────────────────
 *
 * Sent: a random install id, the platform, the phone's brand / model / device
 * name, its OS version, this build's app and runtime versions, whether it is a
 * real phone rather than an emulator, and whether this report was triggered by
 * a sign-in or by a launch. All of it is either a constant of the hardware, a
 * constant of the build, or the occasion for the report.
 *
 * NOT sent, ever: an IP address, a location, a phone number, an advertising id,
 * or any other identifier the user did not already hand the app. The IP that
 * shows up in the register is the one the *server* observes on the request —
 * which it sees anyway, for every request the app has ever made — so the app
 * neither collects it nor is able to get it wrong. Anything added to the
 * payload below has to clear that same bar.
 *
 * ── The install id ──────────────────────────────────────────────────────────
 *
 * A v4 UUID from `expo-crypto`, generated on first run and kept in SecureStore
 * under `upande_install_id_v1`. It identifies the INSTALL, not the session:
 * `AuthContext.signOut` deletes the session keys by name and this one is not
 * among them, so signing out — or signing in as somebody else on the same
 * phone — keeps the same device row. It changes only when the app is
 * uninstalled and installed again, which is exactly the event the count is
 * meant to track. (Android clears an app's SecureStore/Keystore entries on
 * uninstall, so a reinstall genuinely is a new device as far as this is
 * concerned, and there is no way to tell one phone's reinstall from a new
 * phone. That is a deliberate limit, not an oversight: recovering it would
 * need a hardware id, which is the sort of thing this file exists to avoid.)
 *
 * ── Failure ─────────────────────────────────────────────────────────────────
 *
 * Nothing here is allowed to be visible. A server whose `upande_sensors`
 * predates the endpoint, an account that may not write, a phone with no
 * network, a SecureStore that refuses — each resolves to null. The one log line
 * is `__DEV__`-only and happens once per process. Telemetry that can interrupt
 * the person being measured is worse than no telemetry.
 */

import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { registerInstall } from './endpoints';
import { runtimeVersionOf } from './updates';

const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

/** Survives sign-out by design — see the header. Only a reinstall clears it. */
const KEY_INSTALL_ID = 'upande_install_id_v1';
/** When this device last reached the register, as epoch milliseconds. */
const KEY_LAST_REPORT = 'upande_install_reported_at_v1';
/** Which account that last report was made under — the throttle is per person. */
const KEY_LAST_USER = 'upande_install_reported_user_v1';

/**
 * At most one *launch* report an hour, for the same account.
 *
 * The pair only has to exist and carry a recent `last_seen`; re-posting the
 * same unchanged facts on every cold start would cost a request each time the
 * app is opened — which on a phone opened to glance at a reading is many times
 * a day — and would tell the server nothing it did not already know. A sign-in
 * is different: it is the event that binds an account to this device and to the
 * build it is running, so it is never throttled.
 */
const REPORT_INTERVAL_MS = 60 * 60 * 1000;

/** Why a report is being sent. The server keeps one record per (device, user). */
export const INSTALL_REASONS = {
  /** A cold start with a session already established. Throttled. */
  LAUNCH: 'launch',
  /** A successful authentication. Always sent. */
  LOGIN: 'login',
};

let loggedOnce = false;
function logOnce(where, err) {
  if (!IS_DEV || loggedOnce) return;
  loggedOnce = true;
  console.log(`[install] ${where}: ${err?.message || err}`);
}

/** Resolved once per process; SecureStore is only read on the first call. */
let cachedInstallId = null;

/**
 * This install's id, minting and persisting one on first run.
 *
 * Null when SecureStore cannot be used at all: without somewhere to keep the
 * id, a fresh UUID every launch would report one phone as a new device each
 * time, which is worse for the count than not reporting it.
 */
export async function getInstallId() {
  if (cachedInstallId) return cachedInstallId;
  try {
    const stored = await SecureStore.getItemAsync(KEY_INSTALL_ID);
    if (stored) {
      cachedInstallId = stored;
      return cachedInstallId;
    }
    const minted = Crypto.randomUUID();
    await SecureStore.setItemAsync(KEY_INSTALL_ID, minted);
    cachedInstallId = minted;
    return cachedInstallId;
  } catch (err) {
    logOnce('install id', err);
    return null;
  }
}

/**
 * What this phone and this build are.
 *
 * `Device.deviceName` is the name the owner gave the phone ("Wilfred's S21"),
 * which is how a person recognises their own row in the register; it is not an
 * identifier and is frequently the model name on an untouched device.
 *
 * `runtimeVersion` is the native contract the build was made against — the same
 * string `expo-updates` gates OTA bundles on. It is reported alongside the app
 * version because an OTA moves the app version while the runtime stays put, so
 * the two together say which APK is actually on the phone.
 */
export function deviceFacts({ appVersion } = {}) {
  const version = appVersion || Constants.expoConfig?.version || null;
  const declared = Constants.expoConfig?.runtimeVersion;
  return {
    platform: Platform.OS,
    device_brand: Device.brand || null,
    device_model: Device.modelName || null,
    device_name: Device.deviceName || null,
    os_version: Device.osVersion || null,
    app_version: version,
    // A runtimeVersion may be declared as a policy object rather than a string;
    // only a literal is meaningful to the server, so anything else falls back
    // to the major.minor of the app version, which is the policy this repo uses.
    runtime_version:
      typeof declared === 'string' && declared ? declared : runtimeVersionOf(version),
    // Emulators and CI devices are counted separately rather than dropped: the
    // register is also how a build is confirmed to be running at all.
    is_physical_device: Device.isDevice ? 1 : 0,
  };
}

/** One launch report per cold start, however many things ask for one. */
let reportedLaunchThisProcess = false;

/**
 * Reports are serialised.
 *
 * A sign-in and the launch hook can fire in the same tick — `PushRegistrar`
 * mounts the moment the session is established — and two concurrent reports
 * would each read the throttle before either wrote it, so the same facts would
 * be posted twice. Queueing them means the second one sees what the first
 * recorded and stands down. A failed task must not stall the queue, hence the
 * same handler on both settlements.
 */
let chain = Promise.resolve(null);
function serialised(task) {
  const run = chain.then(task, task);
  chain = run.then(
    () => null,
    () => null,
  );
  return run;
}

/**
 * Tell the server this device exists, and which build this account is on.
 * Resolves to the server's record, or to null for every reason it might not
 * have worked. Never rejects, never blocks.
 *
 * Call it where there is already a session: the endpoint records the account
 * alongside the device, and an unauthenticated call would be refused anyway.
 * `user` is passed for the throttle only — the account the row is filed under
 * is the one the *server* sees on the session, never one the client asserts.
 *
 * `reason: 'login'` always sends. That is the whole point of the pairing: a
 * second person signing in on a shared phone, or the same person after an
 * update, is exactly the event this feature exists to capture, and it would be
 * lost if it fell inside another report's hour.
 */
export async function reportInstall({ appVersion, reason = INSTALL_REASONS.LAUNCH, user } = {}) {
  const isLogin = reason === INSTALL_REASONS.LOGIN;
  if (!isLogin) {
    if (reportedLaunchThisProcess) return null;
    reportedLaunchThisProcess = true;
  }

  return serialised(async () => {
    try {
      const now = Date.now();
      const account = user || null;

      if (!isLogin) {
        const [last, lastUser] = await Promise.all([
          SecureStore.getItemAsync(KEY_LAST_REPORT).then((v) => Number(v) || 0),
          SecureStore.getItemAsync(KEY_LAST_USER).catch(() => null),
        ]);
        // A different account on this phone always sends, whatever the clock
        // says: the pair (device, user) it would create does not exist yet.
        const sameUser = !account || !lastUser || lastUser === account;
        // `last > now` means the clock moved backwards (a manual change, or a
        // phone that booted without one). Treating that as "not due yet" would
        // silence this device until the clock caught up, so a stamp in the
        // future counts as due.
        if (sameUser && last && last <= now && now - last < REPORT_INTERVAL_MS) return null;
      }

      const installId = await getInstallId();
      if (!installId) return null;

      const result = await registerInstall({
        installId,
        reason: isLogin ? INSTALL_REASONS.LOGIN : INSTALL_REASONS.LAUNCH,
        ...deviceFacts({ appVersion }),
      });

      // Written only after the server accepted it: a failed send must be
      // retried on the next launch rather than counted as this hour's report.
      await Promise.all([
        SecureStore.setItemAsync(KEY_LAST_REPORT, String(now)).catch(() => {}),
        account ? SecureStore.setItemAsync(KEY_LAST_USER, account).catch(() => {}) : null,
      ]);
      return result;
    } catch (err) {
      // Includes `isMissingEndpoint` on a site whose `upande_sensors` predates
      // the register, and a permission refusal. Neither is worth a word to the
      // user: they did not ask for this and cannot act on it.
      logOnce('report', err);
      return null;
    }
  });
}
