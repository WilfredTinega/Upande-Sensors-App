/**
 * Push notifications for limit breaches.
 *
 * The server watches readings against the limits configured per monitoring
 * and, when one is crossed, sends a push through the Expo push service to every
 * device registered for the site — `data: { type: 'limit_alert', alert, site,
 * sensor_name, measure }` on the Android channel `alerts`. This module is the
 * device's half: get a token, hand it to the server, and take the user to the
 * site's live readings when they tap the notification.
 *
 * Everything here is failure-silent by design. Registration runs right after
 * sign-in, and nothing about signing in may depend on it: a phone with
 * notifications denied, a build without an Expo project id, an emulator, Expo
 * Go, or a server that predates the endpoints must each land on a status the
 * Account screen can explain — never on an error in the user's face.
 *
 * ── Expo Go, and why the module is loaded lazily ─────────────────────────────
 *
 * `expo-notifications` removed remote-push support from Expo Go in SDK 53, and
 * it says so loudly: on Android several of its functions log a red-box error
 * the moment they are called — including the ones that have nothing to do with
 * tokens, like installing the foreground handler. A static `import` is enough
 * to run some of that at module scope. So the module is `require`d inside
 * `notifications()`, behind one guard, and NOTHING here touches it in Expo Go
 * or in a development bundle. Importing this file runs no expo-notifications
 * code at all.
 *
 * ── Why a projectId is needed, and what happens without one ─────────────────
 *
 * An Expo push token is minted by Expo's service for a specific EAS project,
 * so `getExpoPushTokenAsync` needs `extra.eas.projectId` (written by `eas
 * init`) and, on Android, Firebase credentials in the build plus an FCM V1
 * service-account key uploaded to that project. Until the repository has been
 * set up that way the app has nothing to register with, and this module reports
 * `unconfigured` rather than throwing — the in-app alerts card on Home still
 * works, because that reads the server directly. README.md → "Push
 * notifications" lists the setup.
 */

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Linking, Platform } from 'react-native';

import { FrappeError, registerPushToken, unregisterPushToken } from './endpoints';

const IS_DEV = typeof __DEV__ !== 'undefined' && __DEV__;

/**
 * Expo Go. `executionEnvironment === 'storeClient'` is the current signal;
 * `appOwnership === 'expo'` is the older one, kept so a stale Constants shape
 * still answers correctly.
 */
const IS_EXPO_GO =
  Constants.executionEnvironment === 'storeClient' || Constants.appOwnership === 'expo';

/** Must match the channel the server names in each push, or Android drops it. */
const CHANNEL_ID = 'alerts';

/** The one push type this app knows how to act on. */
export const PUSH_TYPE_LIMIT_ALERT = 'limit_alert';

/** Where registration ended up. The Account screen renders one line per value. */
export const PUSH_STATUS = {
  /** Not attempted yet this session. */
  UNKNOWN: 'unknown',
  /** Token issued and accepted by the server. */
  ON: 'on',
  /** The user declined notifications, now or previously. */
  DENIED: 'denied',
  /** No `extra.eas.projectId` — the build cannot mint a token. */
  UNCONFIGURED: 'unconfigured',
  /** Running in Expo Go, which has no remote push at all since SDK 53. */
  EXPO_GO: 'expo_go',
  /** An emulator, or a development bundle. */
  UNSUPPORTED: 'unsupported',
  /** The server has no push endpoints (older `upande_sensors`). */
  UNAVAILABLE: 'unavailable',
  /** Anything else — reported with its message, never thrown. */
  FAILED: 'failed',
};

let state = { status: PUSH_STATUS.UNKNOWN, token: null, message: null };
const listeners = new Set();

function setState(next) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn(state));
}

export function getPushState() {
  return state;
}

/** Subscribe to status changes. Returns the unsubscribe. */
export function subscribeToPushState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Logged once per process, so a dev console is not flooded with the same line. */
let loggedOnce = false;
function logOnce(where, err) {
  if (!IS_DEV || loggedOnce) return;
  loggedOnce = true;
  console.log(`[push] ${where}: ${err?.message || err}`);
}

/**
 * Expo Go cannot receive remote pushes at all, a simulator has no push
 * transport, and a development bundle is reloaded far too often to be worth
 * registering — so none of those are attempted, and the module is never even
 * loaded there (see the header).
 */
function pushSupportedHere() {
  if (IS_DEV || IS_EXPO_GO) return false;
  if (!Device.isDevice) return false;
  return true;
}

/**
 * The expo-notifications module, or null wherever it must not run.
 *
 * `require` rather than `import` so nothing executes at module scope; every
 * caller goes through this one gate, which is what makes "zero expo-notifications
 * calls in Expo Go" a property of the file rather than of each call site.
 */
let notificationsModule = null;
function notifications() {
  if (!pushSupportedHere()) return null;
  if (notificationsModule) return notificationsModule;
  try {
    notificationsModule = require('expo-notifications');
  } catch (err) {
    logOnce('load', err);
    notificationsModule = null;
  }
  return notificationsModule;
}

function projectIdForThisBuild() {
  return Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId || null;
}

/**
 * Register this device for the signed-in account.
 *
 * Idempotent and re-runnable: the Account screen's "Turn on" button calls it
 * again after a denial, and a cold start calls it for a restored session.
 * Resolves to the resulting state; never rejects.
 */
export async function registerForPushNotifications({ appVersion } = {}) {
  try {
    if (IS_EXPO_GO) {
      setState({ status: PUSH_STATUS.EXPO_GO, token: null, message: null });
      return state;
    }
    const Notifications = notifications();
    if (!Notifications) {
      setState({ status: PUSH_STATUS.UNSUPPORTED, token: null, message: null });
      return state;
    }

    const projectId = projectIdForThisBuild();
    if (!projectId) {
      setState({ status: PUSH_STATUS.UNCONFIGURED, token: null, message: null });
      return state;
    }

    // The channel has to exist before the first push lands or Android has
    // nowhere to show it. HIGH so a breach makes a sound and heads-up rather
    // than sitting silently in the shade — that is the point of an alert.
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Limit alerts',
        description: 'A sensor reading crossed one of its configured limits.',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#2a78d6',
      });
    }

    let { status: permission } = await Notifications.getPermissionsAsync();
    if (permission !== 'granted') {
      ({ status: permission } = await Notifications.requestPermissionsAsync());
    }
    if (permission !== 'granted') {
      setState({ status: PUSH_STATUS.DENIED, token: null, message: null });
      return state;
    }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) throw new Error('Expo returned no push token.');

    await registerPushToken({
      token,
      platform: Platform.OS,
      device: Device.modelName || null,
      appVersion: appVersion || null,
    });
    setState({ status: PUSH_STATUS.ON, token, message: null });
  } catch (err) {
    // A server without the endpoint is a version gap, not a fault — the Account
    // screen says so in those words instead of showing Frappe's message.
    if (err instanceof FrappeError && err.isMissingEndpoint) {
      setState({ status: PUSH_STATUS.UNAVAILABLE, token: null, message: null });
    } else {
      setState({
        status: PUSH_STATUS.FAILED,
        token: null,
        message: err?.message || 'Push registration failed.',
      });
    }
    logOnce('register', err);
  }
  return state;
}

/**
 * Stop pushes to this device. Called from `signOut` BEFORE the session is
 * dropped — the request has to be authenticated as the account that registered
 * the token, and after `logout()` there is no one to be.
 *
 * Failure is swallowed: an unreachable server at sign-out must not block the
 * sign-out, and the server prunes tokens Expo reports as dead anyway.
 */
export async function unregisterPushNotifications() {
  const { token } = state;
  setState({ status: PUSH_STATUS.UNKNOWN, token: null, message: null });
  if (!token) return;
  try {
    await unregisterPushToken(token);
  } catch (err) {
    logOnce('unregister', err);
  }
}

/**
 * A denial that has already been given cannot be re-asked on Android: the
 * second `requestPermissionsAsync` resolves `denied` without a prompt. The only
 * way back on is the system settings page, so "Turn on" goes there when a
 * re-run lands on the same answer.
 */
export async function openNotificationSettings() {
  try {
    await Linking.openSettings();
  } catch {
    // Nothing further to offer.
  }
}

/* ── Receiving ────────────────────────────────────────────────────────────── */

/**
 * Show a push even while the app is in the foreground.
 *
 * The default is to suppress it, on the theory that the app is already showing
 * the relevant thing. Here it usually is not — a breach on the cold room is
 * worth a banner over whichever chart happens to be open.
 *
 * A no-op wherever push is unsupported: this is one of the calls Expo Go
 * red-boxes on Android, which is what made the guard a module-wide rule.
 */
export function installForegroundHandler() {
  const Notifications = notifications();
  if (!Notifications) return;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  } catch (err) {
    logOnce('handler', err);
  }
}

/**
 * React to a tapped notification — the one that is open now, or the one that
 * launched the app.
 *
 * `onAlert({ site, sensorName, measure, alert })` is called for a limit alert;
 * anything else is ignored. The launch response and the live listener can both
 * report the same tap, so responses are de-duplicated by request identifier.
 * Returns the unsubscribe — a no-op function where push is unsupported.
 */
export function watchNotificationTaps(onAlert) {
  const Notifications = notifications();
  if (!Notifications) return () => {};

  const handled = new Set();

  const handle = (response) => {
    const request = response?.notification?.request;
    const id = request?.identifier;
    if (id && handled.has(id)) return;
    if (id) handled.add(id);

    const data = request?.content?.data;
    if (!data || data.type !== PUSH_TYPE_LIMIT_ALERT) return;
    onAlert({
      site: data.site || null,
      sensorName: data.sensor_name || null,
      measure: data.measure || null,
      alert: data.alert || null,
    });
  };

  let sub = null;
  try {
    sub = Notifications.addNotificationResponseReceivedListener(handle);
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) handle(response);
      })
      .catch((err) => logOnce('launch response', err));
  } catch (err) {
    logOnce('taps', err);
  }

  return () => {
    try {
      sub?.remove?.();
    } catch {
      /* already gone */
    }
  };
}
