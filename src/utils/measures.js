/**
 * The order measures are presented in, everywhere.
 *
 * The server returns parameters in whatever order it assembled them, which
 * differs between sensors and between endpoints. Without a fixed order the same
 * measure lands in a different position on every card and in a different colour
 * slot on every chart. Anything unlisted follows alphabetically, so the order is
 * total rather than partial.
 */
export const MEASURE_ORDER = ['temperature', 'humidity', 'soil moisture', 'soil temperature'];

export function measureRank(type) {
  const i = MEASURE_ORDER.indexOf(String(type || '').trim().toLowerCase());
  return i === -1 ? MEASURE_ORDER.length : i;
}

/** Sort by the canonical order, then by name. Non-mutating. */
export function sortByMeasure(items, keyOf = (x) => x) {
  return [...items].sort((a, b) => {
    const rank = measureRank(keyOf(a)) - measureRank(keyOf(b));
    if (rank !== 0) return rank;
    return String(keyOf(a) || '').localeCompare(String(keyOf(b) || ''));
  });
}

/**
 * Measures never plotted. `Production` is a reporting figure, not a sensor
 * reading — on a shared axis with temperature and humidity it is meaningless.
 */
export const EXCLUDED_MEASURES = new Set(['production']);

export function isPlottable(type) {
  return !EXCLUDED_MEASURES.has(String(type || '').trim().toLowerCase());
}

/**
 * Every distinct parameter the site's sensors actually report, from a
 * `get_live_readings` payload.
 *
 * Read from live data rather than Sensor Settings because the two can disagree:
 * a tab lists the types someone configured, while this lists what is genuinely
 * arriving from the sensors on that site.
 */
export function measuresFromLive(payload, unitForType = () => '') {
  const byKey = new Map();

  Object.values(payload?.live || {}).forEach((entry) => {
    const params = entry?.params?.length ? entry.params : entry ? [entry] : [];
    params.forEach((p) => {
      const label = String(p?.type || '').trim();
      if (!label || !isPlottable(label)) return;
      const key = label.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, { label, unit: p.uom || unitForType(label) });
    });
  });

  return sortByMeasure([...byKey.values()], (m) => m.label);
}

/**
 * Was this bucket actually measured?
 *
 * `Number(null)` is 0 and 0 is finite, so coercing first quietly turns every
 * empty bucket into a measured zero — which is how a 7-day chart came to show
 * "0" on its tiles: the dense hourly grid is mostly gaps, and the last of them
 * was being read as the latest reading.
 */
export function isMeasured(value) {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

/** Just the measured values of a series, as numbers. */
export function measuredValues(values = []) {
  return values.filter(isMeasured).map(Number);
}

/* ── Derived measures ─────────────────────────────────────────────────────── */

// Magnus-Tetens constants, matching upande_sensors/api/climate.py exactly — the
// app and the desk must not disagree about a number they both display.
const MAGNUS_A = 17.625;
const MAGNUS_B = 243.04;

export const DEW_POINT = 'Dew Point';
export const DELTA_T = 'ΔT';

/** Dew point in °C. Null when the inputs can't support one. */
export function dewPoint(tempC, rhPct) {
  // `Number(null)` is 0 and 0 is finite, so a missing temperature would be
  // treated as 0 °C and yield a confident, wrong dew point. Reject the empty
  // cases before coercing.
  const empty = (v) => v === null || v === undefined || v === '';
  if (empty(tempC) || empty(rhPct)) return null;

  const t = Number(tempC);
  const rh = Number(rhPct);
  if (!Number.isFinite(t) || !Number.isFinite(rh)) return null;
  // Mirrors the server: humidity outside (0, 100] gives no usable answer.
  if (rh <= 0 || rh > 100) return null;
  const alpha = Math.log(rh / 100) + (MAGNUS_A * t) / (MAGNUS_B + t);
  return Math.round(((MAGNUS_B * alpha) / (MAGNUS_A - alpha)) * 100) / 100;
}

/** Air-to-dew spread, T − Td. */
export function deltaT(tempC, rhPct) {
  const td = dewPoint(tempC, rhPct);
  if (td === null) return null;
  const t = Number(tempC);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - td) * 10) / 10;
}

/**
 * Append Dew Point and ΔT, computed per bucket from temperature and humidity.
 *
 * Neither is a sensor type — the server derives them the same way for its own
 * summary. Buckets missing either input yield null, so the line breaks rather
 * than implying a reading that was never taken.
 */
export function withDerivedMeasures(series) {
  const find = (name) =>
    series.find((x) => String(x.label || '').trim().toLowerCase() === name);
  const temp = find('temperature');
  const humidity = find('humidity');
  if (!temp || !humidity) return series;

  const length = temp.values.length;
  const dew = new Array(length).fill(null);
  const delta = new Array(length).fill(null);

  for (let i = 0; i < length; i += 1) {
    dew[i] = dewPoint(temp.values[i], humidity.values[i]);
    delta[i] = deltaT(temp.values[i], humidity.values[i]);
  }

  const hasAny = (arr) => arr.some((v) => v !== null);
  const out = [...series];
  if (hasAny(dew)) out.push({ label: DEW_POINT, unit: '°C', values: dew });
  if (hasAny(delta)) out.push({ label: DELTA_T, unit: '°C', values: delta });
  return out;
}
