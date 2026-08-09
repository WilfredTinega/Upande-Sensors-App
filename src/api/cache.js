/**
 * A small request cache with in-flight deduplication.
 *
 * Why this exists: a round trip to the Frappe Cloud instance costs roughly a
 * second before any query runs — `/api/method/ping`, which does nothing at all,
 * measures ~1.0s. So the thing that makes the app feel slow is the *number* of
 * requests, not the cost of any one of them.
 *
 * The reference data (site list, sensor type options, dashboard config) is
 * identical for every screen and changes about never, yet each screen was
 * fetching its own copy — seven requests where one would do. Caching by key
 * turns tab switching from "another two seconds" into instant.
 *
 * Deduplication matters just as much: three screens mounting at once used to
 * fire three identical in-flight requests. Now the first one wins and the
 * others await it.
 */

const store = new Map(); // key -> { data, expires }
const inflight = new Map(); // key -> Promise

/** Reference data: changes when an admin edits Sensor Settings, so minutes. */
export const TTL_REFERENCE = 10 * 60 * 1000;
/** Readings and chart series: fresh enough to reuse across a tab switch. */
export const TTL_SERIES = 60 * 1000;
/** Live values: short, but long enough to survive navigating away and back. */
export const TTL_LIVE = 20 * 1000;

export function cacheKey(name, params = {}) {
  const parts = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k] ?? ''}`)
    .join('&');
  return parts ? `${name}?${parts}` : name;
}

/**
 * Resolve `key`, hitting `loader` only when there is no fresh entry and no
 * identical request already in flight.
 *
 * `force` skips the cached value but still joins an in-flight request — a
 * pull-to-refresh should not stack a second identical call on top of one that
 * is already running.
 */
export function cached(key, loader, { ttl = TTL_SERIES, force = false } = {}) {
  const existing = inflight.get(key);
  if (existing) return existing;

  if (!force) {
    const hit = store.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.data);
  }

  const promise = Promise.resolve()
    .then(() => loader())
    .then((data) => {
      store.set(key, { data, expires: Date.now() + ttl });
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

/** Read a fresh cached value without triggering a fetch. Used to paint first. */
export function peek(key) {
  const hit = store.get(key);
  return hit && hit.expires > Date.now() ? hit.data : undefined;
}

/**
 * Drop cached entries. With no argument, everything — which is what logging out
 * or switching servers must do, or the next user sees the previous one's sites.
 */
export function invalidate(prefix) {
  if (!prefix) {
    store.clear();
    inflight.clear();
    return;
  }
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
