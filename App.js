import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import {
  Poppins_400Regular,
  Poppins_500Medium,
  Poppins_600SemiBold,
  Poppins_700Bold,
} from '@expo-google-fonts/poppins';

import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from './src/context/AuthContext';
import { ThemeProvider, useThemePreference } from './src/context/ThemeContext';
import { RootNavigator } from './src/navigation/RootNavigator';
import { getTheme } from './src/theme';

/**
 * The status bar follows the app's own theme, not the OS — with an explicit
 * Light choice on a dark-mode phone, OS-derived bar icons would be invisible.
 */
function ThemedStatusBar() {
  const preference = useThemePreference();
  return <StatusBar style={preference?.scheme === 'dark' ? 'light' : 'dark'} />;
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
        <AuthProvider>
          <ThemedStatusBar />
          <RootNavigator />
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
