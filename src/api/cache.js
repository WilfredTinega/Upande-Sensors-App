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
const entering = new Set(); // keys inside the synchronous span of their loader

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
  /**
   * Re-entrancy guard. Without it, this function can hang forever.
   *
   * `inflight.set(key, …)` happens synchronously, before the loader runs in a
   * microtask. So if that loader asks for its OWN key — which is what
   * `useQuery(sensorsKey(site), () => loadSiteSensors(site))` did, because
   * `loadSiteSensors` cached under the same key — the inner call is handed the
   * outer promise, and the outer promise ends up waiting on itself. It never
   * settles, the loader is never reached, and no request is ever made: a screen
   * that skeletons forever with nothing in the network log to explain it.
   *
   * `entering` is held ONLY for the synchronous span of the loader's
   * invocation, which is precisely when a nested same-key call can be made from
   * inside it. Marking the whole in-flight window instead — the obvious version
   * of this guard — misreads an ordinary second consumer as a cycle and issues
   * it a duplicate request, which is the opposite of what this cache is for. A
   * device log caught exactly that: two `whoami` requests and a spurious
   * warning, because the Account screen asked while sign-in's ask was open.
   *
   * Running the loader uncached is the right answer for a genuine cycle. It is
   * one duplicate request in a situation that would otherwise produce none at
   * all, ever.
   */
  if (entering.has(key)) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn(
        `[cache] re-entrant load of "${key}" — a loader asked for its own key. ` +
          'Served uncached; give the inner request its own key.',
      );
    }
    return Promise.resolve().then(() => loader());
  }

  // Checked before anything else creates work: a request already open for this
  // key is the one every later caller should be waiting on.
  const existing = inflight.get(key);
  if (existing) return existing;

  if (!force) {
    const hit = store.get(key);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.data);
  }

  const promise = Promise.resolve()
    .then(() => {
      entering.add(key);
      try {
        return loader();
      } finally {
        // Cleared as soon as the loader hands back its promise, not when that
        // promise settles — see the note above.
        entering.delete(key);
      }
    })
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
