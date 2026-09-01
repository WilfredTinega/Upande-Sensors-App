import { AppState } from 'react-native';
import { File, Paths } from 'expo-file-system';

import { logRoutes, queueRouteHistory } from '../api/endpoints';
import { getServerOffsetMinutes } from './timezone';

/**
 * Records which screens are opened, into Frappe's own `Route History` doctype.
 *
 * Visits are **inserted directly**, in bulk, once a minute. The app is the
 * thing recording; nothing about it should depend on a cron running on the
 * site.
 *
 * Batched rather than sent per navigation: moving through four screens used to
 * be four requests, each about a second against the cloud instance, all of them
 * competing with the data the user is actually waiting for. One request a
 * minute carries the same visits at a fraction of the cost, and nothing on
 * screen is waiting on it.
 *
 * Batching used to cost timing, and no longer does.
 * `Document.set_user_and_timestamp` assigns `creation = now()` to every new
 * document, so the timestamp sent from here was discarded and a whole batch
 * landed stamped with the moment it was written — up to a minute after the
 * visits happened, and identical across the batch. The server script writes each
 * row's real visit time back after the insert, so what is recorded is when the
 * screen was opened rather than when the batch was flushed.
 *
 * The framework's own route is `deferred_insert`, which pushes to a Redis queue
 * that `frappe.deferred_insert.save_to_db` drains on a 15-minute cron. On this
 * instance that scheduler stopped, and every account except Administrator
 * silently stopped being recorded — the visits were accepted, queued, and never
 * written. It is kept here strictly as a fallback, for a site that has not had
 * `upande_sensors_app.log_routes` deployed: a direct insert through the generic
 * API needs `create` on Route History, and that doctype grants it to no role by
 * default, which is why the fallback existed in the first place. Whichever route
 * is in use is reported by `getRecordingStatus`, so a site running on the
 * fallback is visible rather than guessed at.
 *
 * Delivery is the part this file has to get right. A visit that fails to send
 * is kept and retried, survives the app being backgrounded or killed, and is
 * flushed before the session ends — because a route history with holes in it
 * that nobody can account for is worse than no route history at all.
 */

/** Unsent visits held in memory. Oldest first. */
let pending = [];
let enabled = false;
let inFlight = false;

/** Retry state. Reset by any successful send. */
let attempt = 0;
let retryTimer = null;
let flushTimer = null;
let appStateSub = null;

/**
 * Caps. Recording is telemetry and must never grow without bound: an account
 * offline for a day should not accumulate megabytes of visits, and a huge
 * backlog would only be rejected as one oversized request anyway.
 */
const MAX_PENDING = 500;
const BATCH = 100;
/** How often the queue is emptied. Visits accumulate locally in between. */
const FLUSH_EVERY_MS = 60000;
/** Backoff between retries. The last value repeats for as long as it takes. */
const RETRY_MS = [5000, 20000, 60000, 300000];

const STORE = 'route-history-pending.json';

/**
 * Last outcome of a send, so a silent failure can be shown rather than guessed
 * at.
 *
 * Recording must never interrupt the user, so failures are swallowed — which
 * also means that when one account records and another doesn't, there is no way
 * to tell why. This is that way.
 */
let status = { sentAt: null, sentCount: 0, error: null, pending: 0, via: null };


/**
 * When the direct insert was last refused for want of permission.
 *
 * Only a permission error sets it — a network failure says nothing about
 * whether the row could be written, and must not push the whole session onto
 * the fallback.
 *
 * Timestamped rather than latched: a 403 from Frappe is ambiguous (the client
 * treats an expired session and a genuine permission boundary the same way once
 * a re-login has already been tried), and a permission granted while someone is
 * signed in should start working without them signing out. The direct path is
 * therefore retried periodically instead of being abandoned for the session.
 */
let directRefusedAt = 0;
const RETRY_DIRECT_AFTER_MS = 10 * 60 * 1000;

function directAllowed() {
  return !directRefusedAt || Date.now() - directRefusedAt > RETRY_DIRECT_AFTER_MS;
}

export function getRecordingStatus() {
  return { ...status, pending: pending.length, directRefused: !!directRefusedAt };
}

/**
 * The last route queued, remembered across flushes.
 *
 * `onStateChange` can fire more than once for a single navigation, and the
 * queue empties on every send — so comparing against the queue alone let the
 * same screen be recorded twice in a row.
 */
let lastRecorded = null;

/** Now, expressed in the server's timezone, as Frappe's naive format. */
function serverNow() {
  const shifted = new Date(Date.now() + getServerOffsetMinutes() * 60000);
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

/* ── Durability ───────────────────────────────────────────────────────────── */

function storeFile() {
  return new File(Paths.cache, STORE);
}

/**
 * Keep the queue across a cold start.
 *
 * In the cache directory, not documents: these are replayable telemetry, and if
 * the OS reclaims the space the only cost is a few missing visits.
 */
function persist() {
  try {
    const file = storeFile();
    if (!pending.length) {
      if (file.exists) file.delete();
      return;
    }
    file.write(JSON.stringify(pending));
  } catch {
    // A queue that cannot be written is still held in memory; losing it on a
    // cold start is not worth surfacing to anyone.
  }
}

function restore() {
  try {
    const file = storeFile();
    if (!file.exists) return;
    const saved = JSON.parse(file.text());
    if (Array.isArray(saved) && saved.length) {
      // Restored visits are older than anything recorded this session.
      pending = [...saved, ...pending].slice(-MAX_PENDING);
    }
    file.delete();
  } catch {
    // Corrupt or unreadable: start clean rather than fail to start.
    try {
      storeFile().delete();
    } catch {
      /* nothing further to try */
    }
  }
}

/* ── Sending ──────────────────────────────────────────────────────────────── */

function scheduleRetry() {
  if (retryTimer || !enabled) return;
  // `attempt` has already been incremented for the failure being retried, so
  // the first retry is RETRY_MS[0] rather than the second entry.
  const wait = RETRY_MS[Math.min(Math.max(attempt - 1, 0), RETRY_MS.length - 1)];
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flush();
  }, wait);
}

/**
 * Write a batch, directly if allowed and through the queue if not.
 *
 * Returns which route was used. Anything other than a permission error is
 * rethrown: the batch stays queued and is retried, rather than being quietly
 * diverted onto a slower path that might not be needed.
 */
async function send(batch) {
  if (directAllowed()) {
    try {
      await logRoutes(batch);
      directRefusedAt = 0;
      return 'direct';
    } catch (err) {
      // A permission refusal, or an instance without the script deployed at all
      // — either way the direct route is unavailable here and the queue is the
      // only thing left. Anything else is a transient failure and is rethrown,
      // so the batch stays queued and is retried rather than being quietly
      // diverted onto a slower path that might not be needed.
      if (!err?.isPermission && !err?.isMissingEndpoint) throw err;
      directRefusedAt = Date.now();
    }
  }

  await queueRouteHistory(batch);
  return 'queued';
}

async function flush() {
  if (!pending.length || !enabled || inFlight) return;

  // One request at a time: a burst of taps coalesces into the next send rather
  // than opening a socket per tap.
  inFlight = true;
  const batch = pending.slice(0, BATCH);

  try {
    const via = await send(batch);
    // Only what was actually accepted is dropped from the queue — anything
    // recorded while the request was open stays.
    pending = pending.slice(batch.length);
    attempt = 0;
    status = {
      sentAt: Date.now(),
      sentCount: status.sentCount + batch.length,
      error: null,
      pending: pending.length,
      via,
    };
    persist();
  } catch (err) {
    /**
     * Kept, not dropped. The previous version discarded the batch on any
     * failure, so a moment of bad signal or a session being re-established
     * erased those visits permanently — with nothing to show that it had
     * happened.
     */
    attempt += 1;
    status = { ...status, error: err?.message || 'Unknown error', pending: pending.length };
    persist();
    scheduleRetry();
  } finally {
    inFlight = false;
    // Anything recorded while that request was open goes out now.
    if (pending.length && !attempt) flush();
  }
}

/** Called on every navigation. No-ops until a session exists. */
export function recordRoute(route) {
  if (!enabled || !route) return;
  // Consecutive duplicates add nothing — a re-render is not a visit. Going
  // A → B → A still records three, because only *immediate* repeats are cut.
  if (route === lastRecorded) return;

  lastRecorded = route;
  pending.push({ route, creation: serverNow() });
  // Oldest go first when the cap is hit: a recent visit is the more useful
  // record, and the oldest have already had every chance to send.
  if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
  // Not sent here — the minute timer collects whatever has accumulated, so a
  // burst of navigation is one request rather than one per screen.
  //
  // Written to disk on every visit, though. Sending used to happen here and
  // `persist` rode along with it; batching without this left up to a minute of
  // visits in memory alone, so a crash or a force-stop lost them and the
  // "survives being killed" promise above was no longer true. The file is a few
  // hundred bytes and the write is not awaited.
  persist();
}

/** Start recording once signed in; stop on sign-out. */
export function setRouteHistoryEnabled(next, user) {
  // `user` is accepted for call-site compatibility and no longer sent: both
  // write paths attribute the visit to the session account server-side, so a
  // value passed from here could only ever disagree with the session it was
  // written under.
  void user;
  if (next === enabled) return;
  enabled = next;

  if (next) {
    // A refusal belonged to the account that just left; the next one may well
    // be allowed to write.
    directRefusedAt = 0;
    restore();
    flushTimer = setInterval(flush, FLUSH_EVERY_MS);
    /**
     * Send what's queued when the app leaves the foreground.
     *
     * Android can kill a backgrounded app at any point, and this is the last
     * moment a request can still be made.
     */
    appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        flush();
        return;
      }
      // Going away: send now rather than at the next tick, since Android may
      // kill the process before it arrives. Persist either way.
      persist();
      flush();
    });
    flush();
    return;
  }

  lastRecorded = null;
  attempt = 0;
  clearTimeout(retryTimer);
  retryTimer = null;
  clearInterval(flushTimer);
  flushTimer = null;
  appStateSub?.remove();
  appStateSub = null;
  /**
   * The queue is kept, not cleared.
   *
   * These visits belong to the account that made them and the server attributes
   * them from the session, so anything unsent at sign-out is written to disk and
   * goes out on the next sign-in. Clearing here was a silent hole: every visit
   * made between the last successful send and logging out simply vanished.
   */
  persist();
}

/**
 * Send anything pending and wait for it.
 *
 * Called before the session is torn down, which is the last point the request
 * can still be authenticated.
 */
export function flushRouteHistory() {
  return flush();
}
