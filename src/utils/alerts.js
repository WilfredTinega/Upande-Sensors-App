/**
 * Pure helpers for the Notifications list. No React, no network — exercised
 * by `tests/alerts.test.js` under plain node.
 */

import { parseServerTime } from './dates';

/** Midnight of the calendar day `date` falls on, in the phone's zone. */
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * "Today", "Yesterday", then the date — "Mon 8 Sep", with the year only once
 * it differs from this one. Calendar days in the PHONE's zone: the question a
 * reader asks of a list is "did this happen today", and today is where the
 * phone is, whatever zone the server keeps its clock in.
 */
export function dayLabel(date, now = new Date()) {
  const day = startOfDay(date);
  const today = startOfDay(now);
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const options = { weekday: 'short', day: 'numeric', month: 'short' };
  if (day.getFullYear() !== today.getFullYear()) options.year = 'numeric';
  try {
    return day.toLocaleDateString(undefined, options);
  } catch {
    // An engine without Intl still gets a readable, if plainer, date.
    return day.toDateString();
  }
}

/**
 * Newest-first rows into newest-first day groups, keyed by the calendar day of
 * `creation` — when the alert was RAISED, not `reading_timestamp`, because the
 * list is of notifications and the notification went out at creation. Rows
 * whose stamp does not parse are grouped under "Undated" at the end rather
 * than dropped: a breach with a broken timestamp is still a breach.
 *
 * Order is preserved, not re-sorted: the server already orders by creation
 * and a client sort would only disagree with it on ties.
 */
export function groupAlertsByDay(rows, now = new Date()) {
  const groups = [];
  const byKey = new Map();
  let undated = null;
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const at = parseServerTime(row?.creation);
    if (!at) {
      if (!undated) undated = { key: 'undated', label: 'Undated', rows: [] };
      undated.rows.push(row);
      return;
    }
    const day = startOfDay(at);
    const key = `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: dayLabel(day, now), rows: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  });
  if (undated) groups.push(undated);
  return groups;
}

/**
 * Was this alert raised after the list was last opened?
 *
 * `cursor` is the `creation` of the newest alert the server knew of when the
 * list was last opened — the server's OWN string, at whatever precision it
 * keeps (`YYYY-MM-DD HH:MM:SS.ffffff`), never a phone-clock stamp: the phone's
 * clock is in the wrong zone and the wrong precision, and a seconds-only
 * cursor re-matches the newest row forever. Both sides are the server's naive
 * format, zero-padded and fixed-width up to the fractional part, so a string
 * comparison IS a time comparison — and a seconds-only `creation` for the very
 * row the cursor names sorts before the cursor's fractional tail, which reads
 * as "seen", which is right. A null cursor is a phone that has never opened
 * the list, on which everything is unread — the honest reading of "never
 * looked". A row with no stamp is never marked: the marker is a claim about
 * recency, and there is none to make.
 */
export function isUnreadAlert(row, cursor) {
  const creation = normaliseStamp(row?.creation);
  if (!creation) return false;
  if (!cursor) return true;
  return creation > normaliseStamp(cursor);
}

/** `YYYY-MM-DD HH:MM:SS[.ffffff]` with the one variation Frappe emits folded. */
function normaliseStamp(value) {
  if (!value) return '';
  return String(value).trim().replace('T', ' ');
}

/**
 * Chip tone and word per breach direction. Two tones, so a run of rows can be
 * scanned for which way the readings went; the word carries the meaning, the
 * colour only separates the two.
 */
export function directionChip(direction) {
  return String(direction || '').toLowerCase() === 'below'
    ? { tone: 'warning', label: 'Below limit' }
    : { tone: 'critical', label: 'Above limit' };
}
