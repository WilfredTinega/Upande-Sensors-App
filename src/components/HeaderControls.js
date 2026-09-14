import React from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';

import { SelectField } from './ui';
import { useDashboard } from '../context/DashboardContext';
import { useNotifications } from '../context/NotificationsContext';
import { useThemePreference } from '../context/ThemeContext';
import { useUpdate } from '../context/UpdateContext';
import { goToNotifications } from '../navigation/ref';
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
  const { activeTab, configLoading } = useDashboard();
  // The second line names the dashboard being shown rather than the screen,
  // which is what the sidebar just chose and the only thing that changes here.
  return <HeaderSiteTitle title={activeTab?.label || (configLoading ? 'Loading…' : 'Sensor dashboard')} />;
}

/**
 * The header's two lines: the site above, the screen below.
 *
 * They used to share one line — screen name left, site right — and competed
 * for it, because React Navigation budgets a flat 52 points for whatever sits
 * on the right and the site name is several times that. Stacked and centred,
 * neither has to be cut short, and the order says which matters: everything on
 * the screen is scoped by the site, so the site is the heading and the screen
 * is what you are looking at within it.
 *
 * The site line is the filter itself — tapping it still opens the picker.
 */
export function HeaderSiteTitle({ title }) {
  const t = useTheme();
  return (
    // Stretched, not hugging its contents: the block spans the header so the
    // two lines can align differently — the site centred in the bar, the screen
    // name against its left edge rather than under the middle of the site name.
    <View style={{ alignSelf: 'stretch', justifyContent: 'center' }}>
      <HeaderSiteFilter />
      {title ? (
        <Text
          numberOfLines={1}
          style={[
            type.caption,
            {
              // 14, not the caption's 11: this names the screen you are on, and
              // at caption size it read as a footnote to the site rather than
              // as the other half of the title.
              fontSize: 14,
              textAlign: 'left',
              color: t.textSecondary,
              marginTop: 1,
              fontFamily: font('700'),
            },
          ]}
        >
          {title}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The site line of the title, and the filter itself.
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
  const { width } = useWindowDimensions();
  const { sites, site, setSite, filtersLocked } = useDashboard();

  return (
    <View
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
        /**
         * The centre of the bar, between the sidebar button and the bell, is
         * what a long site name has to live in — "Kuehne Nagel KN1 & KN2" at
         * 16/700 is most of a narrow phone. Past this it ellipsises rather
         * than wrapping, which would push the screen name below it off.
         */
        flexShrink: 1,
        maxWidth: Math.min(260, Math.round(width * 0.6)),
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
 * The bell, at the right edge of the header, on every screen that has header
 * controls of its own.
 *
 * Alerts used to be a card inline on Home — five rows for the selected site,
 * which put a list of problems on the landing page whether or not there were
 * any, and hid every other site's. A bell is the shape people expect for
 * "something happened while you were away": one glyph, a number when there is
 * something new, and the list one tap away from wherever they are.
 *
 * The badge is unread, not total — alerts raised since the list was last
 * opened, plus a waiting app update — capped at "9+" because past nine the
 * digit is noise and the size of the badge would start to vary. Hidden
 * altogether, glyph and all, when there is neither: on a server without the
 * alerts endpoints and with nothing to install, a bell that opens "needs a
 * newer server" every time is a nag, not a feature.
 */
export function HeaderBell({ style }) {
  const t = useTheme();
  const { unread, supported } = useNotifications();
  /**
   * The badge counts what the list holds, and a waiting update is a row in it.
   *
   * It used to count server alerts alone, so a phone with an update and no
   * breaches opened the list to an item the bell had said nothing about. The
   * update is also why the bell can outlive the alerts endpoints: on a server
   * too old for them there is still that one row to reach, and a hidden bell
   * would make it unreachable.
   */
  const { available: updateAvailable } = useUpdate();
  const count = (supported ? unread : 0) + (updateAvailable ? 1 : 0);
  if (!supported && !updateAvailable) return null;

  const badge = count > 9 ? '9+' : String(count);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={count ? `Notifications, ${count} unread` : 'Notifications'}
      onPress={goToNotifications}
      hitSlop={6}
      style={({ pressed }) => [
        { paddingHorizontal: 6, paddingVertical: 6, opacity: pressed ? 0.6 : 1 },
        style,
      ]}
    >
      <View>
        <Ionicons name="notifications-outline" size={22} color={t.textPrimary} />
        {count ? (
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
 * The site-scoped screens' `headerRight`: the site filter, then the bell.
 *
 * One row because `headerRight` takes a single element. The bell sits on the
 * RIGHT, on the header's own edge, which is where a phone's notification
 * affordance is looked for; the site name reads as the continuation of the
 * title beside it rather than as something after the bell.
 *
 * The header's right padding is on this row, not on the bell: the bell renders
 * nothing on a server without the alerts endpoints, and padding carried by it
 * would go with it, leaving the site name flush against the screen edge.
 */
export function HeaderSiteControls() {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'stretch',
        paddingRight: spacing.lg,
      }}
    >
      <HeaderBell />
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
