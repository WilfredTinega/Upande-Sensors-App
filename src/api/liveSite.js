import { TTL_LIVE, TTL_REFERENCE, cacheKey, cached } from './cache';
import { getLiveReadings, getSiteSensors } from './endpoints';

/**
 * One place that loads a site's live readings, shared by the Live screen and by
 * the sign-in freshness probe.
 *
 * They used to do the same two calls independently, so choosing the freshest
 * site fetched every site's readings and the Live screen then fetched the
 * winner's again — about two wasted seconds on every login. Both now go through
 * this cache key, so by the time the screen mounts its data is already there.
 */
export function liveKey(site) {
  return cacheKey('live_readings', { site });
}

/**
 * The two halves, cached separately.
 *
 * They change at completely different rates: which sensors a site has is
 * near-static, while their values are the point of the screen. Caching them
 * together meant every refresh re-fetched the sensor list too — a whole extra
 * round trip, and each one costs about a second against the cloud instance.
 *
 * Separate keys also let the screen paint the sensors as soon as they arrive
 * instead of waiting for the values, which cannot even be requested until the
 * names are known.
 */
export function sensorsKey(site) {
  return cacheKey('site_sensors', { site });
}

export function valuesKey(site) {
  return cacheKey('live_values', { site });
}

export function loadSiteSensors(site) {
  return cached(sensorsKey(site), async () => (await getSiteSensors(site)) || [], {
    ttl: TTL_REFERENCE,
  });
}

export function loadLiveValues(site, sensors) {
  const names = (sensors || []).map((s) => s.sensor_name).filter(Boolean);
  if (!names.length) return Promise.resolve({});
  return cached(valuesKey(site), async () => (await getLiveReadings(site, names)) || {}, {
    ttl: TTL_LIVE,
  });
}

/**
 * Sensors for a site plus their latest values. Two calls: names, then values.
 *
 * Both halves land in the caches the Live screen reads, so the sign-in probe
 * still warms the screen even though the screen asks for them separately.
 */
export async function loadLiveForSite(site) {
  const sensors = await loadSiteSensors(site);
  const live = await loadLiveValues(site, sensors);
  return { sensors, live };
}

export function fetchLiveForSite(site) {
  return cached(liveKey(site), () => loadLiveForSite(site), { ttl: TTL_LIVE });
}

/** Newest reading timestamp in a payload, or '' when nothing has reported. */
export function latestStamp(payload) {
  let newest = '';
  Object.values(payload?.live || {}).forEach((entry) => {
    const params = entry?.params?.length ? entry.params : entry ? [entry] : [];
    params.forEach((p) => {
      const ts = String(p?.ts || '');
      if (ts > newest) newest = ts;
    });
  });
  return newest;
}
