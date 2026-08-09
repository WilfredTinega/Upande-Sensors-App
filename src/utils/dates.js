/**
 * Date helpers.
 *
 * Frappe's sensor API speaks `YYYY-MM-DD` for filters and returns naive
 * `YYYY-MM-DD HH:MM:SS` timestamps in the *server's* timezone. Everything that
 * turns one of those strings into an instant goes through `parseServerTime` so
 * the timezone assumption lives in exactly one place.
 */

import { CLOCK_SKEW_TOLERANCE_MINUTES, STALE_AFTER_MINUTES } from '../config';
import { getServerOffsetMinutes } from './timezone';

export function toISODate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

export function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/**
 * Turn a naive server timestamp into a real instant, honouring
 * the resolved server offset. Returns null for anything unparseable rather than
 * an Invalid Date, so callers only have one bad case to handle.
 */
export function parseServerTime(value) {
  if (!value) return null;
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!match) return null;

  const [, y, mo, d, h, mi, s] = match;
  const asUTC = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s || 0),
  );
  // Read on every call rather than captured at import, so changing the zone in
  // Account immediately re-dates everything already on screen.
  return new Date(asUTC - getServerOffsetMinutes() * 60000);
}

/** Age in minutes. Negative means the timestamp is ahead of this device. */
export function ageInMinutes(value) {
  const parsed = parseServerTime(value);
  if (!parsed) return null;
  return (Date.now() - parsed.getTime()) / 60000;
}

/**
 * Named ranges for the Charts and Readings screens.
 *
 * `days` is an *inclusive* span: 7 days means today plus the six before it, so
 * the label matches the number of days actually fetched. (Getting this wrong
 * is easy — the server widens `dateTo` to 23:59:59, so an exclusive span
 * silently returns one day more than the label promises.)
 *
 * `interval` is paired with each range deliberately: a single day bucketed
 * daily collapses to one point, and two months bucketed hourly is ~1400 points
 * of unreadable noise.
 */
export const RANGES = [
  { key: 'today', label: 'Today', days: 1, interval: 'hourly' },
  { key: '7d', label: '7 days', days: 7, interval: 'hourly' },
  { key: '15d', label: '15 days', days: 15, interval: 'daily' },
  { key: '30d', label: '30 days', days: 30, interval: 'daily' },
  { key: '60d', label: '60 days', days: 60, interval: 'daily' },
];

export function rangeToDates(rangeKey) {
  // Falls back to the first range (Today) so an unknown key lands on the same
  // default the screens open with, not a different window.
  const range = RANGES.find((r) => r.key === rangeKey) || RANGES[0];
  return {
    dateFrom: toISODate(daysAgo(range.days - 1)),
    dateTo: toISODate(new Date()),
    interval: range.interval,
    label: range.label,
    days: range.days,
  };
}

/**
 * Drop trailing buckets that lie in the future.
 *
 * The server fills every bucket up to the end of `dateTo`, and for cumulative
 * types (energy / flow / precipitation) it fills the empty ones with `0` rather
 * than null. Those zeroes are indistinguishable from a measured zero, so a
 * chart viewed at 09:00 shows flow "stopping" and reading zero for the rest of
 * the day. Trimming to now is the only way to tell the two apart client-side.
 */
export function futureTrimIndex(labels = []) {
  const nowServer = Date.now();
  let end = labels.length;
  while (end > 0) {
    const parsed = parseServerTime(labels[end - 1]);
    // Labels for weekly/monthly/yearly buckets ("2026-32", "2026-08") don't
    // parse as timestamps; leave those series untouched rather than guessing.
    if (!parsed) break;
    if (parsed.getTime() <= nowServer) break;
    end -= 1;
  }
  return end;
}

export function trimFuturePoints(labels = [], values = []) {
  if (!labels.length) return { labels, values };
  const end = futureTrimIndex(labels);
  if (end === labels.length) return { labels, values };
  return { labels: labels.slice(0, end), values: values.slice(0, end) };
}

/** Same trim, applied across several series that share one label axis. */
export function trimFutureSeries(labels = [], series = []) {
  if (!labels.length) return { labels, series };
  const end = futureTrimIndex(labels);
  if (end === labels.length) return { labels, series };
  return {
    labels: labels.slice(0, end),
    series: series.map((s) => ({ ...s, values: s.values.slice(0, end) })),
  };
}

/**
 * The server timestamp to the minute: `2026-08-09 14:32`.
 *
 * Kept as the server's own naive string rather than a reformatted local time —
 * this is the value stored against the reading, and a table that silently
 * shifted it would not match what the desk UI or an export shows.
 */
export function fullTimestamp(value) {
  if (!value) return '—';
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text)
    ? `${text.slice(0, 10)} ${text.slice(11, 16)}`
    : text.slice(0, 16);
}

/** Trim the server's `YYYY-MM-DD HH:MM:SS` down to something a phone can show. */
export function shortTimestamp(value) {
  if (!value) return '—';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text)) {
    return `${text.slice(5, 10)} ${text.slice(11, 16)}`;
  }
  return text.slice(0, 16);
}

export function relativeTime(value) {
  const minutes = ageInMinutes(value);
  if (minutes === null) return null;

  // A timestamp meaningfully ahead of the device clock means the server
  // timezone assumption or one of the two clocks is wrong. Saying "just now"
  // would launder a misconfiguration into a freshness claim.
  if (minutes < -CLOCK_SKEW_TOLERANCE_MINUTES) return 'clock mismatch';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Is this reading too old to present as current?
 *
 * Unknown and future-dated timestamps both count as stale. Both mean we cannot
 * substantiate "this is live", and for equipment monitoring the honest default
 * when in doubt is to say so rather than to show a confident green light.
 */
export function isStale(value, thresholdMinutes = STALE_AFTER_MINUTES) {
  const minutes = ageInMinutes(value);
  if (minutes === null) return true;
  if (minutes < -CLOCK_SKEW_TOLERANCE_MINUTES) return true;
  return minutes > thresholdMinutes;
}

export { STALE_AFTER_MINUTES };
