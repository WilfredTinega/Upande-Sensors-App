import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { subscribeToNetwork } from '../api/network';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';

/**
 * A toast, shown while the app cannot reach the server.
 *
 * Mounted once above the navigator rather than per screen: connectivity is a
 * property of the app, not of whichever tab happens to be open, and one notice
 * is the truth however many queries are stalled behind it.
 *
 * It says what to check and nothing else. The screens keep their skeletons and
 * retry on their own, so there is no action to offer and no "Retry" button that
 * would only repeat what is already happening.
 *
 * `pointerEvents="none"` throughout: it floats over live content, and a
 * notification that swallows a tap meant for the screen underneath is worse
 * than no notification.
 */
export function OfflineToast() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [offline, setOffline] = useState(false);
  /** Kept mounted through the fade-out, or it would vanish mid-animation. */
  const [visible, setVisible] = useState(false);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => subscribeToNetwork(setOffline), []);

  useEffect(() => {
    if (offline) setVisible(true);
    Animated.timing(anim, {
      toValue: offline ? 1 : 0,
      duration: offline ? 180 : 140,
      easing: offline ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !offline) setVisible(false);
    });
  }, [offline, anim]);

  if (!visible) return null;

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] });

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        /**
         * Clear of the tab bar AND of the system navigation, whichever mode the
         * device is in: three buttons and a gesture pill claim different amounts
         * of the bottom edge, and a fixed offset can only be right for one of
         * them. `insets.bottom` is what the OS actually reserved.
         */
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
          borderColor: t.status.warning,
          borderWidth: 1,
          borderRadius: radius.md,
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.lg,
          // Legible over a chart or a table rather than blending into it.
          elevation: 6,
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
        }}
      >
        <Ionicons name="cloud-offline-outline" size={20} color={t.status.warning} />
        <Text
          style={[
            type.body,
            { color: t.textPrimary, flex: 1, fontWeight: '600', fontFamily: font('600') },
          ]}
        >
          Check your internet connection
        </Text>
      </View>
    </Animated.View>
  );
}
