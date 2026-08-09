import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { getTheme } from '../theme';

const KEY_THEME = 'upande.theme';

export const THEME_MODES = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'System', value: 'system' },
];

const ThemeContext = createContext(null);

/**
 * Appearance preference for the whole app.
 *
 * Defaults to **light** rather than following the OS. Most of these phones sit
 * in dark mode by habit, and the readings screens are read outdoors in daylight
 * where the light palette is easier to see — so the app picks light and lets
 * anyone who prefers otherwise say so, including "follow the system".
 *
 * Lives above the auth gate so the login screen is themed too.
 */
export function ThemeProvider({ children }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState('light');

  useEffect(() => {
    let cancelled = false;
    SecureStore.getItemAsync(KEY_THEME)
      .then((stored) => {
        if (cancelled) return;
        if (stored === 'light' || stored === 'dark' || stored === 'system') setModeState(stored);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback(async (next) => {
    setModeState(next);
    await SecureStore.setItemAsync(KEY_THEME, next).catch(() => {});
  }, []);

  // 'system' is the only mode that consults the OS; the other two are explicit
  // choices and must win over it.
  const scheme = mode === 'system' ? systemScheme || 'light' : mode;
  const theme = useMemo(() => getTheme(scheme), [scheme]);

  const value = useMemo(() => ({ mode, setMode, scheme, theme }), [mode, setMode, scheme, theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Returns null outside a provider rather than throwing — `useTheme` falls back
 * to the light palette so a component rendered before the provider mounts still
 * has colours instead of crashing.
 */
export function useThemePreference() {
  return useContext(ThemeContext);
}
