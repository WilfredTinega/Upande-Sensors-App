import { AppState } from 'react-native';
import { File, Paths } from 'expo-file-system';

import { client } from '../api/client';
import { getServerOffsetMinutes } from './timezone';

/**
 * Records which screens are opened, into Frappe's own `Route History` doctype.
 *
 * Uses the framework's whitelisted `deferred_insert`, which stamps `user` from
 * the session server-side — a client cannot attribute a visit to someone else.
 * It is whitelisted without a role check, so every signed-in account can record;
 * the rows are written by the scheduler running as Administrator, so the
 * doctype granting `create` to nobody doesn't stand in the way.
 *
 * Note what "immediately" can and cannot mean here. `deferred_insert` pushes to
 * a Redis queue that Frappe's scheduler drains into the doctype on a 15-minute
 * cron (`frappe.deferred_insert.save_to_db`). The app records in real time; how
 * quickly rows *appear* is the server's scheduler, not ours.
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
let appStateSub = null;

/**
 * Caps. Recording is telemetry and must never grow without bound: an account
 * offline for a day should not accumulate megabytes of visits, and a huge
 * backlog would only be rejected as one oversized request anyway.
 */
const MAX_PENDING = 500;
const BATCH = 100;
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
let status = { sentAt: null, sentCount: 0, error: null, pending: 0 };

export function getRecordingStatus() {
  return { ...status, pending: pending.length };
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

async function flush() {
  if (!pending.length || !enabled || inFlight) return;

  // One request at a time: a burst of taps coalesces into the next send rather
  // than opening a socket per tap.
  inFlight = true;
  const batch = pending.slice(0, BATCH);

  try {
    await client.call(
      'frappe.desk.doctype.route_history.route_history.deferred_insert',
      { routes: JSON.stringify(batch) },
      { write: true },
    );
    // Only what was actually accepted is dropped from the queue — anything
    // recorded while the request was open stays.
    pending = pending.slice(batch.length);
    attempt = 0;
    status = {
      sentAt: Date.now(),
      sentCount: status.sentCount + batch.length,
      error: null,
      pending: pending.length,
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
  flush();
}

/** Start recording once signed in; stop on sign-out. */
export function setRouteHistoryEnabled(next) {
  if (next === enabled) return;
  enabled = next;

  if (next) {
    restore();
    /**
     * Send what's queued when the app leaves the foreground.
     *
     * Android can kill a backgrounded app at any point, and this is the last
     * moment a request can still be made.
     */
    appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') flush();
      else persist();
    });
    flush();
    return;
  }

  lastRecorded = null;
  attempt = 0;
  clearTimeout(retryTimer);
  retryTimer = null;
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
