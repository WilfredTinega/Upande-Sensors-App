import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';

import * as SecureStore from 'expo-secure-store';

import { getAlertsCount } from '../api/endpoints';
import { watchNotificationsReceived } from '../api/push';
import { useAuth } from './AuthContext';

/**
 * The read cursor: the `creation` of the newest alert the server knew of the
 * last time the list was opened, stored VERBATIM as the server sent it.
 *
 * Not the phone's clock. The server keeps `creation` to the microsecond and
 * `since` means strictly after, so a cursor stamped from a seconds-only or
 * differently-zoned clock either re-matches the newest row forever (the badge
 * never clears) or swallows alerts raised in the gap. The server's own string
 * for its own newest row is the one value that cannot be off by either.
 *
 * SecureStore rather than the request cache because it has to outlive the
 * process: a phone that forgot the cursor at every cold start would greet each
 * morning with every alert of the month marked unread. Per phone, not per
 * account — the question is about this reader's eyes, and a shared field
 * phone is one pair.
 */
const KEY_CURSOR = 'upande.alertsCursor';

/**
 * How often the count is re-read while the app is on screen. A minute is the
 * server's own cadence for the readings the alerts come from; a push arriving
 * short-circuits the wait (see below), so this is the floor for a phone that
 * has no push, not the latency anyone with push sees.
 */
const POLL_MS = 60000;

/** What `useNotifications()` answers outside the provider — no bell, no badge. */
const NOT_PROVIDED = {
  unread: 0,
  supported: false,
  ready: false,
  cursor: null,
  markOpened: () => null,
  refreshCount: async () => {},
};

const NotificationsContext = createContext(null);

/**
 * The unread-alert count behind the header bell, and the cursor it is measured
 * against.
 *
 * Its own context rather than a corner of `DashboardContext` because it is
 * scoped differently: that context is about the SELECTED SITE — its list, its
 * tabs, its counts — while the bell is about the PERSON, across every site
 * they may see, and stays the same number whichever site the filter names.
 * Mounted inside the signed-in tree, so a sign-out unmounts it and the next
 * account starts its own polling; the stored cursor is the one thing carried
 * over, deliberately (see `KEY_CURSOR`).
 *
 * `supported` goes false the first time the count endpoint answers
 * `isMissingEndpoint`, and the bell hides entirely: a badge that can never be
 * filled would be a promise the server cannot keep.
 */
export function NotificationsProvider({ children }) {
  const { user } = useAuth();

  const [cursor, setCursor] = useState(null);
  const [ready, setReady] = useState(false);
  const [unread, setUnread] = useState(0);
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    let cancelled = false;
    SecureStore.getItemAsync(KEY_CURSOR)
      .then((stored) => {
        if (cancelled) return;
        setCursor(stored && String(stored).trim() ? String(stored).trim() : null);
      })
      .catch(() => {
        // A store that cannot be read behaves like a first run: everything in
        // the window counts as unread until the list is opened once.
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The cursor as the requests see it: read at call time so a poll that was
  // already scheduled uses the mark the list just moved, not the one it
  // closed over.
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  /**
   * Each request carries the generation it was issued in; a response from an
   * older generation is dropped. `markOpened` bumps it, so a poll that was in
   * flight when the list opened cannot land its stale count on a badge that
   * was just zeroed.
   */
  const generation = useRef(0);

  // `markOpened` is a focus-effect dependency on the Notifications screen, so
  // its identity has to hold still: a version that closed over `ready` would
  // re-run that effect — re-marking and reloading the list — the moment the
  // stored cursor finished loading underneath an open screen.
  const canCount = useRef(false);
  canCount.current = ready && supported && Boolean(user?.name);

  const persistCursor = useCallback((latest) => {
    const next = latest && String(latest).trim() ? String(latest).trim() : null;
    // An empty `latest` is a scope with no alerts yet. The previous cursor
    // stays: moving it to nothing would re-mark the whole window unread the
    // day the first alert lands.
    if (!next || next === cursorRef.current) return;
    cursorRef.current = next;
    setCursor(next);
    SecureStore.setItemAsync(KEY_CURSOR, next).catch(() => {});
  }, []);

  /**
   * Re-read the count. Never rejects: a failed poll keeps the LAST number on
   * the badge, because a moment offline is not evidence that the alerts went
   * away — only a successful answer, or a missing endpoint, may change it.
   */
  const refreshCount = useCallback(async () => {
    if (!ready || !supported || !user?.name) return;
    const mine = generation.current;
    try {
      const answer = await getAlertsCount({ since: cursorRef.current });
      if (mine !== generation.current) return;
      const count = Number(answer?.count);
      setUnread(Number.isFinite(count) && count > 0 ? count : 0);
    } catch (err) {
      if (mine !== generation.current) return;
      if (err?.isMissingEndpoint) {
        setSupported(false);
        setUnread(0);
      }
    }
  }, [ready, supported, user?.name]);

  /**
   * Count on arrival, then every minute while the app is on screen, and again
   * the moment it comes back to the foreground — that last one is the common
   * case for a phone that was in a pocket, and the interval alone would leave
   * the badge stale for up to a minute after the screen lit.
   */
  useEffect(() => {
    if (!ready || !supported || !user?.name) return undefined;
    refreshCount();
    const id = setInterval(() => {
      if (AppState.currentState === 'active') refreshCount();
    }, POLL_MS);
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') refreshCount();
    });
    return () => {
      clearInterval(id);
      sub?.remove?.();
    };
  }, [ready, supported, user?.name, refreshCount]);

  /**
   * A push landing is the one moment the count is known to have changed, so
   * re-read it then rather than wait for the poll. The listener is a no-op
   * wherever push is unsupported — Expo Go, an emulator, a dev bundle — and
   * the poll carries those alone.
   */
  useEffect(() => {
    if (!ready || !supported) return undefined;
    return watchNotificationsReceived(() => {
      refreshCount();
    });
  }, [ready, supported, refreshCount]);

  /**
   * The list was opened, or pulled to refresh: from now on only alerts newer
   * than the newest one the server has RIGHT NOW count.
   *
   * The badge zeroes at once — the reader is looking at the list, so whatever
   * is on it is read — and the cursor moves when the server says what its
   * newest row is. That round trip is the point: the value stored is the
   * server's `latest`, never a stamp made here (see `KEY_CURSOR`). Until it
   * answers, the bumped generation keeps an in-flight poll from re-filling the
   * badge; if it fails, the cursor simply does not move and the next poll
   * reports the same alerts again, which is the truthful outcome of not
   * knowing.
   *
   * Returns the PREVIOUS cursor synchronously, which is what the list needs to
   * draw its unread markers — after this call the context itself considers
   * everything read.
   */
  const markOpened = useCallback(() => {
    const previous = cursorRef.current;
    generation.current += 1;
    const mine = generation.current;
    setUnread(0);
    if (canCount.current) {
      getAlertsCount({ since: previous })
        .then((answer) => {
          if (mine !== generation.current) return;
          persistCursor(answer?.latest);
        })
        .catch((err) => {
          if (mine !== generation.current) return;
          if (err?.isMissingEndpoint) setSupported(false);
        });
    }
    return previous;
  }, [persistCursor]);

  const value = useMemo(
    () => ({ unread, supported, ready, cursor, markOpened, refreshCount }),
    [unread, supported, ready, cursor, markOpened, refreshCount],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  return useContext(NotificationsContext) || NOT_PROVIDED;
}
