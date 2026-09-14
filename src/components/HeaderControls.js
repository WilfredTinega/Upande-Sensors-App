import React from 'react';
import { Image, Pressable, Text, View } from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';

import { SelectField } from './ui';
import { useDashboard } from '../context/DashboardContext';
import { useNotifications } from '../context/NotificationsContext';
import { useThemePreference } from '../context/ThemeContext';
import { goToNotifications } from '../navigation/ref';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';

/**
 * Header title for Home: the Upande mark, and nothing else.
 *
 * The word "Home" was the only thing on the screen naming the app, and it named
 * the wrong thing — the tab bar's highlighted house glyph already says where
 * you are, so the title was repeating it. The mark is the app identifying
 * itself, once, on its landing screen, where the other screens carry a title
 * that has actual work to do. Same asset and size as the sidebar's launcher, so
 * the two read as one mark in two places rather than two marks.
 *
 * The accessibility label stays "Home": a screen reader needs the destination,
 * not the brand.
 */
export function HomeHeaderTitle() {
  return (
    <Image
      source={require('../../assets/upande-logo.png')}
      style={{ width: 28, height: 28 }}
      resizeMode="contain"
      accessibilityRole="image"
      accessibilityLabel="Home"
    />
  );
}

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
 *
 * "All sites" is offered, but never the DEFAULT: on every fresh launch — and
 * after a pull-to-refresh, which re-runs the same auto-pick this app has
 * always done — the filter lands on one real site, the one that reported most
 * recently. "All sites" only appears once someone picks it from this list by
 * hand, and it lasts only for that session; the next launch is back to one
 * site. A broad, unscoped view is something you reach for on purpose, not
 * something the app should hand you by default.
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
        allowClear
        clearLabel="All sites"
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

/**
 * The bell, top right of every screen.
 *
 * Alerts used to be a card inline on Home — five rows for the selected site,
 * which put a list of problems on the landing page whether or not there were
 * any, and hid every other site's. A bell is the shape people expect for
 * "something happened while you were away": one glyph, a number when there is
 * something new, and the list one tap away from wherever they are.
 *
 * The badge is unread, not total — alerts raised since the list was last
 * opened — capped at "9+" because past nine the digit is noise and the size
 * of the badge would start to vary. Hidden altogether, glyph and all, on a
 * server without the alerts endpoints: a bell that opens "needs a newer
 * server" every time is a nag, not a feature.
 */
export function HeaderBell({ style }) {
  const t = useTheme();
  const { unread, supported } = useNotifications();
  if (!supported) return null;

  const badge = unread > 9 ? '9+' : String(unread);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={unread ? `Notifications, ${unread} unread` : 'Notifications'}
      onPress={goToNotifications}
      hitSlop={6}
      style={({ pressed }) => [
        { paddingHorizontal: 6, paddingVertical: 6, opacity: pressed ? 0.6 : 1 },
        style,
      ]}
    >
      <View>
        <Ionicons name="notifications-outline" size={22} color={t.textPrimary} />
        {unread ? (
          <View
            style={{
              position: 'absolute',
              top: -5,
              right: -7,
              minWidth: 17,
              height: 17,
              paddingHorizontal: 4,
              borderRadius: radius.pill,
              backgroundColor: t.accent,
              alignItems: 'center',
              justifyContent: 'center',
              // The same ring the Account tab's update dot wears, so the badge
              // reads as sitting ON the bell rather than bleeding into it.
              borderWidth: 1.5,
              borderColor: t.surface,
            }}
          >
            <Text
              style={{
                color: t.onAccent,
                fontSize: 9,
                lineHeight: 11,
                fontWeight: '700',
                fontFamily: font('700'),
                fontVariant: ['tabular-nums'],
              }}
            >
              {badge}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * The site-scoped screens' `headerRight`: bell, then the site filter.
 *
 * One row because `headerRight` takes a single element, and the bell goes on
 * the LEFT of the filter so the filter keeps the header's right edge — its
 * live / stale line is right-aligned under it and would otherwise sit under
 * the bell. The filter carries the header's right padding itself; the bell
 * only needs a small gap from it.
 */
export function HeaderSiteControls() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'stretch' }}>
      <HeaderBell style={{ marginRight: 2 }} />
      <HeaderSiteFilter />
    </View>
  );
}

/** Account's `headerRight`: bell, then the three theme buttons. */
export function HeaderAccountControls() {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <HeaderBell style={{ marginRight: spacing.xs }} />
      <HeaderThemeSwitch />
    </View>
  );
}
