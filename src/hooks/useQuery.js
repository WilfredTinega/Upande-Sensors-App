import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { TTL_SERIES, cached, peek } from '../api/cache';

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
        setError(err);
      } finally {
        if (keyRef.current === runKey) {
          setLoading(false);
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

  const refresh = useCallback(() => run('refresh'), [run]);

  return { data, error, loading, refreshing, refresh };
}
