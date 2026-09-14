import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Image,
  Modal,
  PanResponder,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useIsFocused } from '@react-navigation/native';

import { Card, EmptyState, ErrorView, StatusChip } from '../components/ui';
import { Skeleton } from '../components/Skeleton';
import { formatTick } from '../components/LineChart';
import { TTL_LIVE, cacheKey, invalidate } from '../api/cache';
import { client } from '../api/client';
import { getFloorPlans } from '../api/endpoints';
import { useDashboard } from '../context/DashboardContext';
import { useQuery } from '../hooks/useQuery';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';
import { ageInMinutes, formatDuration, fullTimestamp, relativeTime } from '../utils/dates';

/**
 * The Floor Plan tab: the site's blueprint with live sensor pins and fixture
 * markers on it, as the web portal's FlowPlanBoard draws it — read-only.
 *
 * The rules are copied from the web components rather than reinvented, so a
 * pin that is red on the wall screen is red on the phone:
 *
 *  - SensorPin.vue: a pin shows only Temperature and Humidity (falling back to
 *    whatever the sensor does report), RED when any parameter is outside its
 *    `utr`/`ltr`, GREEN when it has a value and its newest reading is within
 *    20 minutes, otherwise STALE; and "No readings" with no value at all.
 *  - MarkerPin.vue: a fixture icon in its own colour (default #1f2937), at
 *    `size_px` clamped 12–160 (default 26), rotated by `rotation`; a marker
 *    linked to a door sensor is coloured by the door's state — red open, green
 *    closed — with the state word under it.
 *
 * Pinch-zoom and pan are done with `PanResponder` + `Animated`: the app has no
 * gesture-handler native module and a patch release cannot add one. Pins and
 * markers are counter-scaled so they keep their pixel size while the plan
 * zooms, exactly as the web's `scale(1 / scale)` does.
 *
 * ── Read-only, deliberately ──────────────────────────────────────────────────
 *
 * Laying a plan out belongs on the website: there is no New plan, no rename or
 * delete, no blueprint upload, no dragging a pin or a marker, no icon palette
 * and no resize handle here, and nothing in this app calls `save_placements`,
 * `save_markers`, `set_blueprint`, `create_flow_plan`, `rename_flow_plan`,
 * `delete_flow_plan` or `reorder_flow_plans`. The payload carries `can_edit`
 * and it is deliberately ignored — a phone is where a plan is READ, and a pin
 * nudged by a thumb on a bus is a plan quietly made wrong for everybody.
 *
 * The plan chips are not an exception: choosing which plan to look at is
 * reading. Nothing they do changes a stored order.
 */

/** The tab key the website gives its floor plan dashboard. */
export const FLOOR_PLAN_SLUG = 'floor-plan';

/** SensorPin.vue: a reading inside this window is "fresh". */
const FRESH_WINDOW_MINUTES = 20;
/** The plan is re-read this often while the tab is on screen. */
const POLL_MS = 60 * 1000;
/** Door totals are summed over this window, as the web board's default. */
const DOOR_HOURS = 24;

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const DOUBLE_TAP_MS = 300;
/** A press that moved less than this is a tap, not a pan. */
const TAP_SLOP = 8;

/** flowIcons.js: glyph size bounds. */
const MARKER_SIZE_DEFAULT = 26;
const MARKER_SIZE_MIN = 12;
const MARKER_SIZE_MAX = 160;
const DEFAULT_MARKER_COLOR = '#1f2937';
/** MarkerPin.vue: a linked door's ink follows its state, whatever was picked. */
const DOOR_OPEN_COLOR = '#e5484d';
const DOOR_CLOSED_COLOR = '#30a46c';

/**
 * lucide key → Ionicon. `door`/`door-closed` swing with the sensor's state; the
 * rest are fixed. An unknown key (an icon removed from the web set) still
 * renders, as a generic pin, so nothing placed on a plan ever vanishes.
 */
const MARKER_ICONS = {
  door: { label: 'Door', states: { open: 'exit-outline', closed: 'lock-closed-outline' }, defaultState: 'open' },
  'door-closed': { label: 'Closed door', states: { open: 'exit-outline', closed: 'lock-closed-outline' }, defaultState: 'closed' },
  window: { label: 'Window', icon: 'grid-outline' },
  gate: { label: 'Gate', icon: 'reorder-four-outline' },
  exit: { label: 'Exit', icon: 'log-out-outline' },
  arrow: { label: 'Arrow', icon: 'arrow-up-outline' },
  fan: { label: 'Fan', icon: 'aperture-outline' },
  vent: { label: 'Air vent', icon: 'swap-vertical-outline' },
  heater: { label: 'Heater', icon: 'flame-outline' },
  cooling: { label: 'Cooling unit', icon: 'snow-outline' },
  'cold-room': { label: 'Cold room', icon: 'cube-outline' },
  pump: { label: 'Pump', icon: 'water-outline' },
  tank: { label: 'Tank', icon: 'beaker-outline' },
  valve: { label: 'Valve', icon: 'speedometer-outline' },
  tap: { label: 'Tap', icon: 'water-outline' },
  power: { label: 'Power', icon: 'flash-outline' },
  socket: { label: 'Socket', icon: 'flash-outline' },
  light: { label: 'Light', icon: 'bulb-outline' },
  camera: { label: 'Camera', icon: 'videocam-outline' },
  extinguisher: { label: 'Fire extinguisher', icon: 'bonfire-outline' },
  warning: { label: 'Hazard', icon: 'warning-outline' },
  truck: { label: 'Loading bay', icon: 'bus-outline' },
  gateway: { label: 'Gateway', icon: 'git-network-outline' },
  wifi: { label: 'Wi-Fi', icon: 'wifi-outline' },
  plant: { label: 'Crop', icon: 'leaf-outline' },
  toilet: { label: 'Toilet', icon: 'man-outline' },
  storage: { label: 'Storage', icon: 'archive-outline' },
  machine: { label: 'Machine', icon: 'cog-outline' },
};

function markerDef(key) {
  return MARKER_ICONS[key] || { label: key || 'Marker', icon: 'location-outline' };
}

function markerGlyph(def, state) {
  if (def.states) return def.states[state] || def.states[def.defaultState] || 'location-outline';
  return def.icon;
}

function markerSize(marker) {
  const n = Number(marker?.size_px);
  if (!n || Number.isNaN(n)) return MARKER_SIZE_DEFAULT;
  return Math.max(MARKER_SIZE_MIN, Math.min(MARKER_SIZE_MAX, Math.round(n)));
}

/* ── Reading rules (SensorPin.vue) ───────────────────────────────────────── */

/** SensorPin.vue: a pin shows only these; other measures stay on the card. */
const SHOWN_TYPES = new Set(['temperature', 'humidity']);
/** Fixed order — Temperature, then Humidity, then the rest. */
const PARAM_RANK = { temperature: 0, humidity: 1 };
const paramRank = (p) => PARAM_RANK[String(p?.type || '').toLowerCase()] ?? 9;

/** Units when the reading carries none, so a value never renders bare. */
const TYPE_UNITS = { temperature: '°C', humidity: '%', ec: 'mS/cm', co2: 'ppm' };

function unitOf(param, unitForType) {
  if (param.uom) return param.uom;
  const key = String(param.type || '').toLowerCase();
  return TYPE_UNITS[key] || unitForType?.(param.type) || '';
}

function fmtValue(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return formatTick(Math.round(n * 10) / 10);
}

function hasValue(p) {
  return p && p.value !== null && p.value !== undefined && p.value !== '';
}

function paramOutOfRange(p) {
  if (!hasValue(p)) return false;
  const v = Number(p.value);
  if (Number.isNaN(v)) return false;
  if (p.utr !== null && p.utr !== undefined && v > Number(p.utr)) return true;
  if (p.ltr !== null && p.ltr !== undefined && v < Number(p.ltr)) return true;
  return false;
}

/** Every parameter of a reading, sorted; the legacy single value as one param. */
function allParams(reading) {
  const list = Array.isArray(reading?.params) ? reading.params : [];
  if (list.length) return [...list].sort((a, b) => paramRank(a) - paramRank(b));
  if (!reading) return [];
  return [{ type: '', value: reading.value ?? null, uom: reading.uom || '', ts: reading.ts, utr: reading.utr ?? null, ltr: reading.ltr ?? null }];
}

/** The parameters a pin shows: temp + humidity, else whatever it reports. */
function pinParams(reading) {
  const all = allParams(reading);
  const shown = all.filter((p) => SHOWN_TYPES.has(String(p.type || '').toLowerCase()));
  return shown.length ? shown : all;
}

/**
 * The status the colour carries, as a word — which is also what a red/green
 * blind reader relies on. Age is measured with the app's server-offset-aware
 * parser rather than the web's local-time one, so a phone in a different zone
 * from the site still agrees with the wall screen.
 */
function readingStatus(reading) {
  const params = allParams(reading);
  const any = params.some(hasValue);
  if (!any) return 'none';
  if (params.some(paramOutOfRange)) return 'alarm';
  let newest = null;
  [reading?.ts, ...params.map((p) => p?.ts)].forEach((ts) => {
    const age = ageInMinutes(ts);
    if (age !== null && (newest === null || age < newest)) newest = age;
  });
  return newest !== null && newest <= FRESH_WINDOW_MINUTES ? 'fresh' : 'stale';
}

const STATUS_WORD = { none: 'No readings', alarm: 'Out of range', fresh: 'Active', stale: 'Stale' };

function statusColour(status, t) {
  if (status === 'alarm') return t.status.critical;
  if (status === 'fresh') return t.status.good;
  if (status === 'stale') return t.status.warning;
  return t.textMuted;
}

/* ── Anchored, counter-scaled overlay ────────────────────────────────────── */

/**
 * Places its child with its CENTRE at (x%, y%) of the stage and holds it at a
 * fixed pixel size while the stage zooms.
 *
 * The transform order matches SensorPin.vue's `translate(-50%, -50%)
 * scale(1/scale)`: scale about the element's own centre first, then shift by
 * half its unscaled size so that centre lands on the anchor. The size comes
 * from `onLayout`, since a pin's width is whatever its text needs.
 */
function Anchored({ x, y, inverseScale, zIndex = 2, children }) {
  const [size, setSize] = useState(null);
  return (
    <Animated.View
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (!size || size.w !== width || size.h !== height) setSize({ w: width, h: height });
      }}
      style={{
        position: 'absolute',
        left: `${Number(x) || 0}%`,
        top: `${Number(y) || 0}%`,
        zIndex,
        // Invisible until measured, so it never paints at the wrong offset for
        // a frame.
        opacity: size ? 1 : 0,
        transform: [
          { translateX: -(size?.w || 0) / 2 },
          { translateY: -(size?.h || 0) / 2 },
          { scale: inverseScale },
        ],
      }}
    >
      {children}
    </Animated.View>
  );
}

/* ── Pins and markers ────────────────────────────────────────────────────── */

function SensorPin({ placement, reading, unitForType, onPress }) {
  const t = useTheme();
  const status = readingStatus(reading);
  const colour = statusColour(status, t);
  const params = pinParams(reading);
  const line = params.some(hasValue)
    ? params
        .map((p) => `${fmtValue(p.value)}${hasValue(p) ? unitOf(p, unitForType) : ''}`)
        .join(' · ')
    : 'No readings';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${placement.label || placement.sensor_name}: ${line}. ${STATUS_WORD[status]}`}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        // A chip rather than the web's bare haloed text: a phone has no hover
        // card, so the value must be legible on its own over any blueprint.
        backgroundColor: t.mode === 'dark' ? 'rgba(20,20,19,0.92)' : 'rgba(255,255,255,0.94)',
        borderColor: colour,
        borderWidth: 1.5,
        borderRadius: radius.md,
        paddingHorizontal: 7,
        paddingVertical: 3,
        alignItems: 'center',
        opacity: pressed ? 0.7 : 1,
        elevation: 2,
        shadowColor: '#000',
        shadowOpacity: 0.15,
        shadowRadius: 3,
        shadowOffset: { width: 0, height: 1 },
      })}
    >
      <Text numberOfLines={1} style={{ fontSize: 9, color: t.textSecondary, fontFamily: font('600'), maxWidth: 120 }}>
        {placement.label || placement.sensor_name}
      </Text>
      <Text numberOfLines={1} style={{ fontSize: 12, color: colour, fontFamily: font('700') }}>
        {line}
      </Text>
    </Pressable>
  );
}

function MarkerPin({ marker, doorState, onPress }) {
  const def = markerDef(marker.icon);
  const linked = Boolean(marker.sensor_name);
  const state = linked ? doorState?.state || '' : '';
  const glyph = markerGlyph(def, state);
  const px = markerSize(marker);
  const colour =
    linked && state === 'open'
      ? DOOR_OPEN_COLOR
      : linked && state === 'closed'
        ? DOOR_CLOSED_COLOR
        : marker.color || DEFAULT_MARKER_COLOR;
  // MarkerPin.vue: caption scales gently with the glyph.
  const fontPx = Math.max(9, Math.min(16, Math.round(px * 0.4)));
  const stateLabel = !linked ? '' : state === 'open' ? 'OPEN' : state === 'closed' ? 'CLOSED' : 'NO DATA';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${marker.label || def.label}${stateLabel ? `, ${stateLabel.toLowerCase()}` : ''}`}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({ alignItems: 'center', opacity: pressed ? 0.7 : 1 })}
    >
      <View style={{ transform: [{ rotate: `${Number(marker.rotation || 0) % 360}deg` }] }}>
        <Ionicons name={glyph} size={px} color={colour} />
      </View>
      {marker.label ? (
        <Text
          numberOfLines={1}
          style={{
            fontSize: fontPx,
            color: colour,
            fontFamily: font('700'),
            maxWidth: 160,
            // The web's white text-shadow halo, so a caption survives line-art.
            textShadowColor: '#fff',
            textShadowRadius: 3,
          }}
        >
          {marker.label}
        </Text>
      ) : null}
      {stateLabel ? (
        <Text
          style={{
            fontSize: Math.max(8, fontPx - 1),
            color: colour,
            fontFamily: font('700'),
            letterSpacing: 0.6,
            textShadowColor: '#fff',
            textShadowRadius: 3,
          }}
        >
          {stateLabel}
        </Text>
      ) : null}
    </Pressable>
  );
}

/* ── Detail sheet ────────────────────────────────────────────────────────── */

function SheetRow({ label, value, colour }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.lg, paddingVertical: 6 }}>
      <Text style={[type.body, { color: t.textSecondary }]}>{label}</Text>
      <Text style={[type.body, { color: colour || t.textPrimary, fontFamily: font('600'), flexShrink: 1, textAlign: 'right' }]}>
        {value ?? '—'}
      </Text>
    </View>
  );
}

/**
 * What the web shows on hover, on tap: a bottom sheet. One component for both
 * kinds of thing on the plan — `selection` is `{ kind: 'sensor', placement,
 * reading }` or `{ kind: 'marker', marker, doorState }`.
 */
function DetailSheet({ selection, unitForType, onClose }) {
  const t = useTheme();
  if (!selection) return null;

  let title;
  let subtitle;
  let body;

  if (selection.kind === 'sensor') {
    const { placement, reading } = selection;
    const status = readingStatus(reading);
    const params = allParams(reading);
    title = placement.label || placement.sensor_name;
    subtitle = placement.label ? placement.sensor_name : placement.sensor_type || '';
    body = (
      <>
        <StatusChip
          tone={status === 'fresh' ? 'good' : status === 'alarm' ? 'critical' : status === 'stale' ? 'warning' : 'serious'}
          label={STATUS_WORD[status]}
          style={{ marginBottom: spacing.sm }}
        />
        {params.length ? (
          params.map((p, i) => (
            <SheetRow
              key={`${p.type || 'value'}-${i}`}
              label={p.type ? String(p.type).replace(/\b\w/g, (c) => c.toUpperCase()) : 'Value'}
              value={
                hasValue(p)
                  ? `${fmtValue(p.value)}${unitOf(p, unitForType) ? ` ${unitOf(p, unitForType)}` : ''}${
                      p.ts ? `  ·  ${relativeTime(p.ts) || fullTimestamp(p.ts)}` : ''
                    }`
                  : '—'
              }
              colour={paramOutOfRange(p) ? t.status.critical : undefined}
            />
          ))
        ) : (
          <Text style={[type.body, { color: t.textMuted }]}>No readings for this sensor yet.</Text>
        )}
      </>
    );
  } else {
    const { marker, doorState } = selection;
    const def = markerDef(marker.icon);
    const linked = Boolean(marker.sensor_name);
    const state = doorState?.state || '';
    title = marker.label || def.label;
    subtitle = marker.label ? def.label : '';
    body = linked ? (
      <>
        <SheetRow label="Sensor" value={marker.sensor_name} />
        <SheetRow
          label="Status"
          value={state === 'open' ? 'Open' : state === 'closed' ? 'Closed' : 'No data'}
          colour={state === 'open' ? DOOR_OPEN_COLOR : state === 'closed' ? DOOR_CLOSED_COLOR : t.textMuted}
        />
        {doorState ? (
          <>
            {doorState.since ? <SheetRow label="Since" value={fullTimestamp(doorState.since)} /> : null}
            <SheetRow label="Open" value={formatDuration(doorState.open_seconds)} colour={DOOR_OPEN_COLOR} />
            <SheetRow label="Closed" value={formatDuration(doorState.closed_seconds)} colour={DOOR_CLOSED_COLOR} />
            <SheetRow label="Openings" value={String(doorState.openings ?? 0)} />
            <SheetRow label="Longest open" value={formatDuration(doorState.longest_open_seconds)} />
            <Text style={[type.caption, { color: t.textMuted, marginTop: spacing.sm }]}>Last {DOOR_HOURS}h</Text>
          </>
        ) : (
          <Text style={[type.caption, { color: t.textMuted, marginTop: spacing.sm }]}>No readings yet</Text>
        )}
      </>
    ) : (
      <Text style={[type.body, { color: t.textMuted }]}>A fixture on the plan. It carries no reading.</Text>
    );
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: '#00000080', justifyContent: 'flex-end' }}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: t.background,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            padding: spacing.lg,
            paddingBottom: spacing.xxl,
          }}
        >
          <View style={{ alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: t.borderStrong, marginBottom: spacing.md }} />
          <Text numberOfLines={2} style={[type.heading, { color: t.textPrimary }]}>{title}</Text>
          {subtitle ? <Text numberOfLines={1} style={[type.caption, { color: t.textMuted, marginBottom: spacing.sm }]}>{subtitle}</Text> : null}
          {body}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/* ── The zoomable stage ──────────────────────────────────────────────────── */

const distance = (touches) => {
  if (touches.length < 2) return 0;
  const [a, b] = touches;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
};

/**
 * The blueprint at its aspect ratio, with pins and markers over it, inside a
 * pan + pinch container.
 *
 * Fit to HEIGHT, not width: a plan is read top-to-bottom, and the old
 * fit-to-width rule shrank a tall or wide blueprint further still to keep it
 * inside a short height cap, which is exactly backwards for reading it. The
 * full height is used instead (0.85 of the window, a rough allowance for the
 * header/tab bar/chips/caption around it — the same kind of fraction-of-window
 * heuristic the old cap used, just sized to fill rather than to shrink); width
 * follows the image's own ratio and can run past the screen, which is what the
 * horizontal `ScrollView` below is for.
 *
 * `Animated.Value`s for scale and offset, driven straight from the responder so
 * nothing re-renders mid-gesture; the pins read `inverseScale` from the same
 * values. Panning only claims the gesture once zoomed in (or with two fingers);
 * at 1× a single-finger drag is left to the surrounding `ScrollView`s — the
 * outer one vertically, this stage's own one horizontally.
 */
function BlueprintStage({ uri, headers, imageSize, placements, markers, readings, doorStates, unitForType, onSelect }) {
  const t = useTheme();
  const { height: windowHeight } = useWindowDimensions();

  const fitted = useMemo(() => {
    if (!imageSize?.width || !imageSize?.height) return null;
    const h = Math.max(240, Math.round(windowHeight * 0.85));
    const w = Math.round((h * imageSize.width) / imageSize.height);
    return { width: w, height: h };
  }, [imageSize, windowHeight]);

  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const inverseScale = useMemo(() => Animated.divide(1, scale), [scale]);

  /** Plain-number mirrors of the animated values, for the gesture maths. */
  const current = useRef({ scale: 1, x: 0, y: 0 });
  const gestureStart = useRef({ scale: 1, x: 0, y: 0, dist: 0 });
  const lastTapAt = useRef(0);
  const fittedRef = useRef(fitted);
  fittedRef.current = fitted;

  const apply = useCallback(
    (next) => {
      const f = fittedRef.current;
      const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next.scale));
      // The image may not leave its box: at scale s the overhang on each side
      // is (s − 1) · size / 2, which is as far as it can be dragged.
      const maxX = f ? ((s - 1) * f.width) / 2 : 0;
      const maxY = f ? ((s - 1) * f.height) / 2 : 0;
      const x = Math.max(-maxX, Math.min(maxX, next.x));
      const y = Math.max(-maxY, Math.min(maxY, next.y));
      current.current = { scale: s, x, y };
      scale.setValue(s);
      translateX.setValue(x);
      translateY.setValue(y);
    },
    [scale, translateX, translateY],
  );

  const reset = useCallback(() => {
    current.current = { scale: 1, x: 0, y: 0 };
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
    ]).start();
  }, [scale, translateX, translateY]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Never on touch-down: a tap must reach the pin underneath.
        onStartShouldSetPanResponder: () => false,
        // Claim a drag only when there is something to pan (zoomed in) or a
        // second finger is down; otherwise the page scrolls as usual.
        onMoveShouldSetPanResponder: (e, g) =>
          g.numberActiveTouches >= 2 || (current.current.scale > 1 && (Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2)),
        // Once ours, the scroll view may not take it back mid-gesture.
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          gestureStart.current = { ...current.current, dist: distance(e.nativeEvent.touches) };
        },
        onPanResponderMove: (e, g) => {
          const touches = e.nativeEvent.touches;
          const start = gestureStart.current;
          if (touches.length >= 2) {
            const d = distance(touches);
            if (!start.dist) {
              gestureStart.current = { ...current.current, dist: d };
              return;
            }
            const s = start.scale * (d / start.dist);
            // Keep the same point under the fingers as the scale changes:
            // the offset grows in proportion to the scale.
            const ratio = s / start.scale;
            apply({ scale: s, x: start.x * ratio, y: start.y * ratio });
            return;
          }
          // One finger, and the pinch (if any) is over: pan from where it left.
          if (start.dist) gestureStart.current = { ...current.current, dist: 0 };
          apply({ scale: current.current.scale, x: gestureStart.current.x + g.dx, y: gestureStart.current.y + g.dy });
        },
        onPanResponderRelease: (e, g) => {
          // A double tap on the plan itself resets the view.
          const moved = Math.abs(g.dx) > TAP_SLOP || Math.abs(g.dy) > TAP_SLOP;
          const now = Date.now();
          if (!moved && now - lastTapAt.current < DOUBLE_TAP_MS) {
            lastTapAt.current = 0;
            reset();
            return;
          }
          lastTapAt.current = moved ? 0 : now;
        },
      }),
    [apply, reset],
  );

  // Double tap on the un-zoomed plan: the responder never claims a tap, so
  // detect it on the stage's own press handler too.
  const onStagePress = useCallback(() => {
    const now = Date.now();
    if (now - lastTapAt.current < DOUBLE_TAP_MS) {
      lastTapAt.current = 0;
      reset();
      return;
    }
    lastTapAt.current = now;
  }, [reset]);

  return (
    <View
      style={{
        width: '100%',
        overflow: 'hidden',
        borderRadius: radius.md,
        backgroundColor: t.surfaceSunken,
        height: fitted ? fitted.height : 240,
      }}
    >
      {fitted ? (
        // Horizontal only: the page's own ScrollView already covers vertical,
        // and the stage is exactly `fitted.height` tall, so there is nothing
        // to scroll in that direction here. A plan narrower than the screen is
        // centred rather than pinned to the left edge.
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ minWidth: '100%', justifyContent: 'center' }}
          style={{ height: fitted.height }}
        >
          <Animated.View
            style={{
              width: fitted.width,
              height: fitted.height,
              transform: [{ translateX }, { translateY }, { scale }],
            }}
            {...responder.panHandlers}
          >
            <Pressable onPress={onStagePress} style={StyleSheet.absoluteFill}>
              <Image
                source={{ uri, headers }}
                style={{ width: fitted.width, height: fitted.height }}
                resizeMode="contain"
                accessibilityLabel="Floor plan blueprint"
              />
            </Pressable>
            {/* Markers under the pins, as on the web: pins carry live values. */}
            {(markers || []).map((m, i) => (
              <Anchored key={`m-${m.name || i}`} x={m.pos_x} y={m.pos_y} inverseScale={inverseScale} zIndex={2}>
                <MarkerPin
                  marker={m}
                  doorState={m.sensor_name ? doorStates?.[m.sensor_name] : null}
                  onPress={() => onSelect({ kind: 'marker', marker: m, doorState: m.sensor_name ? doorStates?.[m.sensor_name] : null })}
                />
              </Anchored>
            ))}
            {(placements || []).map((p, i) => (
              <Anchored key={`p-${p.sensor_name || i}`} x={p.pos_x} y={p.pos_y} inverseScale={inverseScale} zIndex={3}>
                <SensorPin
                  placement={p}
                  reading={readings?.[p.sensor_name]}
                  unitForType={unitForType}
                  onPress={() => onSelect({ kind: 'sensor', placement: p, reading: readings?.[p.sensor_name] })}
                />
              </Anchored>
            ))}
          </Animated.View>
        </ScrollView>
      ) : (
        <Skeleton height={240} radius={radius.md} />
      )}
    </View>
  );
}

/* ── Screen ──────────────────────────────────────────────────────────────── */

/** The plan the user last looked at, per site, so a tab switch keeps it. */
const rememberedPlan = new Map();

export function FloorPlanScreen() {
  const t = useTheme();
  const isFocused = useIsFocused();
  const { site, sitePending, sitesLoading, unitForType } = useDashboard();

  const [planName, setPlanName] = useState(() => (site ? rememberedPlan.get(site) || null : null));
  const [selection, setSelection] = useState(null);
  const [imageSize, setImageSize] = useState(null);

  // A new site has its own plans; the previous pick means nothing there.
  useEffect(() => {
    setPlanName(site ? rememberedPlan.get(site) || null : null);
  }, [site]);

  // Gated on `sitePending`, not `site`: `site === null` once settled means
  // "All sites" — the endpoint already answers that with the first plan it
  // can find across every permitted site, which is what "no site chosen"
  // behaved like before "All sites" was reachable from the picker at all.
  const key = sitePending ? null : cacheKey('floor_plan', { site, plan: planName || '' });
  const query = useQuery(key, () => getFloorPlans({ site, plan: planName, doorHours: DOOR_HOURS }), {
    ttl: TTL_LIVE,
    // Live values on a wall plan go stale in a minute; off-screen they are not
    // worth the request, so the poll follows focus.
    pollMs: isFocused ? POLL_MS : 0,
  });


  const data = query.data;
  const plans = useMemo(() => (Array.isArray(data?.plans) ? data.plans : []), [data]);
  const plan = data?.plan || null;

  /**
   * A Frappe `Attach` field holds a site-relative path — "/files/plan.png" —
   * and `Image` has no base to resolve that against, so the request would go
   * nowhere and the plan would simply never appear. Joined to the instance the
   * session belongs to, and left alone when the server already sent an absolute
   * URL (a site serving files from S3 does), which is the same rule the account
   * avatar uses.
   */
  const raw = String(plan?.blueprint || '').trim();
  const blueprint = !raw || /^https?:\/\//i.test(raw) ? raw : `${client.baseUrl}${raw}`;

  // The session cookie travels with the image request: blueprints are private
  // Frappe files, and an unauthenticated fetch is answered with the login page.
  // Read per render — the client rotates the sid on re-login, and the value
  // from an earlier render would fetch as nobody.
  const sid = client.sid;
  const headers = useMemo(() => (sid ? { Cookie: `sid=${sid}` } : undefined), [sid]);

  // The image's natural size, for the aspect ratio. Fetched with the same
  // cookie: `getSize` alone would be refused for a private file.
  useEffect(() => {
    if (!blueprint) {
      setImageSize(null);
      return undefined;
    }
    let cancelled = false;
    const ok = (width, height) => {
      if (!cancelled && width && height) setImageSize({ width, height });
    };
    const fail = () => {
      // Unknown ratio: draw it 4:3 rather than not at all.
      if (!cancelled) setImageSize({ width: 4, height: 3 });
    };
    try {
      if (typeof Image.getSizeWithHeaders === 'function') {
        const maybe = Image.getSizeWithHeaders(blueprint, headers || {}, ok, fail);
        if (maybe && typeof maybe.then === 'function') maybe.then((s) => ok(s?.width, s?.height), fail);
      } else {
        Image.getSize(blueprint, ok, fail);
      }
    } catch {
      fail();
    }
    return () => {
      cancelled = true;
    };
  }, [blueprint, headers]);

  const pickPlan = useCallback(
    (name) => {
      setPlanName(name);
      if (site) rememberedPlan.set(site, name);
    },
    [site],
  );

  const refresh = useCallback(() => {
    if (key) invalidate(key);
    return query.refresh();
  }, [key, query]);

  const showSkeleton = sitePending || sitesLoading || query.loading;
  const unsupported = Boolean(query.error?.isMissingEndpoint);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={<RefreshControl refreshing={query.refreshing} onRefresh={refresh} tintColor={t.accent} colors={[t.accent]} />}
    >
      {/* One chip per plan, only when there is a choice to make. */}
      {!showSkeleton && plans.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.md }}>
          {plans.map((p) => {
            const active = plan ? p.name === plan.name : false;
            return (
              <Pressable
                key={p.name}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => pickPlan(p.name)}
                style={({ pressed }) => ({
                  paddingVertical: 7,
                  paddingHorizontal: spacing.md,
                  borderRadius: radius.pill,
                  borderWidth: 1,
                  borderColor: active ? t.accent : t.borderStrong,
                  backgroundColor: active ? t.accent : t.surface,
                  opacity: pressed ? 0.75 : 1,
                })}
              >
                <Text style={[type.caption, { color: active ? t.onAccent : t.textSecondary, fontFamily: font('600') }]}>
                  {p.plan_name || p.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {showSkeleton ? (
        <>
          <Skeleton height={32} radius={radius.pill} width="60%" style={{ marginBottom: spacing.md }} />
          <Skeleton height={280} radius={radius.md} />
        </>
      ) : unsupported ? (
        <EmptyState
          title="Floor plans need a newer server"
          message="This site's Upande Sensors app does not serve floor plans to the phone yet."
        />
      ) : query.error ? (
        <ErrorView error={query.error} onRetry={refresh} />
      ) : !plans.length || !plan ? (
        <EmptyState
          title="No floor plans for this site"
          message={`Nothing has been drawn for ${site || 'this site'} yet.`}
        />
      ) : !blueprint ? (
        <EmptyState title="This plan has no blueprint yet — add one on the website" message={plan.plan_name || plan.name} />
      ) : (
        <>
          <Card padded={false} style={{ marginBottom: spacing.md }}>
            <BlueprintStage
              uri={blueprint}
              headers={headers}
              imageSize={imageSize}
              placements={plan.placements}
              markers={plan.markers}
              readings={data?.readings}
              doorStates={data?.door_states}
              unitForType={unitForType}
              onSelect={setSelection}
            />
          </Card>
          <Text style={[type.caption, { color: t.textMuted, textAlign: 'center' }]}>
            Swipe to scroll · pinch to zoom · double-tap to reset · tap a pin for details
          </Text>
        </>
      )}

      <DetailSheet selection={selection} unitForType={unitForType} onClose={() => setSelection(null)} />
    </ScrollView>
  );
}
