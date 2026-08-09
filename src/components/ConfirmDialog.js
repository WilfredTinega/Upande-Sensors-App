import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme, spacing, radius, type } from '../hooks/useTheme';

/**
 * Themed confirmation dialog.
 *
 * Replaces `Alert.alert` for confirmations because the native alert takes its
 * corner radius, surface and typography from the OS — it cannot be themed, so
 * it reads as a different app dropped on top of this one.
 *
 * Dismissing by backdrop or back button always resolves to *cancel*: for a
 * destructive action, an ambiguous dismissal must never be read as consent.
 */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = 'Yes',
  cancelLabel = 'No',
  destructive = false,
  onConfirm,
  onCancel,
}) {
  const t = useTheme();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: visible ? 160 : 120,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, anim]);

  if (!visible) return null;

  // A small rise rather than a scale — scaling blurs text mid-animation.
  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] });

  return (
    <Modal visible transparent animationType="none" onRequestClose={onCancel}>
      <Animated.View style={{ flex: 1, opacity: anim }}>
        <Pressable
          accessibilityLabel="Dismiss"
          onPress={onCancel}
          style={{
            flex: 1,
            backgroundColor: '#00000099',
            alignItems: 'center',
            justifyContent: 'center',
            padding: spacing.xl,
          }}
        >
          {/* Stops a tap inside the card from reaching the dismiss backdrop. */}
          <Pressable onPress={(e) => e.stopPropagation()} style={{ width: '100%', maxWidth: 380 }}>
            <Animated.View
              style={{
                backgroundColor: t.surface,
                borderRadius: radius.xl,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: t.border,
                paddingTop: spacing.xl,
                paddingHorizontal: spacing.xl,
                paddingBottom: spacing.lg,
                transform: [{ translateY }],
                elevation: 12,
                shadowColor: '#000',
                shadowOpacity: 0.25,
                shadowRadius: 16,
                shadowOffset: { width: 0, height: 6 },
              }}
            >
              <Text style={[type.title, { color: t.textPrimary, textAlign: 'center' }]}>
                {title}
              </Text>

              {message ? (
                <Text
                  style={[
                    type.body,
                    {
                      color: t.textSecondary,
                      textAlign: 'center',
                      lineHeight: 20,
                      marginTop: spacing.sm,
                    },
                  ]}
                >
                  {message}
                </Text>
              ) : null}

              <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl }}>
                <Pressable
                  accessibilityRole="button"
                  onPress={onCancel}
                  style={({ pressed }) => ({
                    flex: 1,
                    paddingVertical: 13,
                    borderRadius: radius.lg,
                    alignItems: 'center',
                    backgroundColor: pressed ? t.border : t.surfaceSunken,
                  })}
                >
                  <Text style={[type.heading, { color: t.textPrimary }]}>{cancelLabel}</Text>
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  onPress={onConfirm}
                  style={({ pressed }) => ({
                    flex: 1,
                    paddingVertical: 13,
                    borderRadius: radius.lg,
                    alignItems: 'center',
                    backgroundColor: destructive ? t.status.critical : t.accent,
                    opacity: pressed ? 0.85 : 1,
                  })}
                >
                  <Text style={[type.heading, { color: t.onAccent }]}>{confirmLabel}</Text>
                </Pressable>
              </View>
            </Animated.View>
          </Pressable>
        </Pressable>
      </Animated.View>
    </Modal>
  );
}
