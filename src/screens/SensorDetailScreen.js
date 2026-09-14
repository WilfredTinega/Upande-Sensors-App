import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { LineChart, formatTick } from '../components/LineChart';
import { Button, Card, ChoiceButtons, EmptyState, ErrorView, StatTile, StatusChip } from '../components/ui';
import { Skeleton, SkeletonChart } from '../components/Skeleton';
import { TTL_LIVE, TTL_REFERENCE, TTL_SERIES, cacheKey, invalidate } from '../api/cache';
import { getSensorsForLocation } from '../api/endpoints';
import { liveKey, loadLiveForSite } from '../api/liveSite';
import { DEFAULT_MEASURES, fetchBucketedTrend, fetchSeriesTrend } from '../api/trend';
import { useDashboard } from '../context/DashboardContext';
import { useQuery } from '../hooks/useQuery';
import { goToSensorLocation, goToSensorMap } from '../navigation/ref';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { formatCoordinates, formatMetres, hasCoordinates } from '../utils/geo';
import {
  daysAgo,
  fullTimestamp,
  isStale,
  parseServerTime,
  relativeTime,
  toISODate,
  trimFutureSeries,
} from '../utils/dates';
import { isMeasured, measuredValues, sortByMeasure } from '../utils/measures';

/**
 * One sensor's chart, reached by tapping its card on Live.
 *
 * The five quick ranges are the web sensor dashboard's: 24h, 2, 3, 7 and 14
 * days. They are served the way the Dashboard tab serves its ranges — minute
 * buckets for a day, calendar buckets beyond — through the same `trend.js`
 * helpers and the same `LineChart`, so a line here and a line there for the
 * same sensor and window are the same picture.
 *
 * `interval` is paired with each range deliberately: two or three days at
 * daily resolution collapse to two or three points, and a fortnight at hourly
 * is ~340 points of noise on a phone-width chart.
 */
export const SENSOR_RANGES = [
  { key: '24h', label: '24h', days: 1, bucketMins: 30 },
  { key: '2d', label: '2 days', days: 2, interval: 'hourly' },
  { key: '3d', label: '3 days', days: 3, interval: 'hourly' },
  { key: '7d', label: '7 days', days: 7, interval: 'daily' },
  { key: '14d', label: '14 days', days: 14, interval: 'daily' },
];

/**
 * The last range chosen, kept across visits. Module state rather than
 * navigation params: someone checking three sensors in a row wants the same
 * window on each, not to pick it three times.
 */
let rememberedRange = '24h';

const EMPTY_TREND = { labels: [], series: [] };
const TILE_WIDTH = { flex: 1, minWidth: 104 };

/**
 * 24h is "the last 24 hours", not "yesterday and today". The bucketed endpoint
 * takes whole days, so it is asked for both and the buckets older than a day
 * are dropped here, on the label axis both halves of the result share.
 */
function lastHours(trend, hours) {
  const labels = Array.isArray(trend?.labels) ? trend.labels : [];
  if (!labels.length) return trend;
  const cutoff = Date.now() - hours * 3600000;
  let start = 0;
  while (start < labels.length) {
    const at = parseServerTime(labels[start]);
    if (!at || at.getTime() >= cutoff) break;
    start += 1;
  }
  if (!start) return trend;
  return {
    ...trend,
    labels: labels.slice(start),
    series: (trend.series || []).map((s) => ({ ...s, values: s.values.slice(start) })),
  };
}

/**
 * Where the sensor is on the ground: coordinates and accuracy with a way to
 * the map, or — for an account that may set them — the way to the GPS capture
 * when it has none. One request, cached at reference TTL and invalidated by a
 * save, so it costs a visit nothing after the first time.
 *
 * Renders nothing at all when there is nothing honest to say: an older server
 * without the endpoint, a sensor the registry does not know, or a sensor with
 * no position seen by an account that cannot set one. A row reading "No
 * coordinates" for someone who can do nothing about it is just a reproach.
 */
function LocationRow({ site, sensorName, canSet }) {
  const t = useTheme();
  const lookup = useQuery(
    site && sensorName ? cacheKey('sensor_location_lookup', { site, sensorName }) : null,
    () => getSensorsForLocation({ site, search: sensorName }),
    { ttl: TTL_REFERENCE },
  );
  const row = useMemo(
    () => (Array.isArray(lookup.data?.rows) ? lookup.data.rows : []).find((r) => r.sensor_name === sensorName) || null,
    [lookup.data, sensorName],
  );

  if (lookup.error || (lookup.data && !row)) return null;
  if (!lookup.data) {
    return (
      <Card style={{ marginBottom: spacing.sm }}>
        <Skeleton width="60%" height={14} />
      </Card>
    );
  }
  const placed = hasCoordinates(row);
  if (!placed && !canSet) return null;
  const accuracy = formatMetres(row.location_accuracy_m);
  /**
   * The place, when the Sensor row has been given one — "Naivasha Road,
   * Naivasha" rather than "-1.17106, 36.9763…", which is what a truncated pair
   * of coordinates reads as at this width and tells nobody where the sensor is.
   *
   * `physical_location` is filled by whatever last resolved it: the coordinate
   * save from the phone, the Desk form, or the migrate backfill. A server too
   * old to send the field, or a fix no geocoder could name, falls back to the
   * coordinates — which is why they are still the second half of this.
   */
  const place = String(row.physical_location || '').trim();

  return (
    <Card style={{ marginBottom: spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Ionicons name={placed ? 'location' : 'location-outline'} size={18} color={placed ? t.accent : t.textMuted} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[type.caption, { color: t.textSecondary }]}>Location</Text>
          <Text
            numberOfLines={1}
            style={[
              type.body,
              { color: t.textPrimary },
              // Tabular figures line coordinates up; they do nothing for a name.
              place && placed ? null : { fontVariant: ['tabular-nums'] },
            ]}
          >
            {!placed
              ? 'No coordinates yet'
              : place || `${formatCoordinates(row.latitude, row.longitude)}${accuracy ? ` · ${accuracy}` : ''}`}
          </Text>
          {place && placed ? (
            <Text
              numberOfLines={1}
              style={[type.caption, { color: t.textMuted, fontVariant: ['tabular-nums'] }]}
            >
              {`${formatCoordinates(row.latitude, row.longitude)}${accuracy ? ` · ${accuracy}` : ''}`}
            </Text>
          ) : null}
        </View>
        {placed ? (
          <Button compact tone="ghost" label="View on map" onPress={() => goToSensorMap({ focus: sensorName })} />
        ) : null}
        {canSet ? (
          <Button
            compact
            tone={placed ? 'ghost' : 'accent'}
            label={placed ? 'Update' : 'Set coordinates'}
            onPress={() => goToSensorLocation({ sensor: row.name, sensorName })}
          />
        ) : null}
      </View>
    </Card>
  );
}

export function SensorDetailScreen({ route }) {
  const t = useTheme();
  const { sensorName, sensorType } = route?.params || {};
  // The sensor's site travels in the params; the header filter is not offered
  // on this screen because a sensor belongs to exactly one site.
  const site = route?.params?.site || null;
  const { unitForType, appSettings } = useDashboard();

  const [rangeKey, setRangeKeyState] = useState(rememberedRange);
  const [focused, setFocused] = useState([]);
  const [chartHeight, setChartHeight] = useState(0);

  const setRangeKey = useCallback((key) => {
    rememberedRange = key;
    setRangeKeyState(key);
  }, []);

  const range = useMemo(() => SENSOR_RANGES.find((r) => r.key === rangeKey) || SENSOR_RANGES[0], [rangeKey]);
  const dateTo = toISODate(new Date());
  // Inclusive span: 7 days is today plus the six before it. 24h asks for two
  // calendar days and trims below.
  const dateFrom = toISODate(daysAgo(range.days === 1 ? 1 : range.days - 1));

  /**
   * The sensor's current values, from the cache the Live screen already
   * filled — this screen is reached from there, so it is warm and costs no
   * request; a refresh here refetches it for both.
   */
  const live = useQuery(site ? liveKey(site) : null, () => loadLiveForSite(site), { ttl: TTL_LIVE });
  const entry = live.data?.live?.[sensorName];
  const params = useMemo(() => {
    const raw = entry?.params?.length ? entry.params : entry ? [{ type: '', value: entry.value, uom: entry.uom, ts: entry.ts }] : [];
    return sortByMeasure(raw, (p) => p.type);
  }, [entry]);
  const latestTs = params.reduce((newest, p) => (p.ts > (newest || '') ? p.ts : newest), null);

  /**
   * Which measures to chart on the multi-day path — the ones this sensor
   * reports, from the live entry, else the defaults. The single-day path needs
   * no list: the server charts whatever the window contains.
   */
  const measures = useMemo(() => {
    const reported = params.map((p) => p.type).filter(Boolean);
    return reported.length ? reported : DEFAULT_MEASURES;
  }, [params]);

  const trend = useQuery(
    site && sensorName
      ? cacheKey('sensor_trend', {
          site,
          sensorName,
          range: range.key,
          dateFrom,
          dateTo,
          measures: range.interval ? measures.join('|') : '',
        })
      : null,
    ({ signal } = {}) =>
      range.interval
        ? fetchSeriesTrend({ site, sensorName, measures, dateFrom, dateTo, interval: range.interval }, signal)
        : fetchBucketedTrend({ site, sensorName, dateFrom, dateTo, bucketMins: range.bucketMins }, signal).then(
            (res) => lastHours(res, 24),
          ),
    { ttl: TTL_SERIES },
  );

  /**
   * Units, canonical order, nothing drawn in the future — and nothing derived.
   *
   * The Dashboard tab appends Dew Point and ΔT; this screen deliberately does
   * not. It is reached by tapping a card on Live, which carries no tab with it,
   * so there is no way to tell a greenhouse sensor from one in a cold room —
   * and the pair is only meaningful for the first (see `derivesClimate`).
   * Guessing wrong would put two invented lines on a chilled store's chart, and
   * the tiles below are the sensor's own parameters — a derived one among them
   * would read as something the device measured.
   */
  const merged = useMemo(() => {
    const rows = Array.isArray(trend.data?.series) ? trend.data.series : [];
    if (!rows.length) return EMPTY_TREND;
    const series = sortByMeasure(rows.map((s) => ({ ...s, unit: unitForType(s.label) })), (x) => x.label);
    return trimFutureSeries(trend.data.labels || [], series);
  }, [trend.data, unitForType]);

  const coloured = useMemo(
    () => merged.series.map((x, i) => ({ ...x, color: t.series[i % t.series.length] })),
    [merged.series, t.series],
  );
  const shown = useMemo(
    () => (focused.length ? coloured.filter((x) => focused.includes(x.label)) : coloured),
    [coloured, focused],
  );
  const stats = useMemo(
    () =>
      coloured.map((s) => {
        const finite = measuredValues(s.values);
        return finite.length ? { ...s, latest: finite[finite.length - 1] } : { ...s, latest: null };
      }),
    [coloured],
  );

  const hasData = merged.series.some((s) => s.values.some(isMeasured));
  const dateOnly = range.interval === 'daily';
  const axisLabels = useMemo(
    () => merged.labels.map((l) => (dateOnly ? String(l).slice(0, 10) : fullTimestamp(l))),
    [merged.labels, dateOnly],
  );

  const refresh = useCallback(() => {
    invalidate('sensor_trend');
    if (site) invalidate(liveKey(site));
    return Promise.all([trend.refresh(), site ? live.refresh() : Promise.resolve()]);
  }, [trend, live, site]);

  const showSkeleton = trend.loading || trend.refreshing;
  const stale = latestTs ? isStale(latestTs) : true;

  if (!sensorName) {
    // Wrapped, because a bare EmptyState is an unstyled auto-height View: at the
    // root of a screen it sits flush against the header on a transparent
    // background, which reads as a half-rendered screen rather than a message.
    return (
      <View style={{ flex: 1, backgroundColor: t.background, justifyContent: 'center' }}>
        <EmptyState title="No sensor selected" message="Open a sensor from the Live tab." />
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 0, flexGrow: 1 }}
      refreshControl={<RefreshControl refreshing={trend.refreshing} onRefresh={refresh} tintColor={t.accent} colors={[t.accent]} />}
    >
      {/*
        Where this sensor is, and how fresh it is. NOT its values.

        This card used to list every parameter with its current value — and the
        stat tiles a few pixels below, which are the chart's legend, list the
        same measures with the same numbers. Two identical readouts on one
        screen is not emphasis, it is the reader checking whether they differ.
        The tiles win because they do something the card cannot: tapping one
        isolates its line. What is left here is what the tiles do not carry —
        the site, the registry type, and the freshness chip.
      */}
      <Card style={{ marginBottom: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={[type.body, { color: t.textSecondary }]}>
              {site}
              {/* Only when it adds something: a node whose registry type is
                  "Humidity" while it reports three measures is contradicted by
                  its own tiles, so that line is better left off. */}
              {sensorType && params.length <= 1 ? ` · ${sensorType}` : ''}
            </Text>
          </View>
          {live.loading ? (
            <Skeleton width={72} height={20} radius={radius.pill} />
          ) : params.length ? (
            <StatusChip tone={stale ? 'warning' : 'good'} label={stale ? `Stale · ${relativeTime(latestTs) || 'unknown'}` : relativeTime(latestTs) || 'Live'} />
          ) : (
            <StatusChip tone="serious" label="No data" />
          )}
        </View>
      </Card>

      <LocationRow site={site} sensorName={sensorName} canSet={Boolean(appSettings?.can_set_location)} />

      <ChoiceButtons
        style={{ marginBottom: spacing.sm }}
        options={SENSOR_RANGES.map((r) => ({ label: r.label, value: r.key }))}
        value={rangeKey}
        onChange={setRangeKey}
      />

      {!showSkeleton && trend.error ? <ErrorView error={trend.error} onRetry={refresh} /> : null}
      {showSkeleton ? <SkeletonChart /> : null}

      {!showSkeleton && !trend.error ? (
        <Card padded={false} style={{ flex: 1, marginHorizontal: -spacing.lg, borderRadius: 0, borderLeftWidth: 0, borderRightWidth: 0, borderBottomWidth: 0 }}>
          {hasData ? (
            <>
              {/* No sensor name heading here: the navigation header already
                  names the sensor, at the top of the same screen. A second
                  copy reads as a different sensor until you compare them. */}
              {/* Latest per measure, colour-keyed to its line; tap to isolate. */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                directionalLockEnabled
                contentContainerStyle={{ flexDirection: 'row', flexGrow: 1, gap: spacing.sm, padding: spacing.lg, paddingBottom: 0 }}
              >
                {stats.map((s) => (
                  <Pressable
                    key={s.label}
                    accessibilityRole="button"
                    accessibilityState={{ selected: focused.includes(s.label) }}
                    accessibilityLabel={`${s.label}. ${focused.includes(s.label) ? 'Selected. Tap to remove' : 'Tap to compare'}`}
                    onPress={() =>
                      setFocused((f) => (f.includes(s.label) ? f.filter((x) => x !== s.label) : [...f, s.label]))
                    }
                    style={TILE_WIDTH}
                  >
                    <StatTile
                      label={s.label}
                      value={s.latest === null ? null : formatTick(s.latest)}
                      unit={s.unit}
                      accent={s.color}
                      selected={focused.includes(s.label)}
                      style={{ flex: 0, width: '100%' }}
                    />
                  </Pressable>
                ))}
              </ScrollView>
              <View
                style={{ flex: 1, minHeight: 220, paddingTop: spacing.lg, paddingBottom: spacing.md }}
                onLayout={(e) => setChartHeight(e.nativeEvent.layout.height)}
              >
                <LineChart
                  labels={axisLabels}
                  tooltipLabels={axisLabels}
                  series={shown}
                  height={Math.max(200, chartHeight - spacing.lg - spacing.md)}
                />
              </View>
            </>
          ) : (
            <EmptyState
              title="No readings in this range"
              message={`${sensorName} recorded nothing between ${dateFrom} and ${dateTo}. Try a wider range.`}
            />
          )}
        </Card>
      ) : null}
    </ScrollView>
  );
}
