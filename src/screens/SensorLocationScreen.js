import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Device from 'expo-device';
import * as Location from 'expo-location';
import Svg, { Circle } from 'react-native-svg';

import { ConfirmDialog } from '../components/ConfirmDialog';
import { Button, Card, EmptyState, ErrorView, SectionTitle, SelectField, StatusChip } from '../components/ui';
import { Skeleton } from '../components/Skeleton';
import { TTL_REFERENCE, TTL_SERIES, cacheKey, invalidate } from '../api/cache';
import { getSensorLocationHistory, getSensorsForLocation, setSensorLocation } from '../api/endpoints';
import { useDashboard } from '../context/DashboardContext';
import { useQuery } from '../hooks/useQuery';
import { goToSensorMap } from '../navigation/ref';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { relativeTime, shortTimestamp } from '../utils/dates';
import {
  ACCURACY_FULL_M,
  ACCURACY_ZERO_M,
  SCAN_SECONDS,
  accuracyPercent,
  formatCoordinates,
  formatMetres,
  haversineMetres,
  weightedPosition,
} from '../utils/geo';

/**
 * Set a sensor's coordinates from the phone standing next to it.
 *
 * The workflow this replaces: an installer reads the coordinates off a GPS
 * app, types them into the Sensor form on the desk later, and transposes a
 * digit. Here the phone watches its own GPS for up to thirty seconds, shows
 * how sharp the fix is getting, averages the fixes with the sharp ones
 * counting for more, and writes the result — with its accuracy and how many
 * fixes it came from — while the installer is still standing at the sensor.
 *
 * A hidden tab, like Sensor detail: reached from Home's quick links, from a
 * sensor's detail screen, or from the map's empty state, never from the tab
 * bar. The header's site filter scopes the picker.
 *
 * Satellite count is NOT shown. Expo's location API reports position and
 * accuracy but not how many satellites are in view — that is Android's
 * `GnssStatus`, which needs a native module this project does not have. The
 * accuracy in metres is the number that matters to the fix anyway, and the
 * screen shows that rather than inventing one it cannot read.
 */

const EMPTY_ROWS = [];
const SCAN_TICK_MS = 250;

/* ── GPS scan ────────────────────────────────────────────────────────────── */

/**
 * Permission, then a position watch for `SCAN_SECONDS` or until stopped,
 * collecting every fix.
 *
 * `watchPositionAsync` rather than one `getCurrentPositionAsync`: a single
 * fix is whatever the receiver had at that instant, which is the cold-start
 * value — often ±30 m — and it sharpens over the next seconds as more
 * satellites lock. Watching lets the screen show that happening and average
 * across it.
 *
 * `status`: idle → requesting → scanning → done, or denied / error.
 */
function useGpsScan() {
  const [status, setStatus] = useState('idle');
  const [fixes, setFixes] = useState([]);
  const [elapsed, setElapsed] = useState(0);
  const [problem, setProblem] = useState(null);
  const [canAskAgain, setCanAskAgain] = useState(true);

  const subscriptionRef = useRef(null);
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);

  const stop = useCallback(() => {
    subscriptionRef.current?.remove?.();
    subscriptionRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    // Only a scan that was running becomes "done"; a denied or failed one keeps
    // saying why.
    setStatus((s) => (s === 'scanning' ? 'done' : s));
  }, []);

  const start = useCallback(async () => {
    stop();
    setFixes([]);
    setElapsed(0);
    setProblem(null);
    setStatus('requesting');
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setCanAskAgain(permission.canAskAgain !== false);
        setStatus('denied');
        return;
      }
      if (!(await Location.hasServicesEnabledAsync())) {
        setProblem(new Error('Location is switched off on this phone. Turn it on and scan again.'));
        setStatus('error');
        return;
      }
      startedAtRef.current = Date.now();
      setStatus('scanning');
      subscriptionRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1000,
          // Every fix, even one that has not moved: standing still is the
          // whole point, and the repeats are what the average is made of.
          distanceInterval: 0,
        },
        (position) => {
          const c = position?.coords;
          if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;
          setFixes((prev) => [
            ...prev,
            {
              latitude: c.latitude,
              longitude: c.longitude,
              // Android reports null for a fix with no accuracy estimate; the
              // weighting skips those, and the display says "unknown".
              accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
              at: position.timestamp || Date.now(),
            },
          ]);
        },
      );
      timerRef.current = setInterval(() => {
        const seconds = (Date.now() - startedAtRef.current) / 1000;
        setElapsed(Math.min(seconds, SCAN_SECONDS));
        if (seconds >= SCAN_SECONDS) stop();
      }, SCAN_TICK_MS);
    } catch (err) {
      setProblem(err);
      setStatus('error');
    }
  }, [stop]);

  const reset = useCallback(() => {
    stop();
    setFixes([]);
    setElapsed(0);
    setProblem(null);
    setStatus('idle');
  }, [stop]);

  // Leaving the screen mid-scan must release the GPS: a watch left running
  // keeps the receiver on and the battery draining behind another screen.
  useEffect(() => () => stop(), [stop]);

  return { status, fixes, elapsed, problem, canAskAgain, start, stop, reset };
}

/* ── Pieces ──────────────────────────────────────────────────────────────── */

/**
 * The thirty-second ring with the accuracy percentage inside it.
 *
 * Two different facts in one figure, kept apart by where they sit: the ring's
 * sweep is TIME (how much of the scan is left), the number is QUALITY (how
 * sharp the latest fix is). Someone glancing at it learns "nearly done, and
 * it is good" or "nearly done, and it is not — stay put and scan again".
 */
function ScanRing({ fraction, percent, scanning }) {
  const t = useTheme();
  const size = 148;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, fraction || 0));
  const tone =
    percent == null ? t.textMuted : percent >= 70 ? t.status.good : percent >= 35 ? t.status.warning : t.status.critical;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={t.surfaceSunken} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={scanning ? t.accent : t.borderStrong}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - clamped)}
        />
      </Svg>
      <Text
        style={[
          type.title,
          { color: tone, fontSize: 34, lineHeight: 40, fontVariant: ['tabular-nums'] },
        ]}
      >
        {percent == null ? '—' : `${percent}%`}
      </Text>
      <Text style={[type.caption, { color: t.textSecondary }]}>GPS accuracy</Text>
    </View>
  );
}

/** One labelled figure in the row under the ring. */
function Figure({ label, value, tone }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', minWidth: 0 }}>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
        style={[type.heading, { color: tone || t.textPrimary, fontVariant: ['tabular-nums'] }]}
      >
        {value}
      </Text>
      <Text numberOfLines={1} style={[type.caption, { color: t.textSecondary }]}>
        {label}
      </Text>
    </View>
  );
}

/** A label/value line in the coordinates cards. */
function Line({ label, value, tone }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.md, paddingVertical: 3 }}>
      <Text style={[type.caption, { color: t.textSecondary, width: 92 }]}>{label}</Text>
      <Text
        numberOfLines={1}
        style={[type.body, { color: tone || t.textPrimary, flex: 1, fontVariant: ['tabular-nums'] }]}
      >
        {value}
      </Text>
    </View>
  );
}

/**
 * How the picker labels a sensor: what it has, if anything.
 *
 * An unlocated sensor is flagged, not just left bare next to one that already
 * shows its date and accuracy — "· needs location" is what makes it findable
 * in an alphabetical list of forty sensors instead of something you have to
 * already know to look for.
 */
function pickerLabel(row) {
  if (!row.has_location) return `${row.sensor_name} · needs location`;
  const parts = ['set'];
  const acc = formatMetres(row.location_accuracy_m);
  if (acc) parts.push(acc);
  if (row.location_updated_on) parts.push(String(row.location_updated_on).slice(0, 10));
  return `${row.sensor_name} · ${parts.join(' · ')}`;
}

/* ── Screen ──────────────────────────────────────────────────────────────── */

export function SensorLocationScreen({ route }) {
  const t = useTheme();
  const { site, sitePending, sitesLoading, appSettings } = useDashboard();
  const canSet = Boolean(appSettings?.can_set_location);

  const wanted = route?.params?.sensor || null;
  const wantedName = route?.params?.sensorName || null;

  /**
   * Every sensor at the selected site, with what each already has — or, with
   * "All sites" picked, every sensor at every site the account may see. An
   * installer standing at a farm can open this screen and place a sensor
   * whatever the header filter happens to say; the endpoint already answers
   * a blank site with everything permitted. Reference TTL — the list changes
   * when someone saves, and a save invalidates it.
   */
  const list = useQuery(
    sitePending ? null : cacheKey('sensors_for_location', { site }),
    () => getSensorsForLocation({ site }),
    { ttl: TTL_REFERENCE },
  );
  const rows = useMemo(() => (Array.isArray(list.data?.rows) ? list.data.rows : EMPTY_ROWS), [list.data]);

  const [selected, setSelected] = useState(wanted);
  // A new arrival with a sensor in the params re-selects: the screen is a
  // hidden tab and stays mounted, so its state outlives the visit.
  useEffect(() => {
    if (wanted) setSelected(wanted);
    else if (wantedName) {
      const hit = rows.find((r) => r.sensor_name === wantedName);
      if (hit) setSelected(hit.name);
    }
  }, [wanted, wantedName, rows]);

  const row = useMemo(() => rows.find((r) => r.name === selected) || null, [rows, selected]);
  /**
   * Unlocated sensors first, so the picker reads as a to-do list an installer
   * can clear top to bottom, rather than an alphabetical roster where the
   * ones that still need a position are scattered among the ones that don't.
   * Alphabetical within each half, so the order is still predictable.
   */
  const options = useMemo(() => {
    const sorted = [...rows].sort((a, b) => {
      if (Boolean(a.has_location) !== Boolean(b.has_location)) return a.has_location ? 1 : -1;
      return String(a.sensor_name || '').localeCompare(String(b.sensor_name || ''));
    });
    return sorted.map((r) => ({ value: r.name, label: pickerLabel(r) }));
  }, [rows]);


  const scan = useGpsScan();
  const summary = useMemo(() => weightedPosition(scan.fixes), [scan.fixes]);
  const latest = scan.fixes.length ? scan.fixes[scan.fixes.length - 1] : null;
  const latestPercent = accuracyPercent(latest?.accuracy);
  const scanning = scan.status === 'scanning';
  const secondsLeft = Math.max(0, Math.ceil(SCAN_SECONDS - scan.elapsed));

  // Previous positions, where the server keeps them. Its own cache key per
  // sensor; a save invalidates the prefix.
  const history = useQuery(
    row ? cacheKey('sensor_location_history', { sensor: row.name }) : null,
    () => getSensorLocationHistory({ sensor: row.name, pageLength: 5 }),
    { ttl: TTL_SERIES },
  );
  const historyRows = Array.isArray(history.data?.rows) ? history.data.rows : EMPTY_ROWS;

  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(null);

  // Changing sensor drops the previous scan: its fixes were taken standing at
  // a different device, and saving them here would place this one there.
  const pickSensor = useCallback(
    (name) => {
      setSelected(name);
      setSaved(null);
      setSaveError(null);
      scan.reset();
    },
    [scan],
  );

  /** The unlocated ones, in picker order — the queue "Next" walks through. */
  const unlocated = useMemo(
    () => options.filter((o) => !rows.find((r) => r.name === o.value)?.has_location),
    [options, rows],
  );
  const nextUnlocated = useCallback(() => {
    const current = unlocated.findIndex((o) => o.value === selected);
    const upcoming = unlocated[current + 1] || unlocated[0];
    if (upcoming) pickSensor(upcoming.value);
  }, [unlocated, selected, pickSensor]);

  const doSave = useCallback(async () => {
    if (!row || !summary) return;
    setConfirming(false);
    setSaving(true);
    setSaveError(null);
    try {
      const result = await setSensorLocation({
        sensor: row.name,
        latitude: summary.latitude,
        longitude: summary.longitude,
        accuracyM: summary.accuracy,
        samples: summary.samples,
        device: Device.modelName || null,
      });
      // Everything that shows a position: the picker's own list, the map, and
      // the row Sensor detail looks up.
      invalidate('sensors_for_location');
      invalidate('sensor_map');
      invalidate('sensor_location_lookup');
      invalidate(cacheKey('sensor_location_history', { sensor: row.name }));
      setSaved(result);
      scan.reset();
      list.refresh();
      history.refresh();
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }, [row, summary, scan, list, history]);

  const save = useCallback(() => {
    if (!row || !summary) return;
    if (row.has_location) setConfirming(true);
    else doSave();
  }, [row, summary, doSave]);

  const moved = row?.has_location && summary ? haversineMetres(row, summary) : null;

  /* ── Render ── */

  if (sitePending || sitesLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: t.background, padding: spacing.lg, gap: spacing.md }}>
        <Skeleton height={48} radius={radius.md} />
        <Skeleton height={120} radius={radius.lg} />
      </View>
    );
  }

  if (!canSet) {
    return (
      <View style={{ flex: 1, backgroundColor: t.background, justifyContent: 'center' }}>
        <EmptyState
          title="Coordinates are read-only for this account"
          message="Setting a sensor's position needs the System Manager role. Ask an administrator to add it."
          action={<Button label="Open the map" tone="ghost" onPress={() => goToSensorMap()} />}
        />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      keyboardShouldPersistTaps="handled"
    >
      {list.error ? <ErrorView error={list.error} onRetry={list.refresh} /> : null}

      {/*
        The count this whole screen exists to close, plus a way to close it
        one sensor at a time without reopening the dropdown after every save —
        the workflow is "walk the site", not "look one thing up".
      */}
      {!list.loading && rows.length ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: spacing.sm,
          }}
        >
          <Text style={[type.caption, { color: unlocated.length ? t.status.warning : t.status.good }]}>
            {unlocated.length
              ? `${unlocated.length} of ${rows.length} sensors at ${site || 'this site'} still need coordinates`
              : `All ${rows.length} sensors at ${site || 'this site'} have coordinates`}
          </Text>
          {unlocated.length ? (
            <Button label="Next" tone="ghost" compact onPress={nextUnlocated} />
          ) : null}
        </View>
      ) : null}

      <SelectField
        label="Sensor"
        value={selected}
        options={options}
        onChange={pickSensor}
        placeholder={list.loading ? 'Loading sensors…' : rows.length ? 'Choose a sensor' : `No sensors at ${site || 'any of your sites'}`}
        disabled={list.loading}
      />

      {row ? (
        <Card style={{ marginBottom: spacing.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={[type.heading, { color: t.textPrimary }]}>
                {row.sensor_name}
              </Text>
              <Text numberOfLines={1} style={[type.caption, { color: t.textSecondary }]}>
                {[row.sensor_site || site, row.sensor_type, row.monitoring].filter(Boolean).join(' · ')}
              </Text>
            </View>
            {row.has_location ? (
              <StatusChip tone="good" label="Set" />
            ) : (
              <StatusChip tone="warning" label="No coordinates" />
            )}
          </View>
          {row.has_location ? (
            <>
              <Line label="Position" value={formatCoordinates(row.latitude, row.longitude)} />
              <Line label="Accuracy" value={formatMetres(row.location_accuracy_m) || 'unknown'} />
              {row.location_samples ? <Line label="Fixes" value={`${row.location_samples}`} /> : null}
              <Line
                label="Updated"
                value={
                  row.location_updated_on
                    ? `${shortTimestamp(row.location_updated_on)}${row.location_updated_by ? ` · ${row.location_updated_by}` : ''}`
                    : 'unknown'
                }
              />
              <Button
                label="View on map"
                tone="ghost"
                compact
                style={{ alignSelf: 'flex-start', marginTop: spacing.sm }}
                onPress={() => goToSensorMap({ focus: row.sensor_name })}
              />
            </>
          ) : (
            <Text style={[type.body, { color: t.textSecondary, lineHeight: 20 }]}>
              This sensor has never been placed. Stand beside it, in the open if you can, and scan.
            </Text>
          )}
        </Card>
      ) : null}

      {/* ── The scan ── */}
      <SectionTitle hint={`±${ACCURACY_FULL_M} m = 100 % · ±${ACCURACY_ZERO_M} m = 0 %`}>GPS scan</SectionTitle>
      <Card style={{ alignItems: 'center', marginBottom: spacing.lg }}>
        <ScanRing fraction={scan.elapsed / SCAN_SECONDS} percent={latestPercent} scanning={scanning} />

        <View
          style={{
            flexDirection: 'row',
            alignSelf: 'stretch',
            marginTop: spacing.lg,
            paddingTop: spacing.md,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: t.border,
          }}
        >
          <Figure label="fixes" value={`${scan.fixes.length}`} />
          <Figure label="latest fix" value={formatMetres(latest?.accuracy) || '—'} />
          <Figure
            label={scanning ? 'seconds left' : 'averaged'}
            value={scanning ? `${secondsLeft}` : formatMetres(summary?.accuracy) || '—'}
          />
        </View>

        {summary ? (
          <View style={{ alignSelf: 'stretch', marginTop: spacing.md }}>
            <Line label="Average" value={formatCoordinates(summary.latitude, summary.longitude)} />
            <Line
              label="Weighting"
              value={`${summary.samples} fix${summary.samples === 1 ? '' : 'es'} · sharp fixes count more`}
            />
            {moved != null && row?.has_location ? (
              <Line
                label="Moves by"
                value={formatMetres(moved, { prefix: '' })}
                tone={moved > (row.location_accuracy_m || ACCURACY_ZERO_M) ? t.status.warning : t.textPrimary}
              />
            ) : null}
          </View>
        ) : null}

        {/* Why the numbers are what they are, said once. */}
        <Text style={[type.caption, { color: t.textMuted, textAlign: 'center', lineHeight: 16, marginTop: spacing.md }]}>
          Accuracy is the radius the phone gives for each fix; ±{ACCURACY_FULL_M} m reads as 100 %. Fixes are
          averaged with each weighted by 1/accuracy². Satellite counts are not available to the app.
        </Text>

        {!Device.isDevice ? (
          <Text style={[type.caption, { color: t.status.warning, textAlign: 'center', lineHeight: 16, marginTop: spacing.sm }]}>
            This is an emulator: the position it reports is whatever the emulator is set to, not a fix.
          </Text>
        ) : null}

        {scan.status === 'denied' ? (
          <View style={{ alignSelf: 'stretch', marginTop: spacing.md, gap: spacing.sm }}>
            <Text style={[type.body, { color: t.status.serious, lineHeight: 20, textAlign: 'center' }]}>
              Location permission was refused, so the phone cannot read its position.
              {scan.canAskAgain ? ' Scan again to be asked once more, or allow it in Settings.' : ' Allow it under App permissions → Location, then come back.'}
            </Text>
            <Button label="Open settings" tone="ghost" compact onPress={() => Linking.openSettings()} />
          </View>
        ) : null}
        {scan.status === 'error' ? (
          <Text style={[type.body, { color: t.status.serious, lineHeight: 20, textAlign: 'center', marginTop: spacing.md }]}>
            {scan.problem?.message || 'The GPS could not be read.'}
          </Text>
        ) : null}

        <View style={{ flexDirection: 'row', gap: spacing.md, alignSelf: 'stretch', marginTop: spacing.lg }}>
          {scanning ? (
            <Button label="Stop" tone="ghost" onPress={scan.stop} style={{ flex: 1 }} />
          ) : (
            <Button
              label={scan.fixes.length ? 'Scan again' : 'Scan'}
              tone={summary ? 'ghost' : 'accent'}
              loading={scan.status === 'requesting'}
              disabled={!row}
              onPress={scan.start}
              style={{ flex: 1 }}
            />
          )}
          <Button
            label={row?.has_location ? 'Update coordinates' : 'Add coordinates'}
            disabled={!row || !summary || scanning}
            loading={saving}
            onPress={save}
            style={{ flex: 1.4 }}
          />
        </View>
        {!row ? (
          <Text style={[type.caption, { color: t.textMuted, marginTop: spacing.sm }]}>Choose a sensor first.</Text>
        ) : null}
      </Card>

      {saveError ? <ErrorView error={saveError} onRetry={doSave} /> : null}

      {saved ? (
        <Card style={{ marginBottom: spacing.lg, borderColor: t.status.good }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs }}>
            <Ionicons name="checkmark-circle" size={20} color={t.status.good} />
            <Text style={[type.heading, { color: t.textPrimary, flex: 1 }]}>Saved</Text>
          </View>
          <Line label="Sensor" value={saved.sensor_name || row?.sensor_name || ''} />
          <Line label="Position" value={formatCoordinates(saved.latitude, saved.longitude)} />
          <Line label="Accuracy" value={formatMetres(saved.location_accuracy_m) || 'unknown'} />
          {saved.location_samples ? <Line label="Fixes" value={`${saved.location_samples}`} /> : null}
          {saved.previous ? (
            <Line label="Moved" value={formatMetres(haversineMetres(saved.previous, saved), { prefix: '' })} />
          ) : null}
          <Button
            label="View on map"
            style={{ marginTop: spacing.md }}
            onPress={() => goToSensorMap({ focus: saved.sensor_name || row?.sensor_name })}
          />
        </Card>
      ) : null}

      {/* Earlier positions, on a server that keeps them. Left out entirely
          on one that does not: "no history" there would mean nothing. */}
      {row && history.data?.supported && historyRows.length ? (
        <>
          <SectionTitle>Previous positions</SectionTitle>
          <Card padded={false}>
            {historyRows.map((h, i) => (
              <View
                key={h.name || i}
                style={{
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.md,
                  borderTopWidth: i ? StyleSheet.hairlineWidth : 0,
                  borderTopColor: t.border,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <Text style={[type.body, { color: t.textPrimary, flex: 1, fontVariant: ['tabular-nums'] }]}>
                    {formatCoordinates(h.latitude, h.longitude)}
                  </Text>
                  <Text style={[type.caption, { color: t.textSecondary }]}>
                    {formatMetres(h.accuracy_m) || ''}
                  </Text>
                </View>
                <Text numberOfLines={1} style={[type.caption, { color: t.textMuted, marginTop: 2 }]}>
                  {[
                    h.recorded_at ? relativeTime(h.recorded_at) || shortTimestamp(h.recorded_at) : null,
                    h.user,
                    h.device,
                    h.previous_latitude != null && h.previous_longitude != null
                      ? `moved ${formatMetres(
                          haversineMetres(
                            { latitude: h.previous_latitude, longitude: h.previous_longitude },
                            h,
                          ),
                          { prefix: '' },
                        )}`
                      : 'first position',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <ConfirmDialog
        visible={confirming}
        title="Replace the coordinates?"
        message={
          row && summary
            ? `${row.sensor_name} is at ${formatCoordinates(row.latitude, row.longitude)} (${
                formatMetres(row.location_accuracy_m) || 'accuracy unknown'
              }). The new fix is ${formatCoordinates(summary.latitude, summary.longitude)} (${formatMetres(
                summary.accuracy,
              )}), ${formatMetres(moved, { prefix: '' }) || '—'} away.`
            : ''
        }
        confirmLabel="Replace"
        cancelLabel="Keep"
        onConfirm={doSave}
        onCancel={() => setConfirming(false)}
      />

    </ScrollView>
  );
}
