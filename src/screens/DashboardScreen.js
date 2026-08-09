import React, { useCallback, useEffect, useMemo } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Card, EmptyState, ErrorView, StatusChip } from '../components/ui';
import { Skeleton, SkeletonSensorCard } from '../components/Skeleton';
import { formatTick } from '../components/LineChart';
import { TTL_LIVE, TTL_REFERENCE, invalidate } from '../api/cache';
import { liveKey, loadLiveValues, loadSiteSensors, sensorsKey, valuesKey } from '../api/liveSite';
import { useDashboard } from '../context/DashboardContext';
import { useQuery } from '../hooks/useQuery';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { isStale, relativeTime } from '../utils/dates';
import { sortByMeasure } from '../utils/measures';

/** One physical node, with every parameter it reports. */
function SensorCard({ sensor, live, unitForType, pending }) {
  const t = useTheme();
  const raw = live?.params?.length
    ? live.params
    : live
      ? [{ type: '', value: live.value, uom: live.uom, ts: live.ts }]
      : [];

  const params = useMemo(() => sortByMeasure(raw, (p) => p.type), [raw]);

  const latestTs = params.reduce((newest, p) => (p.ts > (newest || '') ? p.ts : newest), null);
  const stale = isStale(latestTs);

  return (
    <Card style={{ marginBottom: spacing.md }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm }}>
        <View style={{ flex: 1 }}>
          {/* No registry sensor_type line: a node reporting temperature,
              humidity and soil temperature carries a single type in the
              registry, so labelling this card "Humidity" contradicts the three
              measures listed right below it. Each value names its own measure. */}
          <Text numberOfLines={1} style={[type.heading, { color: t.textPrimary }]}>
            {sensor.sensor_name}
          </Text>
        </View>
        {params.length ? (
          <StatusChip
            tone={stale ? 'warning' : 'good'}
            label={
              stale
                ? `Stale · ${relativeTime(latestTs) || 'unknown'}`
                : relativeTime(latestTs) || 'Live'
            }
          />
        ) : pending ? (
          // The values are still on their way. Saying "No data" here would be
          // a claim about the sensor rather than about this request.
          <Skeleton width={64} height={20} radius={radius.pill} />
        ) : (
          <StatusChip tone="serious" label="No data" />
        )}
      </View>

      {!params.length && pending ? (
        <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
          <Skeleton height={14} width="55%" />
          <Skeleton height={14} width="40%" />
        </View>
      ) : null}

      {params.length ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: spacing.md,
            marginTop: spacing.md,
            paddingTop: spacing.md,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: t.border,
          }}
        >
          {params.map((param, i) => {
            const value = Number(param.value);
            // `get_live_readings` returns uom only on its Live Sensor Data
            // path; the Sensor Reading fallback sends "". Sensor Settings has
            // the unit either way.
            const unit = param.uom || unitForType(param.type) || unitForType(sensor.sensor_type);
            return (
              <View key={`${param.type || 'value'}-${i}`} style={{ minWidth: 76 }}>
                <Text style={[type.caption, { color: t.textSecondary }]}>
                  {param.type || 'Reading'}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 3 }}>
                  <Text
                    style={[
                      type.title,
                      { color: Number.isFinite(value) ? t.textPrimary : t.textMuted },
                    ]}
                  >
                    {Number.isFinite(value) ? formatTick(value) : '—'}
                  </Text>
                  {unit && Number.isFinite(value) ? (
                    <Text style={[type.caption, { color: t.textSecondary }]}>{unit}</Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </Card>
  );
}

/** Shared constants, so a pending query doesn't yield a new object per render. */
const EMPTY_SENSORS = [];
const EMPTY_LIVE = {};

export function DashboardScreen() {
  const t = useTheme();
  const { site, sitesLoading, sitesError, unitForType, setSensorCounts, sitePending } =
    useDashboard();

  /**
   * Asked for in two steps, and painted in two steps.
   *
   * The values cannot be requested until the sensor names are known, so this
   * screen always costs two sequential round trips — about a second each
   * against the cloud instance. Waiting for both before drawing anything made
   * the screen feel twice as slow as it needed to: the sensor cards can be on
   * screen after the first, with their values filling in after the second.
   *
   * Both use the keys the sign-in probe fills, so a site chosen at login
   * renders from cache instead of refetching what was just fetched.
   */
  const sensorList = useQuery(site ? sensorsKey(site) : null, () => loadSiteSensors(site), {
    ttl: TTL_REFERENCE,
  });

  const values = useQuery(
    site && sensorList.data?.length ? valuesKey(site) : null,
    () => loadLiveValues(site, sensorList.data),
    { ttl: TTL_LIVE },
  );

  /**
   * Stable empties.
   *
   * A `|| { sensors: [], live: {} }` fallback built a fresh object on every
   * render while the query was pending, so the counts memo below recomputed,
   * its effect published new counts to the context, that re-rendered this
   * screen, and round it went — "Maximum update depth exceeded".
   */
  const sensors = useMemo(
    () => (Array.isArray(sensorList.data) ? sensorList.data : EMPTY_SENSORS),
    [sensorList.data],
  );
  const live = useMemo(() => values.data || EMPTY_LIVE, [values.data]);

  /** Newest reading first; sensors with nothing to report sink to the bottom. */
  const orderedSensors = useMemo(() => {
    const latestOf = (sensor) => {
      const entry = live[sensor.sensor_name];
      const params = entry?.params?.length ? entry.params : entry ? [entry] : [];
      return params.reduce((newest, p) => (p.ts > (newest || '') ? p.ts : newest), '');
    };

    return [...sensors]
      .map((sensor) => ({ sensor, ts: latestOf(sensor) }))
      .sort((a, b) => {
        // Server timestamps are zero-padded, so a string compare orders them
        // correctly without parsing every row.
        if (a.ts && b.ts) return b.ts.localeCompare(a.ts);
        if (a.ts) return -1;
        if (b.ts) return 1;
        // Neither has reported: fall back to name so the tail has a stable
        // order instead of reshuffling on every refresh.
        return String(a.sensor.sensor_name || '').localeCompare(String(b.sensor.sensor_name || ''));
      })
      .map((x) => x.sensor);
  }, [sensors, live]);

  const counts = useMemo(() => {
    let reporting = 0;
    let stale = 0;
    sensors.forEach((s) => {
      const entry = live[s.sensor_name];
      const params = entry?.params?.length ? entry.params : entry ? [entry] : [];
      if (!params.length) return;
      reporting += 1;
      const latest = params.reduce((newest, p) => (p.ts > (newest || '') ? p.ts : newest), null);
      if (isStale(latest)) stale += 1;
    });
    // `live` counts sensors reporting inside the freshness window; `stale`
    // counts those reporting outside it. Sensors with no reading at all are in
    // `total` but neither of the other two, so the pair never overstates.
    return { total: sensors.length, live: reporting - stale, stale };
  }, [sensors, live]);

  /**
   * Pull-to-refresh shows skeletons too, not just the spinner: the rows are
   * about to be replaced, and leaving stale values on screen while new ones
   * load reads as if they were current. `sitePending` covers the gap after
   * login where the site is still being picked and no query has started.
   *
   * Declared here rather than below the effects that read it — a `const` named
   * in a dependency array is evaluated during render, so a later declaration
   * put it in the temporal dead zone and threw on every render.
   */
  const showSkeleton = sitePending || sitesLoading || sensorList.loading || sensorList.refreshing;

  /**
   * The cards are up but their readings aren't here yet. Distinct from
   * `showSkeleton`, which is the state where even the sensors are unknown.
   */
  const valuesPending = !showSkeleton && (values.loading || values.refreshing);

  // Either half failing leaves the screen unusable, and the sensor list failing
  // is the one that explains the most, so it is reported first.
  const liveError = sensorList.error || values.error;

  // Published for the header, which is rendered by the navigator and so cannot
  // reach this screen's state directly. Cleared on leaving, or the counts would
  // linger over Readings and Dashboard.
  useEffect(() => {
    setSensorCounts(showSkeleton ? null : counts);
  }, [counts, showSkeleton, setSensorCounts]);

  // Clearing belongs to unmount alone. As part of the effect above it fired on
  // every change, writing null and then the value — two context updates, and
  // a visible flicker in the header.
  useEffect(() => () => setSensorCounts(null), [setSensorCounts]);

  const refresh = useCallback(() => {
    if (!site) return Promise.resolve();
    // The values are what a refresh is for; the sensor list is near-static and
    // re-fetching it would double the cost of every pull.
    invalidate(valuesKey(site));
    invalidate(liveKey(site));
    return values.refresh();
  }, [site, values]);

  if (sitesError) return <ErrorView error={sitesError} onRetry={() => {}} />;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={
        <RefreshControl
          refreshing={values.refreshing}
          onRefresh={refresh}
          tintColor={t.accent}
          colors={[t.accent]}
        />
      }
    >
      {showSkeleton ? (
        <>
          <SkeletonSensorCard />
          <SkeletonSensorCard />
          <SkeletonSensorCard />
        </>
      ) : null}

      {/* `get_user_sites` treats "no Sensor Site permissions" as unrestricted
          and lists every site, but flow_plan's guard only exempts the literal
          Administrator — so a user with no permission rows gets a full site
          picker where every entry is refused. Naming the mismatch beats a
          generic red error box the user can do nothing with. */}
      {!showSkeleton && liveError?.isPermission ? (
        <EmptyState
          title="No access to this site"
          message={
            `${liveError.message}\n\n` +
            `Your account can see ${site || 'these sites'} in the list but isn't permitted to read ` +
            'sensors. Pick another site, or ask an administrator to add a Sensor Site ' +
            'permission for your user.'
          }
        />
      ) : !showSkeleton && liveError ? (
        <ErrorView error={liveError} onRetry={refresh} />
      ) : null}

      {!showSkeleton && !liveError && !sensors.length ? (
        <EmptyState
          title={site ? 'No sensors on this site' : 'No sensors found'}
          message={
            site
              ? 'Nothing is registered or reporting for the selected site yet.'
              : 'Nothing is registered or reporting on any site you can see.'
          }
        />
      ) : null}

      {!showSkeleton
        ? orderedSensors.map((sensor) => (
            <SensorCard
              key={sensor.sensor_name}
              sensor={sensor}
              live={live[sensor.sensor_name]}
              unitForType={unitForType}
              pending={valuesPending}
            />
          ))
        : null}
    </ScrollView>
  );
}
