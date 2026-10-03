import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme, spacing, radius, type } from '../hooks/useTheme';

/**
 * Themed one-button notice — the ConfirmDialog's card, for news rather than a
 * question ("You're up to date"). A round status badge on top, a title, a short
 * message, an optional pill (e.g. the version) and a single button.
 *
 * `tone` picks the badge: 'good' (check), 'info' (i) or 'warning' (!).
 */
const TONES = {
  good: { icon: 'checkmark', key: 'good' },
  info: { icon: 'information', key: null },
  warning: { icon: 'alert', key: 'warning' },
};

export function InfoDialog({ visible, tone = 'good', title, message, pill, buttonLabel = 'OK', onClose }) {
  const t = useTheme();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: visible ? 180 : 120,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, anim]);

  if (!visible) return null;

  const spec = TONES[tone] ?? TONES.good;
  const color = spec.key ? t.status[spec.key] : t.accent;
  // Same rise as ConfirmDialog, plus a small pop on the badge.
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] });
  const badgeScale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] });

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={{ flex: 1, opacity: anim }}>
        <Pressable
          accessibilityLabel="Dismiss"
          onPress={onClose}
          style={{
            flex: 1,
            backgroundColor: '#00000099',
            alignItems: 'center',
            justifyContent: 'center',
            padding: spacing.xl,
          }}
        >
          <Pressable onPress={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 360 }}>
            <Animated.View
              accessibilityRole="alert"
              style={{
                backgroundColor: t.surface,
                borderRadius: radius.xl,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: t.border,
                paddingTop: spacing.xl,
                paddingHorizontal: spacing.xl,
                paddingBottom: spacing.lg,
                alignItems: 'center',
                transform: [{ translateY }],
                elevation: 12,
                shadowColor: '#000',
                shadowOpacity: 0.25,
                shadowRadius: 16,
                shadowOffset: { width: 0, height: 6 },
              }}
            >
              {/* Soft halo, solid disc, white glyph. */}
              <Animated.View
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 36,
                  backgroundColor: color + '22',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transform: [{ scale: badgeScale }],
                }}
              >
                <View
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 24,
                    backgroundColor: color,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Ionicons name={spec.icon} size={28} color="#ffffff" />
                </View>
              </Animated.View>

              <Text style={[type.title, { color: t.textPrimary, textAlign: 'center', marginTop: spacing.lg }]}>
                {title}
              </Text>

              {message ? (
                <Text
                  style={[
                    type.body,
                    { color: t.textSecondary, textAlign: 'center', lineHeight: 20, marginTop: spacing.sm },
                  ]}
                >
                  {message}
                </Text>
              ) : null}

              {pill ? (
                <View
                  style={{
                    marginTop: spacing.md,
                    paddingHorizontal: spacing.md,
                    paddingVertical: 5,
                    borderRadius: radius.pill,
                    backgroundColor: t.surfaceSunken,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: t.border,
                  }}
                >
                  <Text style={[type.caption, { color: t.textPrimary, fontWeight: '600' }]}>{pill}</Text>
                </View>
              ) : null}

              <Pressable
                accessibilityRole="button"
                onPress={onClose}
                style={({ pressed }) => ({
                  alignSelf: 'stretch',
                  marginTop: spacing.xl,
                  paddingVertical: 13,
                  borderRadius: radius.lg,
                  alignItems: 'center',
                  backgroundColor: t.accent,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Text style={[type.heading, { color: t.onAccent }]}>{buttonLabel}</Text>
              </Pressable>
            </Animated.View>
          </Pressable>
        </Pressable>
      </Animated.View>
    </Modal>
  );
}
