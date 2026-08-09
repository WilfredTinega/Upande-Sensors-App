import React, { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  LinearGradient,
  Path,
  Stop,
  Text as SvgText,
} from 'react-native-svg';

import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';

// The deeper bottom inset is for the rotated time labels.
const PAD = { top: 14, right: 14, bottom: 58, left: 48 };

/** Round a domain out to human numbers so the axis reads 0/5/10, not 0/4.7/9.4. */
function niceScale(min, max, tickCount = 6) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };

  if (min === max) {
    const pad = Math.abs(min) > 1 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  }

  const rawStep = (max - min) / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  const step = (normalised >= 5 ? 10 : normalised >= 2 ? 5 : normalised >= 1 ? 2 : 1) * magnitude;

  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;

  const ticks = [];
  // Guard the loop with a hard count as well as the bound: floating-point
  // accumulation on tiny steps can otherwise stall just short of niceMax.
  for (let v = niceMin, i = 0; v <= niceMax + step / 2 && i <= tickCount + 2; v += step, i += 1) {
    ticks.push(Number(v.toFixed(10)));
  }
  return { min: niceMin, max: niceMax, ticks };
}

function formatTick(value) {
  const abs = Math.abs(value);
  if (abs >= 10000) return `${(value / 1000).toFixed(abs >= 100000 ? 0 : 1)}k`;
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  if (abs === 0) return '0';
  return value.toFixed(2).replace(/0$/, '');
}

/**
 * Time-series line chart, one or more series sharing an x-axis.
 *
 * **One y-axis, always.** Series with different units (temperature in °C beside
 * humidity in %) are plotted against the same scale rather than getting an axis
 * each. A second y-axis lets you slide two scales until any two lines appear to
 * track each other, which manufactures a correlation the data doesn't contain.
 * The legend carries each series' unit so the reader knows what they're seeing.
 *
 * Hover is not optional: on a phone the only way to read exact values off a
 * dense multi-series chart is to touch it, so the crosshair ships by default and
 * reports every series at the touched point.
 */
export function LineChart({
  labels = [],
  series = [],
  // Axis labels are abbreviated to fit; the tooltip has room for the full
  // timestamp and is where an exact reading is actually read off.
  tooltipLabels,
  height = 230,
  caption,
}) {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  const [activeIndex, setActiveIndex] = useState(null);

  // Categorical slots are assigned in fixed order and never cycled — a 9th
  // series would repeat a hue and two different measures would look like one.
  const resolved = useMemo(
    () =>
      series.slice(0, t.series.length).map((s, i) => ({
        ...s,
        color: s.color || t.series[i],
        numbers: (s.values || []).map((v) => (typeof v === 'number' ? v : Number.parseFloat(v))),
      })),
    [series, t.series],
  );

  const dropped = Math.max(0, series.length - t.series.length);

  const allFinite = useMemo(
    () => resolved.flatMap((s) => s.numbers.filter(Number.isFinite)),
    [resolved],
  );

  const scale = useMemo(() => {
    if (!allFinite.length) return niceScale(0, 1);
    return niceScale(Math.min(...allFinite), Math.max(...allFinite));
  }, [allFinite]);

  const plotW = Math.max(width - PAD.left - PAD.right, 1);
  const plotH = Math.max(height - PAD.top - PAD.bottom, 1);
  const count = labels.length;

  const xAt = (i) => PAD.left + (count <= 1 ? plotW / 2 : (i / (count - 1)) * plotW);
  const yAt = (v) => PAD.top + plotH - ((v - scale.min) / (scale.max - scale.min || 1)) * plotH;

  /**
   * Build one path per series. Gaps in the data break the line rather than
   * being bridged — a straight segment across a six-hour outage would read as
   * real, steady data.
   */
  const paths = useMemo(() => {
    if (!width || !count) return [];
    return resolved.map((s) => {
      let line = '';
      let open = false;
      for (let i = 0; i < count; i += 1) {
        const value = s.numbers[i];
        if (!Number.isFinite(value)) {
          open = false;
          continue;
        }
        const x = xAt(i);
        const y = yAt(value);
        if (!open) {
          line += `${line ? ' ' : ''}M ${x.toFixed(2)} ${y.toFixed(2)}`;
          open = true;
        } else {
          line += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
        }
      }
      return { ...s, d: line };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, width, height, count, scale.min, scale.max]);

  const pickIndex = (locationX) => {
    if (count <= 1) return count - 1;
    const ratio = (locationX - PAD.left) / plotW;
    return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
  };

  // The responder is created once, so it reads the picker through a ref that
  // always points at the current scale rather than closing over the first one.
  const pickIndexRef = useRef(pickIndex);
  pickIndexRef.current = pickIndex;

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => setActiveIndex(pickIndexRef.current(e.nativeEvent.locationX)),
      onPanResponderMove: (e) => setActiveIndex(pickIndexRef.current(e.nativeEvent.locationX)),
      onPanResponderRelease: () => setActiveIndex(null),
      onPanResponderTerminate: () => setActiveIndex(null),
    }),
  ).current;

  /**
   * Evenly spaced time labels, as many as the width allows.
   *
   * Rotated to -30°, a full `YYYY-MM-DD HH:MM` label occupies roughly 64px of
   * horizontal room rather than its full width, which is what lets more than
   * three fit. Still capped: a label per bucket would be a grey smear at 72
   * buckets.
   */
  const xLabelIndices = useMemo(() => {
    if (count <= 1) return [0];
    const maxLabels = Math.max(2, Math.min(8, Math.floor(plotW / 64)));
    if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
    const step = (count - 1) / (maxLabels - 1);
    return Array.from({ length: maxLabels }, (_, k) => Math.round(k * step));
  }, [count, plotW]);

  if (!allFinite.length) {
    return (
      <View style={{ height, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={[type.body, { color: t.textMuted }]}>No readings in this range.</Text>
      </View>
    );
  }

  const activeValues =
    activeIndex === null
      ? []
      : resolved
          .map((s) => ({ ...s, value: s.numbers[activeIndex] }))
          .filter((s) => Number.isFinite(s.value));

  const tooltipWidth = 186;
  const tooltipX =
    activeIndex === null
      ? 0
      : Math.max(
          PAD.left,
          Math.min(width - tooltipWidth - PAD.right, xAt(activeIndex) - tooltipWidth / 2),
        );


  // One axis serves every series, so it can only be labelled when they all
  // measure in the same unit. Mixed units (°C beside %) stay unlabelled — the
  // legend carries them per series, and stamping one unit on a shared axis
  // would mislabel the other line.
  const units = [...new Set(resolved.map((s) => s.unit).filter(Boolean))];
  const axisUnit = units.length === 1 && units[0] ? units[0] : '';

  return (
    <View>
      {caption ? (
        <Text style={[type.caption, { color: t.textSecondary, marginBottom: spacing.sm }]}>
          {caption}
        </Text>
      ) : null}


      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ height }}
        {...responder.panHandlers}
      >
        {width > 0 ? (
          <Svg width={width} height={height}>
            <Defs>
              <LinearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={resolved[0]?.color || t.series[0]} stopOpacity="0.18" />
                <Stop offset="1" stopColor={resolved[0]?.color || t.series[0]} stopOpacity="0.01" />
              </LinearGradient>
            </Defs>

            {/* Grid sits behind everything and stays recessive. */}
            <G>
              {scale.ticks.map((tick) => {
                const y = yAt(tick);
                return (
                  <G key={tick}>
                    <Line
                      x1={PAD.left}
                      y1={y}
                      x2={width - PAD.right}
                      y2={y}
                      stroke={t.grid}
                      strokeWidth={1}
                    />
                    <SvgText
                      x={PAD.left - 8}
                      y={y + 4}
                      fontSize="10"
                      fontFamily={font('500')}
                      fill={t.textMuted}
                      textAnchor="end"
                    >
                      {formatTick(tick)}
                    </SvgText>
                  </G>
                );
              })}
            </G>

            {axisUnit ? (
              <SvgText
                x={PAD.left - 8}
                y={PAD.top - 3}
                fontSize="10"
                fontFamily={font('600')}
                fill={t.textSecondary}
                textAnchor="end"
              >
                {axisUnit}
              </SvgText>
            ) : null}

            {xLabelIndices.map((i) => (
              <Line
                key={`vgrid-${i}`}
                x1={xAt(i)}
                y1={PAD.top}
                x2={xAt(i)}
                y2={PAD.top + plotH}
                stroke={t.grid}
                strokeWidth={1}
              />
            ))}

            {paths.map((s) => (
              <Path
                key={s.label}
                d={s.d}
                stroke={s.color}
                strokeWidth={2}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}

            {xLabelIndices.map((i) => {
              const x = xAt(i);
              const y = height - PAD.bottom + 15;
              return (
                <SvgText
                  key={`x-${i}`}
                  x={x}
                  y={y}
                  fontSize="9"
                  fontFamily={font('500')}
                  fill={t.textMuted}
                  // Anchored at the end and rotated up-left, so each label reads
                  // into the tick it belongs to rather than away from it.
                  textAnchor="end"
                  transform={`rotate(-30, ${x}, ${y})`}
                >
                  {labels[i]}
                </SvgText>
              );
            })}

            {activeValues.length ? (
              <G>
                <Line
                  x1={xAt(activeIndex)}
                  y1={PAD.top}
                  x2={xAt(activeIndex)}
                  y2={PAD.top + plotH}
                  stroke={t.borderStrong}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                {activeValues.map((s) => (
                  // Surface ring keeps each marker legible where lines cross.
                  <Circle
                    key={s.label}
                    cx={xAt(activeIndex)}
                    cy={yAt(s.value)}
                    r={5}
                    fill={s.color}
                    stroke={t.surface}
                    strokeWidth={2}
                  />
                ))}
              </G>
            ) : null}
          </Svg>
        ) : null}

        {activeValues.length ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: tooltipX,
              top: spacing.xs,
              width: tooltipWidth,
              backgroundColor: t.surface,
              borderRadius: radius.sm,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: t.borderStrong,
              paddingVertical: spacing.sm,
              paddingHorizontal: spacing.md,
              gap: 3,
            }}
          >
            <Text numberOfLines={1} style={[type.caption, { color: t.textSecondary }]}>
              {(tooltipLabels || labels)[activeIndex]}
            </Text>
            {activeValues.map((s) => (
              <View key={s.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View
                  style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: s.color }}
                />
                <Text style={[type.caption, { color: t.textSecondary, flex: 1 }]} numberOfLines={1}>
                  {s.label}
                </Text>
                <Text
                  style={[
                    type.caption,
                    { color: t.textPrimary, fontWeight: '700', fontFamily: font('700'), fontVariant: ['tabular-nums'] },
                  ]}
                >
                  {formatTick(s.value)}
                  {s.unit ? ` ${s.unit}` : ''}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

    </View>
  );
}

/**
 * Compact horizontal bars for ranked magnitudes (runtime per day, readings per
 * sensor). Sequential ramp, because the encoding is magnitude, not identity.
 */
export function BarList({ items = [], unit = '', maxValue }) {
  const t = useTheme();
  const max = maxValue ?? Math.max(...items.map((i) => Number(i.value) || 0), 1);

  return (
    <View style={{ gap: spacing.sm }}>
      {items.map((item, i) => {
        const value = Number(item.value) || 0;
        const ratio = max > 0 ? value / max : 0;
        return (
          <View key={`${item.label}-${i}`} style={{ gap: 4 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text numberOfLines={1} style={[type.caption, { color: t.textSecondary, flex: 1 }]}>
                {item.label}
              </Text>
              <Text style={[type.caption, { color: t.textPrimary, fontWeight: '600', fontFamily: font('600') }]}>
                {/* Counts are whole things — "12.0 sign-ins" reads as a
                    measurement. Only fractional values get decimal places. */}
                {Number.isInteger(value) ? value.toLocaleString() : formatTick(value)}
                {unit ? ` ${unit}` : ''}
              </Text>
            </View>
            <View
              style={{
                height: 8,
                borderRadius: 4,
                backgroundColor: t.surfaceSunken,
                overflow: 'hidden',
              }}
            >
              <View
                style={{
                  width: `${Math.max(ratio * 100, value > 0 ? 2 : 0)}%`,
                  height: '100%',
                  borderRadius: 4,
                  backgroundColor: t.sequential[3],
                }}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

export { formatTick };
