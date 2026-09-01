/**
 * Whether the app can currently reach anything, inferred from its own requests.
 *
 * Deliberately not `@react-native-community/netinfo` or `expo-network`. Those
 * report whether an interface is up, which is not the question: a phone on an
 * office wifi with a dead uplink, or behind a captive portal, is "connected"
 * and cannot reach the server. The only reliable evidence is whether our
 * requests are getting answers, and we are already making them.
 *
 * A `fetch` that rejects — as opposed to answering with a status — means the
 * request never completed a round trip. That is the signal.
 */

const listeners = new Set();

let offline = false;
/** Successful round trips are proof; a single failure is not, so failures count. */
let consecutiveFailures = 0;

/**
 * One failure can be a dropped socket on an otherwise fine connection, and
 * flipping the whole UI to "offline" for that is worse than waiting. Two in a
 * row is a pattern.
 */
const FAILURES_BEFORE_OFFLINE = 2;

function publish() {
  listeners.forEach((fn) => {
    try {
      fn(offline);
    } catch {
      // A broken subscriber must not stop the others being told.
    }
  });
}

/** Called by the client when a request never reached the server. */
export function reportUnreachable() {
  consecutiveFailures += 1;
  if (offline || consecutiveFailures < FAILURES_BEFORE_OFFLINE) return;
  offline = true;
  publish();
}

/**
 * Called by the client on any answered request, including an error status.
 *
 * A 403 is proof of connectivity — the server was reached and it replied. Only
 * a failure to complete a round trip says anything about the network.
 */
export function reportReachable() {
  consecutiveFailures = 0;
  if (!offline) return;
  offline = false;
  publish();
}

export function isOffline() {
  return offline;
}

/** Returns an unsubscribe function. Called with the current state immediately. */
export function subscribeToNetwork(fn) {
  listeners.add(fn);
  fn(offline);
  return () => listeners.delete(fn);
}

/** Forget everything — a server change makes past evidence irrelevant. */
export function resetNetworkState() {
  consecutiveFailures = 0;
  if (offline) {
    offline = false;
    publish();
  }
}
