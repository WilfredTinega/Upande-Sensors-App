/**
 * Which timezone the server's naive timestamps are in.
 *
 * Frappe returns timestamps like "2026-08-09 14:32:00" with nothing saying
 * which zone they belong to. Getting this wrong doesn't just shift labels — it
 * decides whether a reading counts as stale, and it errs in the dangerous
 * direction: assume a zone behind the server's and every reading looks newer
 * than it is, so a sensor that died hours ago reads as live.
 *
 * Three sources, best first:
 *   server — System Settings `time_zone`, the truth. Readable only by System
 *            Managers, so most accounts never get it.
 *   device — the phone's own zone. Right whenever the user and the site are in
 *            the same country, which is the normal case.
 *   manual — an explicit override, for the traveller or the remote operator.
 */

const listeners = new Set();

let state = {
  mode: 'auto', // auto | manual
  offsetMinutes: deviceOffsetMinutes(),
  source: 'device', // device | server | manual
  zoneName: null,
};

/** Minutes east of UTC for this device, e.g. Africa/Nairobi → 180. */
export function deviceOffsetMinutes() {
  // getTimezoneOffset is minutes *behind* UTC, so the sign is inverted.
  return -new Date().getTimezoneOffset();
}

export function deviceZoneName() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Resolve an IANA zone ("Africa/Nairobi") to minutes east of UTC.
 *
 * Wrapped in try/catch because a Hermes build without full ICU either throws or
 * silently ignores `timeZone`. Returning null lets the caller fall back rather
 * than quietly adopting the device zone under a "server" label.
 */
export function offsetFromZoneName(zone) {
  if (!zone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date());
    const name = parts.find((p) => p.type === 'timeZoneName')?.value || '';
    if (/^(GMT|UTC)$/i.test(name.trim())) return 0;
    const match = /(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?/i.exec(name);
    if (!match) return null;
    const sign = match[1] === '-' ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3] || 0));
  } catch {
    return null;
  }
}

/** The offset every timestamp parse uses. Read on each call, never cached. */
export function getServerOffsetMinutes() {
  return state.offsetMinutes;
}

export function getTimezoneState() {
  return state;
}

export function setTimezoneState(next) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn(state));
  return state;
}

export function subscribeTimezone(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** "UTC+3", "UTC-3:30", "UTC" — short enough for a row value. */
export function formatOffset(minutes) {
  if (!Number.isFinite(minutes)) return 'UTC';
  if (minutes === 0) return 'UTC';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** Selectable offsets, half-hour resolution across the real-world range. */
export function offsetOptions() {
  const options = [];
  for (let m = -12 * 60; m <= 14 * 60; m += 30) {
    options.push({ label: formatOffset(m), value: m });
  }
  return options;
}
