import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';

import { LineChart, formatTick } from '../components/LineChart';
import {
  Card,
  ChoiceButtons,
  EmptyState,
  ErrorView,
  SelectField,
  StatTile,
} from '../components/ui';
import { Skeleton, SkeletonChart } from '../components/Skeleton';
import { TTL_LIVE, TTL_REFERENCE, TTL_SERIES, cacheKey, invalidate } from '../api/cache';
import { getChartSensorNames } from '../api/endpoints';
import { ROLLUP_SPAN_DAYS, fetchBucketedTrend, fetchSeriesTrend } from '../api/trend';
import {
  isMeasured,
  measuredValues,
  measuresFromLive,
  shortMeasureLabel,
  sortByMeasure,
  withDerivedMeasures,
} from '../utils/measures';
import { liveKey, loadLiveForSite } from '../api/liveSite';
import { useDashboard } from '../context/DashboardContext';
import { useQuery } from '../hooks/useQuery';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';
import { RANGES, fullTimestamp, rangeToDates, trimFutureSeries } from '../utils/dates';

/** Chart bucket width for a single day. `sensor_dashboard` groups by minutes. */
const BUCKET_MINS = 20;

/** Stable empty result, so an empty chart doesn't re-render on every pass. */
const EMPTY_TREND = { labels: [], series: [] };

export function ChartsScreen() {
  const t = useTheme();
  const {
    site,
    sitesLoading,
    unitForType,
    filtersLocked,
    tabTag,
    configLoading,
    sensorTypesForTab,
    sitePending,
  } = useDashboard();

  const [sensorName, setSensorName] = useState(null);
  const [rangeKey, setRangeKey] = useState('today');
  /**
   * Measures picked by tapping their tiles. Empty means show every line.
   *
   * A list rather than a single selection so two or more can be put side by
   * side — comparing temperature against humidity is the common reason to
   * narrow the chart at all.
   */
  const [focused, setFocused] = useState([]);
  /** Measured, so the plot fills whatever is left above the tab bar. */
  const [chartHeight, setChartHeight] = useState(0);

  const { dateFrom, dateTo, interval, days } = useMemo(() => rangeToDates(rangeKey), [rangeKey]);

  /**
   * Beyond a day, `sensor_dashboard` answers from the hourly rollup table
   * rather than from raw readings — and where that table has never been built
   * it answers with nothing at all. Wide ranges therefore read the raw-backed
   * series endpoint instead. See `src/api/trend.js`.
   */
  const wideRange = days >= ROLLUP_SPAN_DAYS;

  /**
   * Which measures to ask for, when asking one at a time.
   *
   * Taken from what the site is actually reporting, not from the tab's
   * configured types: the single-day path gets its measures from the server's
   * own response, which isn't tab-filtered, so sourcing this from the tab
   * config made measures the site reports — soil temperature, on tabs that
   * don't list it — appear on Today and vanish on every wider range.
   *
   * The live payload is already cached under the key the Live screen uses (the
   * sign-in probe fills it), so this reads it rather than fetching anything.
   * The tab's own types are folded in for anything not currently reporting.
   */
  const live = useQuery(site ? liveKey(site) : null, () => loadLiveForSite(site), {
    ttl: TTL_LIVE,
  });

  const measures = useMemo(() => {
    const reporting = measuresFromLive(live.data).map((m) => m.label);
    const configured = (sensorTypesForTab || []).map((st) => st.label).filter(Boolean);
    const seen = new Map();
    [...reporting, ...configured].forEach((label) => {
      const key = String(label).trim().toLowerCase();
      if (key && !seen.has(key)) seen.set(key, label);
    });
    return sortByMeasure([...seen.values()]);
  }, [live.data, sensorTypesForTab]);

  /**
   * One request covering every measure, bucketed by minutes.
   *
   * `get_chart_series` only buckets hourly or coarser and needed a request per
   * measure. `sensor_dashboard` accepts `bucket_mins` and returns a row per
   * (bucket, sensor_type), so a single call covers every parameter the site
   * reported in the window, at the interval asked for.
   */
  const trend = useQuery(
    site
      ? cacheKey('chart_trend', {
          site,
          sensorName,
          dateFrom,
          dateTo,
          tabTag,
          // Part of the key: the two paths return different resolutions, so a
          // range switch must not be answered from the other one's entry.
          grain: wideRange ? interval : `${BUCKET_MINS}m`,
          measures: wideRange ? measures.join('|') : '',
        })
      : null,
    ({ signal } = {}) =>
      wideRange
        ? fetchSeriesTrend(
            { site, sensorName, tabTag, measures, dateFrom, dateTo, interval },
            signal,
          )
        : fetchBucketedTrend(
            { site, sensorName, dateFrom, dateTo, bucketMins: BUCKET_MINS },
            signal,
          ),
    { ttl: TTL_SERIES },
  );

  /**
   * Units, canonical order, and the two derived measures.
   *
   * Both trend paths hand back `{ labels, series }` with values already aligned
   * to the label axis, so the only work left here is presentation.
   */
  const merged = useMemo(() => {
    const rows = Array.isArray(trend.data?.series) ? trend.data.series : [];
    if (!rows.length) return EMPTY_TREND;

    const series = sortByMeasure(
      rows.map((s) => ({ ...s, unit: unitForType(s.label) })),
      (x) => x.label,
    );

    // Dew point and ΔT come last: they are derived from the two above them
    // rather than measured, and the order makes that relationship legible.
    return trimFutureSeries(trend.data.labels || [], withDerivedMeasures(series));
  }, [trend.data, unitForType]);

  /**
   * Sensor names for the picker.
   *
   * Scoped to the first measure on the chart, which is only known once the
   * trend has loaded — so the selection can't gate the trend query without a
   * cycle. The query therefore uses the raw selection and it is corrected below
   * if the list says it doesn't belong here.
   */
  const firstMeasure = merged.series[0]?.label;

  /**
   * The names come back with the chart itself.
   *
   * This used to be its own request, and a *sequential* one: the picker is
   * scoped to what is on the chart, so it could not even be issued until the
   * trend had arrived. Two round trips is the one thing this screen could not
   * afford, because a phone on mobile data pays far more per round trip than the
   * query costs to run.
   *
   * The separate call is kept for the legacy fallback path, which has no names
   * to give — hence the null key, which stops `useQuery` issuing anything.
   */
  const servedNames = Array.isArray(trend.data?.sensorNames) ? trend.data.sensorNames : null;
  const names = useQuery(
    !servedNames && site && firstMeasure
      ? cacheKey('chart_sensor_names', { site, type: firstMeasure, tabTag })
      : null,
    () => getChartSensorNames({ site, sensorType: firstMeasure, tabTag }),
    { ttl: TTL_REFERENCE },
  );

  const availableNames = useMemo(
    () => servedNames || (Array.isArray(names.data) ? names.data : []),
    [servedNames, names.data],
  );

  // A sensor picked for one site or measure usually doesn't exist under the
  // next; clear it once the real list arrives rather than querying for a sensor
  // that cannot return anything.
  useEffect(() => {
    if (sensorName && availableNames.length && !availableNames.includes(sensorName)) {
      setSensorName(null);
    }
  }, [sensorName, availableNames]);

  /**
   * Fixed colour per series, assigned by position before any filtering.
   *
   * Without this, isolating the third measure would repaint it as the first
   * colour and it would no longer match its tile.
   */
  const coloured = useMemo(
    () => merged.series.map((x, i) => ({ ...x, color: t.series[i % t.series.length] })),
    [merged.series, t.series],
  );

  // Tapping tiles narrows the chart to those measures; deselecting them all
  // restores every line.
  const shown = useMemo(
    () => (focused.length ? coloured.filter((x) => focused.includes(x.label)) : coloured),
    [coloured, focused],
  );

  // Measures that disappear between refreshes are dropped from the selection,
  // so a stale pick can never leave an empty chart.
  useEffect(() => {
    if (!focused.length || !coloured.length) return;
    const valid = focused.filter((label) => coloured.some((x) => x.label === label));
    if (valid.length !== focused.length) setFocused(valid);
  }, [focused, coloured]);

  const stats = useMemo(
    () =>
      coloured.map((s) => {
        const finite = measuredValues(s.values);
        if (!finite.length) return { ...s, latest: null, average: null };
        return {
          ...s,
          latest: finite[finite.length - 1],
          average: finite.reduce((a, b) => a + b, 0) / finite.length,
          min: Math.min(...finite),
          max: Math.max(...finite),
        };
      }),
    [coloured],
  );

  const hasData = merged.series.some((s) => s.values.some(isMeasured));
  const single = merged.series.length === 1;

  /**
   * Daily buckets are all stamped midnight, and printing that time on every
   * tick says nothing — the date alone is the label.
   */
  const dateOnly = wideRange && interval === 'daily';
  const axisLabels = useMemo(
    () => merged.labels.map((l) => (dateOnly ? String(l).slice(0, 10) : fullTimestamp(l))),
    [merged.labels, dateOnly],
  );

  const refresh = useCallback(() => {
    invalidate('chart_trend');
    return trend.refresh();
  }, [trend]);

  /**
   * Also skeletons through the post-login gap where the site hasn't been picked
   * yet: until then every query key is null, so nothing is "loading" and the
   * screen would otherwise render "no readings" for a site nobody chose.
   */
  const showSkeleton =
    sitePending ||
    configLoading ||
    sitesLoading ||
    trend.loading ||
    trend.refreshing ||
    // The wide-range path can't ask for anything until it knows the measures.
    (wideRange && live.loading);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 0, flexGrow: 1 }}
      refreshControl={
        <RefreshControl
          refreshing={trend.refreshing}
          onRefresh={refresh}
          tintColor={t.accent}
          colors={[t.accent]}
        />
      }
    >
      {configLoading ? (
        <Skeleton height={38} radius={radius.pill} style={{ marginBottom: spacing.sm }} />
      ) : (
        /* No card around the filters: two self-describing controls need no
           container, and the panel was taking height from the chart. The
           ranges get their own row — five of them beside the sensor picker
           left each one too narrow to read. */
        <View style={{ marginBottom: spacing.sm, gap: spacing.xs }}>
          <SelectField
            compact
            value={sensorName}
            options={availableNames}
            onChange={setSensorName}
            allowClear
            clearLabel="All sensors"
            placeholder={names.loading || filtersLocked ? 'Loading…' : 'All sensors'}
            disabled={names.loading || filtersLocked}
          />
          <ChoiceButtons
            disabled={filtersLocked}
            options={RANGES.map((r) => ({ label: r.label, value: r.key }))}
            value={rangeKey}
            onChange={setRangeKey}
          />
        </View>
      )}

      {!showSkeleton && trend.error ? <ErrorView error={trend.error} onRetry={refresh} /> : null}

      {showSkeleton ? <SkeletonChart /> : null}

      {!showSkeleton && !trend.error ? (
        /* Full-bleed: the negative margin cancels the scroll view's padding so
           the plot spans the screen. Side borders and corner radius go with it,
           since a card edge running off-screen reads as a rendering fault. */
        <Card
          padded={false}
          style={{
            flex: 1,
            marginHorizontal: -spacing.lg,
            borderRadius: 0,
            borderLeftWidth: 0,
            borderRightWidth: 0,
            borderBottomWidth: 0,
          }}
        >
          {hasData ? (
            <>
              <Text
                numberOfLines={1}
                style={[
                  type.heading,
                  {
                    color: t.textPrimary,
                    fontFamily: font('700'),
                    paddingHorizontal: spacing.lg,
                    paddingTop: spacing.lg,
                  },
                ]}
              >
                {sensorName ? `${site} · ${sensorName}` : site}
              </Text>

              <View
                style={{
                  flexDirection: 'row',
                  // One line, always. The tiles are a comparable set; a stray
                  // fourth on its own row reads as a different kind of thing.
                  flexWrap: 'nowrap',
                  gap: spacing.sm,
                  padding: spacing.lg,
                  paddingBottom: 0,
                }}
              >
                {single ? (
                  <>
                    <StatTile
                      label="Latest"
                      value={stats[0]?.latest === null ? null : formatTick(stats[0].latest)}
                      unit={stats[0]?.unit}
                      accent={stats[0]?.color}
                    />
                    <StatTile
                      label="Average"
                      value={stats[0]?.average === null ? null : formatTick(stats[0].average)}
                      unit={stats[0]?.unit}
                    />
                    <StatTile
                      label="Min"
                      value={stats[0]?.min === undefined ? null : formatTick(stats[0].min)}
                      unit={stats[0]?.unit}
                    />
                    <StatTile
                      label="Max"
                      value={stats[0]?.max === undefined ? null : formatTick(stats[0].max)}
                      unit={stats[0]?.unit}
                    />
                  </>
                ) : (
                  // With several measures the useful summary is the latest of
                  // each, colour-keyed to its line — a combined min/max across
                  // different units would be meaningless.
                  stats.map((s) => (
                    <Pressable
                      key={s.label}
                      accessibilityRole="button"
                      accessibilityState={{ selected: focused.includes(s.label) }}
                      // The full name here: a screen reader has no width limit,
                      // and "Soil Temp" is a worse thing to hear than to read.
                      accessibilityLabel={`${s.label}. ${
                        focused.includes(s.label) ? 'Selected. Tap to remove' : 'Tap to compare'
                      }`}
                      onPress={() =>
                        setFocused((f) =>
                          f.includes(s.label) ? f.filter((x) => x !== s.label) : [...f, s.label],
                        )
                      }
                      // grow/basis rather than `flex: 1`: in a wrapping row a
                      // flexed child leaves the row's height uncomputed, and the
                      // tiles then bleed over the chart below them.
                      // `flex: 1` with `minWidth: 0` now that the row never
                      // wraps: the earlier flexGrow/flexBasis pair existed to
                      // keep a wrapping row's height computable, and with
                      // `nowrap` it would instead push the tiles past the edge.
                      style={{ flex: 1, minWidth: 0 }}
                    >
                      <StatTile
                        label={shortMeasureLabel(s.label)}
                        value={s.latest === null ? null : formatTick(s.latest)}
                        unit={s.unit}
                        accent={s.color}
                        selected={focused.includes(s.label)}
                        // The Pressable is the flex child now; the tile just
                        // fills it.
                        style={{ flex: 0, width: '100%' }}
                      />
                    </Pressable>
                  ))
                )}
              </View>

              <View
                style={{
                  flex: 1,
                  minHeight: 220,
                  paddingTop: spacing.lg,
                  paddingBottom: spacing.md,
                }}
                onLayout={(e) => setChartHeight(e.nativeEvent.layout.height)}
              >
                <LineChart
                  // Full date and time on the axis: a chart spanning 30 or 90
                  // days is ambiguous without the year. Daily buckets drop the
                  // time, which is always midnight and says nothing.
                  labels={axisLabels}
                  tooltipLabels={axisLabels}
                  series={shown}
                  // The wrapper's height comes from flex, not from this value,
                  // so feeding it back cannot start a measurement loop.
                  height={Math.max(200, chartHeight - spacing.lg - spacing.md)}
                />
              </View>
            </>
          ) : (
            <EmptyState
              title="No readings in this range"
              message={`Nothing recorded at ${site || 'this site'} between ${dateFrom} and ${dateTo}. Try a wider range or a different sensor.`}
            />
          )}
        </Card>
      ) : null}
    </ScrollView>
  );
}
