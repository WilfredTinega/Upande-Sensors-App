/**
 * Coordinate arithmetic for the sensor location capture and the map.
 *
 * Pure functions, no React Native imports: `tests/geo.test.js` loads this file
 * as-is under plain node, so anything added here has to stay that way.
 */

/** A fix this sharp or sharper is 100 %. Consumer GNSS bottoms out near it. */
export const ACCURACY_FULL_M = 3;

/** A fix this vague or vaguer is 0 % — a whole greenhouse away. */
export const ACCURACY_ZERO_M = 50;

/** How long a scan watches the GPS before it stops on its own. */
export const SCAN_SECONDS = 30;

/**
 * A finite number, or null. `Number(null)` is 0, which would make a missing
 * accuracy read as a perfect fix and a missing latitude as the equator.
 */
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The GPS accuracy as a percentage on the scale the screen documents:
 * ±3 m = 100 %, ±50 m = 0 %, linear between.
 *
 * `accuracy` from the platform is the radius, in metres, inside which the true
 * position lies with 68 % confidence — a number, not a grade, and one that
 * means nothing to someone who has never read a GPS spec. A percentage is
 * what people read as "good enough yet". The end points are honest: three
 * metres is about as sharp as a phone's GNSS gets standing still, and at fifty
 * the fix could be in the next row of the greenhouse.
 *
 * Returns null for anything that is not a finite non-negative number, so a
 * fix without an accuracy shows nothing rather than 100 %.
 */
export function accuracyPercent(accuracy) {
  const a = finiteNumber(accuracy);
  if (a === null || a < 0) return null;
  const fraction = (ACCURACY_ZERO_M - a) / (ACCURACY_ZERO_M - ACCURACY_FULL_M);
  return Math.round(Math.max(0, Math.min(1, fraction)) * 100);
}

/**
 * Below this an accuracy is treated as this floor when weighting.
 *
 * A fix reporting 0 m — which some emulators and a few chipsets do — would
 * otherwise get infinite weight and be the whole answer on its own.
 */
const WEIGHT_FLOOR_M = 0.5;

/**
 * The running position from a set of fixes, each weighted by 1/accuracy².
 *
 * A plain mean treats a 40 m fix taken under a roof the same as a 3 m fix
 * taken a moment later in the open, and the vague one drags the answer. Inverse
 * variance weighting is what a receiver does internally: the sharp fix counts
 * for more, in proportion to how much more it can be trusted, and a run of
 * fixes that tightens over thirty seconds converges on the tight ones.
 *
 * The reported `accuracy` is the weighted mean of the fixes' accuracies — an
 * honest summary of the fixes that went in, not the (much smaller) formal
 * error of the mean, which would claim a precision the receiver never had.
 *
 * Returns null with no usable fix. Fixes with a non-finite coordinate or
 * accuracy are skipped rather than poisoning the sum.
 */
export function weightedPosition(fixes) {
  let sumW = 0;
  let sumLat = 0;
  let sumLng = 0;
  let sumAcc = 0;
  let samples = 0;
  (Array.isArray(fixes) ? fixes : []).forEach((fix) => {
    const lat = finiteNumber(fix?.latitude);
    const lng = finiteNumber(fix?.longitude);
    const acc = finiteNumber(fix?.accuracy);
    if (lat === null || lng === null || acc === null || acc < 0) return;
    const w = 1 / Math.max(acc, WEIGHT_FLOOR_M) ** 2;
    sumW += w;
    sumLat += lat * w;
    sumLng += lng * w;
    sumAcc += acc * w;
    samples += 1;
  });
  if (!samples || !sumW) return null;
  return {
    latitude: sumLat / sumW,
    longitude: sumLng / sumW,
    accuracy: sumAcc / sumW,
    samples,
  };
}

const EARTH_RADIUS_M = 6371008.8;

/**
 * Great-circle distance between two points, in metres.
 *
 * For the "you are moving this sensor 14 m" line on the overwrite confirmation.
 * Haversine is overkill for tens of metres — a flat-earth approximation would
 * do — but it costs nothing and is right at every distance, so nobody has to
 * wonder whether it holds for a sensor moved between sites.
 */
export function haversineMetres(a, b) {
  const lat1 = finiteNumber(a?.latitude);
  const lng1 = finiteNumber(a?.longitude);
  const lat2 = finiteNumber(b?.latitude);
  const lng2 = finiteNumber(b?.longitude);
  if ([lat1, lng1, lat2, lng2].some((v) => v === null)) return null;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whether a row carries a real position.
 *
 * 0,0 is what an untouched Float pair reads as on the server, and it is also
 * a point in the Gulf of Guinea — so it is "not set" here, the same rule the
 * server applies in `has_location`.
 */
export function hasCoordinates(row) {
  const lat = finiteNumber(row?.latitude);
  const lng = finiteNumber(row?.longitude);
  if (lat === null || lng === null) return false;
  return !(lat === 0 && lng === 0);
}

/** "-1.29210, 36.82190" — five places is about a metre, which is all GPS gives. */
export function formatCoordinates(lat, lng, digits = 5) {
  const a = finiteNumber(lat);
  const b = finiteNumber(lng);
  if (a === null || b === null) return '—';
  return `${a.toFixed(digits)}, ${b.toFixed(digits)}`;
}

/** "±4 m", "±12 m", "±1.2 km" — one significant place under 10, none above. */
export function formatMetres(m, { prefix = '±' } = {}) {
  const n = finiteNumber(m);
  if (n === null || n < 0) return null;
  if (n >= 1000) return `${prefix}${(n / 1000).toFixed(1)} km`;
  if (n < 10) return `${prefix}${n.toFixed(1)} m`;
  return `${prefix}${Math.round(n)} m`;
}
