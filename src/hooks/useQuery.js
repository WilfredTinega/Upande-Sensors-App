import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { TTL_SERIES, cached, peek } from '../api/cache';
import { subscribeToNetwork } from '../api/network';

/**
 * Cache-aware data hook.
 *
 * If the key is already cached it returns the data on the *first render*, with
 * `loading` false — no flash of skeleton on a screen the user has already
 * visited. Only a genuine miss shows a loading state.
 *
 * `key` must be a stable string built from every input the loader reads
 * (see `cacheKey`). A null key means "not ready yet" and skips the fetch.
 *
 * `pollMs` re-fetches on an interval, for data that changes on the server
 * rather than in response to anything the user does here.
 */
export function useQuery(key, loader, { ttl = TTL_SERIES, enabled = true, pollMs = 0 } = {}) {
  const active = enabled && !!key;
  const initial = active ? peek(key) : undefined;

  const [data, setData] = useState(initial);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(active && initial === undefined);
  const [refreshing, setRefreshing] = useState(false);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  /** Set when a load was abandoned for want of a connection. */
  const offlineRef = useRef(false);
  // Guards against a slow response for an old key overwriting a newer one.
  const keyRef = useRef(key);
  keyRef.current = key;

  const run = useCallback(
    async (mode) => {
      const runKey = key;
      if (!runKey || !enabled) return;

      const hit = mode === 'load' ? peek(runKey) : undefined;
      if (hit !== undefined) {
        setData(hit);
        setLoading(false);
        setError(null);
        return;
      }

      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        const result = await cached(runKey, () => loaderRef.current(), {
          ttl,
          force: mode === 'refresh',
        });
        if (keyRef.current !== runKey) return; // filters moved on; drop this result
        setData(result);
      } catch (err) {
        if (keyRef.current !== runKey || err?.name === 'AbortError') return;
        /**
         * Being offline is not an answer, so it is not reported as one.
         *
         * `ErrorView` says "this could not be loaded", which is a claim about
         * the data. With no connection the truthful state is "not yet": the
         * screen keeps its skeleton, the offline notice explains why, and the
         * effect below re-runs the moment a request gets through again. Saying
         * "check the site URL" over a working server, as this used to, sent
         * people to re-type an address that was never wrong.
         */
        if (err?.isOffline) {
          setError(null);
          offlineRef.current = true;
          return;
        }
        setError(err);
      } finally {
        if (keyRef.current === runKey) {
          // Left loading while offline: the skeleton is the honest state, and a
          // retry is already queued.
          if (!offlineRef.current) setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [key, enabled, ttl],
  );

  useEffect(() => {
    if (!active) {
      setLoading(false);
      return;
    }
    run('load');
  }, [active, run]);

  /**
   * Polling, paused while the app is in the background.
   *
   * An interval keeps firing behind a backgrounded app, so without this check
   * a screen left open overnight would wake to a queue of stale requests and
   * spend the user's data on answers nobody was waiting for.
   */
  useEffect(() => {
    if (!active || !pollMs) return undefined;
    const id = setInterval(() => {
      if (AppState.currentState === 'active') run('refresh');
    }, pollMs);
    return () => clearInterval(id);
  }, [active, pollMs, run]);

  /**
   * Retry as soon as anything gets through again.
   *
   * Only for a load this hook actually abandoned — subscribing every query to
   * every reconnection would refetch screens nobody is looking at.
   */
  useEffect(() => {
    return subscribeToNetwork((offline) => {
      if (offline || !offlineRef.current) return;
      offlineRef.current = false;
      run('load');
    });
  }, [run]);

  const refresh = useCallback(() => run('refresh'), [run]);

  return { data, error, loading, refreshing, refresh };
}
