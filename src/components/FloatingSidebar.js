import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Skeleton } from './Skeleton';
import { useDashboard } from '../context/DashboardContext';
import { useAuth } from '../context/AuthContext';
import { goToAccount } from '../navigation/ref';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';

/**
 * Panel width is derived from the longest dashboard name so nothing truncates.
 *
 * Measuring the rendered text would be circular — the rows can only lay out
 * once the panel has a width — so this estimates from character count at the
 * row's font size. Poppins at 14pt averages ~7.6px per character; the estimate
 * is deliberately generous and then clamped, so a wrong guess costs a little
 * slack rather than a clipped name.
 */
const CHAR_WIDTH = 7.6;
/** Accent bar, gaps, tick, row padding and the panel's own padding. */
const ROW_CHROME = 92;
const MIN_FRACTION = 0.5;
const MAX_FRACTION = 0.86;

function panelWidthFor(labels, screenWidth) {
  const longest = labels.reduce((n, l) => Math.max(n, String(l || '').length), 0);
  const wanted = longest * CHAR_WIDTH + ROW_CHROME;
  return Math.round(
    Math.min(screenWidth * MAX_FRACTION, Math.max(screenWidth * MIN_FRACTION, wanted)),
  );
}

/**
 * The launcher — the Upande mark in the header, top left, where a navigation
 * drawer is conventionally opened from.
 */
export function SidebarToggle() {
  const t = useTheme();
  const { openSidebar, activeTab } = useDashboard();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open dashboard tabs${activeTab ? `, currently ${activeTab.label}` : ''}`}
      onPress={openSidebar}
      hitSlop={8}
      style={({ pressed }) => ({
        paddingLeft: spacing.lg,
        paddingRight: spacing.sm,
        paddingVertical: spacing.sm,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {/*
        The logo exactly as supplied — arrow, ring and white disc — not the
        arrow-only derivative used for the launcher icon, and untinted. It
        carries its own light background, so it stays legible on the dark theme
        without needing a tile behind it.
      */}
      <Image
        source={require('../../assets/upande-logo.png')}
        style={{ width: 28, height: 28 }}
        resizeMode="contain"
      />
    </Pressable>
  );
}

/**
 * One row per tab, and nothing below it.
 *
 * A tab's sensor types are no longer separate destinations — "Temperature and
 * Humidity" is one dashboard whose types share a chart, so listing them as two
 * entries would imply two places to go when there is one.
 */
function TabRow({ tab }) {
  const t = useTheme();
  const { activeTabName, selectTab } = useDashboard();
  const isActive = tab.name === activeTabName;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
      onPress={() => selectTab(tab.name)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: 12,
        paddingHorizontal: spacing.md,
        marginBottom: spacing.xs,
        borderRadius: radius.md,
        backgroundColor: isActive ? t.accentSoft : pressed ? t.surfaceSunken : 'transparent',
      })}
    >
      {/* Identity bar, not a coloured label — the text stays in ink. */}
      <View
        style={{
          width: 3,
          height: 18,
          borderRadius: 2,
          backgroundColor: isActive ? t.accent : 'transparent',
        }}
      />
      <Text
        numberOfLines={1}
        style={[type.body, { color: t.textPrimary, fontWeight: isActive ? '700' : '500', fontFamily: isActive ? font('700') : font('500'), flex: 1 }]}
      >
        {tab.label}
      </Text>
      {isActive ? <Text style={{ color: t.accent }}>✓</Text> : null}
    </Pressable>
  );
}

/**
 * Slide-over panel listing the tabs configured in Sensor Settings. Selecting
 * one sets the active tab app-wide, which also drives the `tab_tag` the sensor
 * queries send.
 */
export function FloatingSidebar() {
  const t = useTheme();
  const {
    sidebarOpen,
    closeSidebar,
    tabs,
    configLoading,
    configError,
    dashboardTitle,
  } = useDashboard();

  const { user, baseUrl } = useAuth();
  // Measured rather than a fixed 44pt guess, so the header clears the status
  // bar exactly and the content sits as high as it safely can.
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const panelWidth = useMemo(
    () => panelWidthFor(tabs.map((tab) => tab.label), screenWidth),
    [tabs, screenWidth],
  );

  // Starts fully off-screen rather than at -panelWidth, which is not known
  // until the tabs load; any value past the panel's own width is off-screen.
  const slide = useRef(new Animated.Value(-screenWidth)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (sidebarOpen) {
      setMounted(true);
      Animated.parallel([
        Animated.timing(slide, {
          toValue: 0,
          duration: 220,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else if (mounted) {
      Animated.parallel([
        Animated.timing(slide, {
          toValue: -panelWidth,
          duration: 180,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(fade, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start(({ finished }) => {
        // Unmount only after the exit animation, or the panel vanishes instead
        // of sliding out.
        if (finished) setMounted(false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarOpen]);

  if (!mounted) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={closeSidebar}>
      <View style={{ flex: 1 }}>
        <Animated.View style={{ ...StyleSheet.absoluteFillObject, opacity: fade }}>
          <Pressable
            accessibilityLabel="Close tabs"
            onPress={closeSidebar}
            style={{ flex: 1, backgroundColor: '#00000073' }}
          />
        </Animated.View>

        <Animated.View
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: panelWidth,
            backgroundColor: t.background,
            borderRightWidth: StyleSheet.hairlineWidth,
            borderRightColor: t.border,
            transform: [{ translateX: slide }],
            elevation: 16,
          }}
        >
          <View
            style={{
              paddingTop: insets.top + spacing.md,
              paddingHorizontal: spacing.lg,
              paddingBottom: spacing.md,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: t.border,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <Image
                source={require('../../assets/upande-logo.png')}
                style={{ width: 38, height: 38 }}
                resizeMode="contain"
              />
              <Text numberOfLines={2} style={[type.title, { color: t.textPrimary, flex: 1 }]}>
                {dashboardTitle}
              </Text>
            </View>

          </View>

          <ScrollView
            contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xxl }}
            showsVerticalScrollIndicator={false}
          >
            {/* No section heading: the list is the whole panel, and nothing
                here is defined in the app — every row comes from Sensor
                Settings on the connected server. */}
            {configLoading ? (
              <View style={{ gap: spacing.sm, paddingHorizontal: spacing.md }}>
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} height={38} radius={radius.md} />
                ))}
              </View>
            ) : configError ? (
              <Text
                style={[
                  type.caption,
                  { color: t.status.serious, paddingHorizontal: spacing.md, lineHeight: 17 },
                ]}
              >
                ▲ Couldn’t load tabs — {configError.message}
              </Text>
            ) : tabs.length ? (
              tabs.map((tab) => (
                <TabRow key={tab.name} tab={tab} />
              ))
            ) : (
              <Text
                style={[
                  type.caption,
                  { color: t.textMuted, paddingHorizontal: spacing.md, lineHeight: 17 },
                ]}
              >
                No tabs are enabled in Sensor Settings for your account.
              </Text>
            )}

          </ScrollView>

          {/* Pinned below the list rather than inside it, so a long set of
              dashboards can never scroll the signed-in account out of view. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Signed in as ${user?.fullName || user?.name}. Opens account`}
            onPress={() => {
              closeSidebar();
              goToAccount();
            }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.sm,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.lg,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: t.border,
              backgroundColor: pressed ? t.surfaceSunken : 'transparent',
            })}
          >
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: radius.pill,
                backgroundColor: t.accentSoft,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Ionicons name="person" size={16} color={t.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text
                numberOfLines={1}
                style={[type.caption, { color: t.textPrimary, fontWeight: '600', fontFamily: font('600') }]}
              >
                {user?.fullName || user?.name || 'Signed in'}
              </Text>
              <Text numberOfLines={1} style={[type.caption, { color: t.textMuted }]}>
                {baseUrl?.replace(/^https?:\/\//, '')}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={14} color={t.textMuted} />
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}
