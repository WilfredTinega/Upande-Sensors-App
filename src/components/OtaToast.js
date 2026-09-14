import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useUpdate } from '../context/UpdateContext';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';

/**
 * A toast, shown for the couple of seconds between a JS update finishing its
 * download and the app restarting into it.
 *
 * Styled after `OfflineToast` and mounted the same way — once, above the whole
 * tree — because the restart is app-wide and belongs to no screen. It exists so
 * the restart is announced rather than felt: an app that blinks and comes back
 * with no explanation reads as a crash, and a field user's next move after a
 * crash is to reinstall. Within the first seconds of launch the restart happens
 * without this (nothing has been started that could be lost, and there is
 * nothing on screen yet to explain it over) — see `UpdateContext`.
 *
 * `pointerEvents="none"`: it floats over live content, and a notification that
 * swallows a tap meant for the screen underneath is worse than no notification.
 */
export function OtaToast() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { otaReady } = useUpdate();
  /** Kept mounted through the fade-out, or it would vanish mid-animation. */
  const [visible, setVisible] = useState(false);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (otaReady) setVisible(true);
    Animated.timing(anim, {
      toValue: otaReady ? 1 : 0,
      duration: otaReady ? 180 : 140,
      easing: otaReady ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !otaReady) setVisible(false);
    });
  }, [otaReady, anim]);

  if (!visible) return null;

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] });

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        // Same clearance as the offline notice: above the tab bar and above
        // whatever the OS reserved at the bottom edge.
        bottom: insets.bottom + spacing.xxl * 2,
        left: spacing.lg,
        right: spacing.lg,
        opacity: anim,
        transform: [{ translateY }],
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          backgroundColor: t.surface,
          // Accent, not warning: this is good news, and the offline toast's
          // amber already means "something is wrong".
          borderColor: t.accent,
          borderWidth: 1,
          borderRadius: radius.md,
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.lg,
          elevation: 6,
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
        }}
      >
        <Ionicons name="cloud-download-outline" size={20} color={t.accent} />
        <Text
          style={[
            type.body,
            { color: t.textPrimary, flex: 1, fontWeight: '600', fontFamily: font('600') },
          ]}
        >
          Updating to the latest version…
        </Text>
      </View>
    </Animated.View>
  );
}
