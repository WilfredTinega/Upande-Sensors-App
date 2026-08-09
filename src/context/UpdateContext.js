import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import Constants from 'expo-constants';

import { autoCheckForUpdate, checkForUpdate, UPDATE_ERRORS } from '../api/updates';

/**
 * Whether a newer build exists, held app-wide.
 *
 * Lifted out of the Account screen so the tab bar can badge itself: a check
 * that only runs when someone opens Account tells the people who never open
 * Account nothing, which is most people most of the time. There is no Play
 * Store doing this for us, so the app has to raise its hand.
 */

const UpdateContext = createContext(null);

/** The running build, as stamped into app.json by the release workflow. */
export const APP_VERSION = Constants.expoConfig?.version ?? null;

export function UpdateProvider({ children }) {
  const [update, setUpdate] = useState(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  // One silent attempt per launch. `autoCheckForUpdate` throttles to once a day
  // across launches and swallows its own failures, so a phone that opens the
  // app twenty times offline makes at most one doomed request and shows nothing.
  useEffect(() => {
    let cancelled = false;
    autoCheckForUpdate(APP_VERSION).then((result) => {
      if (!cancelled && result) setUpdate((current) => current ?? result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** The Check for updates button: ignores the throttle, surfaces failures. */
  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const result = await checkForUpdate(APP_VERSION);
      setUpdate(result);
      return result;
    } catch (err) {
      setUpdate(null);
      setError({
        kind: err?.kind ?? UPDATE_ERRORS.FAILED,
        message: err?.message ?? 'The check could not be completed.',
      });
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  const value = useMemo(
    () => ({ update, checking, error, check, available: Boolean(update?.available) }),
    [update, checking, error, check],
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

/**
 * Safe outside the provider — returns a quiet default rather than throwing, so
 * a screen rendered before the tree is assembled simply shows no update.
 */
export function useUpdate() {
  return (
    useContext(UpdateContext) ?? {
      update: null,
      checking: false,
      error: null,
      check: async () => null,
      available: false,
    }
  );
}
