import React from 'react';
import { ActivityIndicator, Platform, StatusBar, View } from 'react-native';
import { useFonts } from 'expo-font';
import {
  Poppins_400Regular,
  Poppins_500Medium,
  Poppins_600SemiBold,
  Poppins_700Bold,
} from '@expo-google-fonts/poppins';

import { SafeAreaProvider } from 'react-native-safe-area-context';

import { IS_EXPO_GO } from './src/api/push';
import { OtaToast } from './src/components/OtaToast';
import { AuthProvider } from './src/context/AuthContext';
import { ThemeProvider, useThemePreference } from './src/context/ThemeContext';
import { UpdateProvider } from './src/context/UpdateContext';
import { RootNavigator } from './src/navigation/RootNavigator';
import { getTheme } from './src/theme';

/**
 * Android stopped letting apps colour the status bar at API 35, where edge to
 * edge became mandatory. Below that the strip is still ours to paint.
 */
const BAR_IS_PAINTABLE = Platform.OS === 'android' && Number(Platform.Version) < 35;

/**
 * The strip behind the clock, in the page's own colour — no seam.
 *
 * `expo-status-bar` cannot do this any more: it dropped `backgroundColor` when
 * edge to edge became the Android default, and sets only the icon style. React
 * Native's own StatusBar still carries the prop, so on every phone below API 35
 * the strip is painted the page colour and the boundary between it and the app
 * disappears, which is the whole point.
 *
 * At API 35 and above the prop is ignored and the strip belongs to whoever owns
 * the window. In a build that is us, via `androidStatusBar` in app.json, so the
 * icons keep following the theme. In Expo Go it is the client's, and black
 * whatever the app asks for — dark icons on it are invisible, the battery and
 * signal simply disappear — so there they go light regardless of the theme.
 * That is a limitation of Expo Go, not a preference.
 */
function ThemedStatusBar() {
  const preference = useThemePreference();
  const dark = preference?.scheme === 'dark';
  const t = getTheme(dark ? 'dark' : 'light');
  const lightIcons = BAR_IS_PAINTABLE ? dark : IS_EXPO_GO || dark;
  return (
    <StatusBar
      animated
      translucent={false}
      backgroundColor={t.background}
      barStyle={lightIcons ? 'light-content' : 'dark-content'}
    />
  );
}

/**
 * Paints the window, not just the screens inside it.
 *
 * Where Android draws edge to edge, the strip behind the clock is whatever sits
 * underneath it — and with nothing painting the root, that was the platform's
 * own window background: a black band across the top of every screen, which on
 * the light theme looked like the app had not finished loading. This is the
 * half of the fix that works at API 35 and above, where `ThemedStatusBar` can
 * no longer colour the bar itself.
 */
function ThemedRoot({ children }) {
  const preference = useThemePreference();
  const t = getTheme(preference?.scheme === 'dark' ? 'dark' : 'light');
  return <View style={{ flex: 1, backgroundColor: t.background }}>{children}</View>;
}

export default function App() {
  // Four weights, because Android picks a font file per weight rather than
  // synthesising one — see FONTS in src/theme.js.
  const [fontsLoaded, fontError] = useFonts({
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
    Poppins_700Bold,
  });

  // Rendering before the faces are registered shows a frame of system font that
  // then reflows. A font that fails to load is not worth blocking on, though —
  // the app stays usable on the platform default.
  if (!fontsLoaded && !fontError) {
    const t = getTheme('light');
    return (
      <View style={{ flex: 1, backgroundColor: t.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={t.accent} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedRoot>
          {/* Outside AuthProvider: releases live on GitHub, so the check neither
              needs a session nor should wait for one. */}
          <UpdateProvider>
            <AuthProvider>
              <ThemedStatusBar />
              <RootNavigator />
              {/* Above the whole tree, signed in or not: a JS update can finish
                  downloading on the login screen too, and the restart it
                  announces is the app's, not one screen's. */}
              <OtaToast />
            </AuthProvider>
          </UpdateProvider>
        </ThemedRoot>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
