import React from 'react';
import { Alert, Linking, Pressable, Text } from 'react-native';

import { useTheme, spacing, type } from '../hooks/useTheme';
import { font } from '../theme';

const URL = 'https://upande.com';

/**
 * The "Powered by Upande ERP" footer, shared by the login and account screens
 * so the two can't drift apart.
 *
 * The brand half is in accent ink to mark it as tappable — the whole line is
 * the hit target, which is easier to land on a phone than the words alone.
 */
export function PoweredBy({ style }) {
  const t = useTheme();

  const open = async () => {
    try {
      await Linking.openURL(URL);
    } catch {
      // A device with no browser handler shouldn't fail silently — the user
      // tapped something and deserves to know it didn't open.
      Alert.alert('Couldn’t open link', URL);
    }
  };

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel="Powered by Upande ERP. Opens upande.com"
      onPress={open}
      hitSlop={10}
      style={({ pressed }) => [
        { alignSelf: 'center', paddingVertical: spacing.sm, opacity: pressed ? 0.6 : 1 },
        style,
      ]}
    >
      <Text style={[type.body, { color: t.textSecondary, textAlign: 'center' }]}>
        Powered by <Text style={{ color: t.accent, fontWeight: '700', fontFamily: font('700') }}>Upande ERP</Text>
      </Text>
    </Pressable>
  );
}
