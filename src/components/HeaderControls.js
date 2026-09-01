import React from 'react';
import { Pressable, Text, View } from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';

import { SelectField } from './ui';
import { useDashboard } from '../context/DashboardContext';
import { useThemePreference } from '../context/ThemeContext';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';

/**
 * Header title for the dashboard screen: the sidebar's active selection.
 *
 * A fixed "Sensor dashboard" told the user nothing the tab bar hadn't already —
 * naming the live selection means the header answers "which dashboard am I
 * looking at" without opening the sidebar to check.
 */
export function DashboardHeaderTitle() {
  const t = useTheme();
  const { activeTab, configLoading } = useDashboard();

  return (
    <Text
      numberOfLines={1}
      style={[type.heading, { color: t.textPrimary, fontSize: 17, fontWeight: '700', fontFamily: font('700') }]}
    >
      {activeTab?.label || (configLoading ? 'Loading…' : 'Sensor dashboard')}
    </Text>
  );
}

/**
 * Site filter, top right.
 *
 * Bare variant — a bordered field in a header would read as a second toolbar.
 * There is no "All sites" entry: a site is always selected, chosen on sign-in
 * as the one reporting most recently.
 */
export function HeaderSiteFilter() {
  const t = useTheme();
  const { sites, site, setSite, sensorCounts, filtersLocked } = useDashboard();

  return (
    <View
      style={{
        alignItems: 'flex-end',
        justifyContent: 'center',
        alignSelf: 'stretch',
        // Sized for the longest site name in use ("Kuehne Nagel KN1 & KN2") at
        // the filter's 14px weight-600 face; below this it ellipsises.
        maxWidth: 220,
        paddingRight: spacing.lg,
      }}
    >
      <SelectField
        variant="bare"
        compact
        value={site}
        options={sites}
        onChange={setSite}
        placeholder={filtersLocked ? 'Loading…' : 'Select site'}
        disabled={filtersLocked}
      />

      {/* Live / stale / total, directly under the filter they are scoped by.
          Each carries its word as well as its colour — a bare coloured number
          would rest identity on hue alone. */}
      {sensorCounts ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 }}>
          <Text style={[type.caption, { color: t.status.good, fontSize: 10, fontFamily: font('600') }]}>
            {sensorCounts.live} live
          </Text>
          <Text style={[type.caption, { color: t.textMuted, fontSize: 10 }]}>·</Text>
          <Text
            style={[
              type.caption,
              {
                color: sensorCounts.stale ? t.status.critical : t.textMuted,
                fontSize: 10,
                fontFamily: font('600'),
              },
            ]}
          >
            {sensorCounts.stale} stale
          </Text>
          <Text style={[type.caption, { color: t.textMuted, fontSize: 10 }]}>·</Text>
          <Text style={[type.caption, { color: t.textMuted, fontSize: 10 }]}>
            {sensorCounts.total} total
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Appearance switch, inline in the Account header.
 *
 * Three icon buttons rather than the segmented control it replaces: a header
 * has no room for "Light / Dark / System" as words, and all three states stay
 * visible so the current one is never hidden behind a cycling toggle.
 */
const THEME_ICONS = [
  { mode: 'light', icon: 'sunny-outline', label: 'Light theme' },
  { mode: 'dark', icon: 'moon-outline', label: 'Dark theme' },
  { mode: 'system', icon: 'phone-portrait-outline', label: 'Follow system theme' },
];

export function HeaderThemeSwitch() {
  const t = useTheme();
  const preference = useThemePreference();
  const mode = preference?.mode || 'light';

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        paddingRight: spacing.lg,
      }}
    >
      {THEME_ICONS.map((option) => {
        const active = option.mode === mode;
        return (
          <Pressable
            key={option.mode}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active }}
            onPress={() => preference?.setMode(option.mode)}
            hitSlop={4}
            style={({ pressed }) => ({
              paddingHorizontal: 7,
              paddingVertical: 6,
              borderRadius: radius.pill,
              backgroundColor: active ? t.accentSoft : 'transparent',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Ionicons
              name={option.icon}
              size={17}
              color={active ? t.accent : t.textMuted}
            />
          </Pressable>
        );
      })}
    </View>
  );
}
