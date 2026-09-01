import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { useTheme, spacing, radius } from '../hooks/useTheme';

/**
 * Skeleton placeholders.
 *
 * These replace spinners on every load that changes what is on screen. On a
 * ~1s-per-round-trip connection a spinner communicates only "wait"; a skeleton
 * in the shape of the incoming content keeps the layout stable, so the screen
 * doesn't jump when data lands and the wait reads as shorter than it is.
 */

/** One pulsing block. Opacity only, so it runs on the native driver. */
export function Skeleton({ width = '100%', height = 14, style, radius: r = radius.sm }) {
  const t = useTheme();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 750,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 750,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.75] });

  return (
    <Animated.View
      style={[
        { width, height, borderRadius: r, backgroundColor: t.surfaceSunken, opacity },
        style,
      ]}
    />
  );
}

function SkeletonSurface({ children, style }) {
  const t = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: t.surface,
          borderRadius: radius.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.border,
          padding: spacing.lg,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Mirrors a sensor card on the Live tab: title, chip, then a row of values. */
export function SkeletonSensorCard({ style }) {
  const t = useTheme();
  return (
    <SkeletonSurface style={[{ marginBottom: spacing.md }, style]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <View style={{ flex: 1, gap: 6 }}>
          <Skeleton width="62%" height={16} />
          <Skeleton width="38%" height={11} />
        </View>
        <Skeleton width={74} height={22} radius={radius.pill} />
      </View>
      <View
        style={{
          flexDirection: 'row',
          gap: spacing.lg,
          marginTop: spacing.md,
          paddingTop: spacing.md,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: t.border,
        }}
      >
        {[0, 1, 2].map((i) => (
          <View key={i} style={{ flex: 1, gap: 6 }}>
            <Skeleton width="70%" height={10} />
            <Skeleton width="55%" height={19} />
          </View>
        ))}
      </View>
    </SkeletonSurface>
  );
}

/**
 * Chart-shaped placeholder. The bars are staggered heights rather than a flat
 * block so the space reads as "a chart is coming", not "an image failed".
 */
export function SkeletonChart({ height = 240, style }) {
  const heights = useMemo(
    () => [0.45, 0.7, 0.35, 0.85, 0.55, 0.95, 0.4, 0.75, 0.6, 0.5, 0.8, 0.42],
    [],
  );

  return (
    <SkeletonSurface style={style}>
      <Skeleton width="45%" height={17} />
      <Skeleton width="72%" height={11} style={{ marginTop: 6, marginBottom: spacing.lg }} />

      <View
        style={{
          height,
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: 6,
          paddingLeft: spacing.xl,
        }}
      >
        {heights.map((h, i) => (
          <Skeleton key={i} width={undefined} height={height * h} style={{ flex: 1 }} />
        ))}
      </View>

      <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg }}>
        {[0, 1, 2, 3].map((i) => (
          <SkeletonSurface key={i} style={{ flex: 1, padding: spacing.md }}>
            <Skeleton width="80%" height={10} />
            <Skeleton width="60%" height={18} style={{ marginTop: 6 }} />
          </SkeletonSurface>
        ))}
      </View>
    </SkeletonSurface>
  );
}

/**
 * A row of stat tiles, as used above the Readings list.
 *
 * Mirrors the real tile row: one line, each tile at the same minimum width, so
 * the layout does not jump as data arrives. It does not scroll — a skeleton
 * offers nothing to reach by scrolling — it just clips at the edge like the
 * loaded row does before you drag it.
 */
export function SkeletonStatTiles({ count = 6, style }) {
  return (
    <View style={[{ flexDirection: 'row', flexWrap: 'nowrap', overflow: 'hidden', gap: spacing.sm }, style]}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonSurface key={i} style={{ flex: 1, minWidth: 116, padding: spacing.md }}>
          <Skeleton width="75%" height={10} />
          <Skeleton width="55%" height={20} style={{ marginTop: 6 }} />
        </SkeletonSurface>
      ))}
    </View>
  );
}

/** Compact list rows, for the per-sensor readings list. */
export function SkeletonList({ count = 4, style }) {
  return (
    <View style={style}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonSurface key={i} style={{ marginBottom: spacing.sm }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Skeleton width="50%" height={15} />
            <Skeleton width="22%" height={11} />
          </View>
          <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.md }}>
            {[0, 1, 2, 3].map((j) => (
              <View key={j} style={{ flex: 1, gap: 5 }}>
                <Skeleton width="65%" height={9} />
                <Skeleton width="48%" height={14} />
              </View>
            ))}
          </View>
        </SkeletonSurface>
      ))}
    </View>
  );
}

/** Placeholder for the filter block, so the top of a screen doesn't jump. */
export function SkeletonFilters({ style }) {
  return (
    <SkeletonSurface style={style}>
      <Skeleton width="26%" height={10} style={{ marginBottom: spacing.md }} />
      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        <View style={{ flex: 1, gap: 6 }}>
          <Skeleton width="40%" height={10} />
          <Skeleton height={42} radius={radius.md} />
        </View>
        <View style={{ flex: 1, gap: 6 }}>
          <Skeleton width="55%" height={10} />
          <Skeleton height={42} radius={radius.md} />
        </View>
      </View>
      <Skeleton height={36} radius={radius.pill} style={{ marginTop: spacing.lg }} />
    </SkeletonSurface>
  );
}
