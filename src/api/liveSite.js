import { TTL_LIVE, cacheKey, cached } from './cache';
import { getLive } from './endpoints';

/**
 * One place that loads a site's live readings, shared by the Live screen and by
 * the sign-in freshness probe.
 *
 * They used to do the same two calls independently, so choosing the freshest
 * site fetched every site's readings and the Live screen then fetched the
 * winner's again — about two wasted seconds on every login. Both now go through
 * this cache key, so by the time the screen mounts its data is already there.
 *
 * Since `upande_sensors_app.live` answers with the sensors AND their values in
 * one request, the two halves come from a single call rather than two sequential
 * ones — the second used to need the names from the first, so the screen waited
 * on both before it could paint anything.
 */
export function liveKey(site) {
  return cacheKey('live_readings', { site });
}

/**
 * The two halves still have their own cache keys.
 *
 * They change at completely different rates: which sensors a site has is
 * near-static, while their values are the point of the screen. Keeping the keys
 * separate lets the screen keep painting the sensor list from a warm entry while
 * the values refresh behind it, and lets the values expire on their own short
 * TTL without discarding the list.
 */
export function sensorsKey(site) {
  return cacheKey('site_sensors', { site });
}

export function valuesKey(site) {
  return cacheKey('live_values', { site });
}

/**
 * The one request both halves are served from, de-duplicated in flight.
 *
 * Its key has to be dropped by anything that refreshes: `useQuery.refresh()`
 * forces *its own* key, and would otherwise be handed this memoised payload
 * straight back — a pull-to-refresh that fetched nothing.
 */
export function siteKey(site) {
  return cacheKey('app_live', { site });
}

function fetchSite(site) {
  return cached(siteKey(site), () => getLive(site), { ttl: TTL_LIVE });
}

/**
 * These two do NOT cache under `sensorsKey`/`valuesKey`.
 *
 * Those are the keys the screens' `useQuery` calls own, and caching under them
 * here made each loader ask `cached` for the very key it was being loaded for —
 * a cycle that never settles. The shared request below has its own key, which is
 * where the de-duplication actually belongs.
 */
export function loadSiteSensors(site) {
  return fetchSite(site).then((payload) => payload?.sensors || []);
}

/**
 * `sensors` is accepted for call-site compatibility and no longer needed — the
 * server returns a value for every sensor at the site, so there is nothing to
 * ask for by name.
 *
 * Same rule as above: no `cached` wrapper, or it collides with the screen's key.
 */
export function loadLiveValues(site, sensors) {
  void sensors;
  return fetchSite(site).then((payload) => payload?.values || {});
}

/** Sensors for a site plus their latest values. One call, both halves cached. */
export async function loadLiveForSite(site) {
  const payload = await fetchSite(site);
  return { sensors: payload?.sensors || [], live: payload?.values || {} };
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
