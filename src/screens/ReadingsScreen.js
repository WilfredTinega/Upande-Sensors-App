import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Button, Card, ChoiceButtons, EmptyState, ErrorView } from '../components/ui';
import { Skeleton, SkeletonList } from '../components/Skeleton';
import { formatTick } from '../components/LineChart';
import { TTL_SERIES, cacheKey, invalidate } from '../api/cache';
import { getSensorReadingCount, getSensorReadings } from '../api/endpoints';
import { useDashboard } from '../context/DashboardContext';
import { useQuery } from '../hooks/useQuery';
import { MAX_ROWS, exportReadingsToExcel } from '../utils/exportReadings';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';
import { RANGES, fullTimestamp, isStale, rangeToDates } from '../utils/dates';
import { isMeasured } from '../utils/measures';

const PAGE_SIZE = 50;

/**
 * Proportional columns rather than fixed widths, so the four fit any phone
 * without sideways scrolling. Long sensor names truncate with an ellipsis —
 * the trade for keeping the whole row visible at once.
 */
const COLS = { sensor: 2.6, type: 2.1, time: 3.3, value: 1.6 };

/** 12pt keeps four columns legible in portrait; 14 would force a scroll. */
const CELL_FONT = 12;

function HeaderCell({ flex, children, align = 'left' }) {
  const t = useTheme();
  return (
    <Text
      numberOfLines={1}
      style={[type.label, { color: t.textSecondary, flex, textAlign: align, paddingHorizontal: 2 }]}
    >
      {children}
    </Text>
  );
}

function Cell({ flex, children, align = 'left', muted, mono }) {
  const t = useTheme();
  return (
    <Text
      numberOfLines={1}
      style={{
        flex,
        textAlign: align,
        paddingHorizontal: 2,
        fontSize: CELL_FONT,
        color: muted ? t.textMuted : t.textPrimary,
        fontVariant: mono ? ['tabular-nums'] : undefined,
      }}
    >
      {children}
    </Text>
  );
}

export function ReadingsScreen() {
  const t = useTheme();
  const { site, sitesLoading, sitesError, unitForType, filtersLocked, sitePending } =
    useDashboard();

  const [rangeKey, setRangeKey] = useState('today');
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportedRows, setExportedRows] = useState(0);

  const { dateFrom, dateTo } = useMemo(() => rangeToDates(rangeKey), [rangeKey]);

  const filters = useMemo(() => ({ site, dateFrom, dateTo }), [site, dateFrom, dateTo]);

  // Any filter change invalidates the page number — page 7 of the old result
  // set is meaningless against the new one.
  useEffect(() => {
    setPage(0);
  }, [site, dateFrom, dateTo]);

  const rowsKey = cacheKey('readings_page', { ...filters, start: page * PAGE_SIZE });
  const rows = useQuery(
    rowsKey,
    () => getSensorReadings({ ...filters, start: page * PAGE_SIZE, pageLength: PAGE_SIZE }),
    { ttl: TTL_SERIES },
  );

  // Counted separately from the page, so paging doesn't re-count the table.
  const countKey = cacheKey('readings_count', filters);
  const count = useQuery(countKey, () => getSensorReadingCount(filters), { ttl: TTL_SERIES });

  const data = Array.isArray(rows.data) ? rows.data : [];
  // A missing count is unknown, not zero — `Number(null)` would print "0
  // readings" over a table that has rows in it.
  const total = isMeasured(count.data) ? Number(count.data) : null;
  const lastPage = total === null ? null : Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  const from = data.length ? page * PAGE_SIZE + 1 : 0;
  const to = page * PAGE_SIZE + data.length;

  const refresh = useCallback(() => {
    if (rowsKey) invalidate(rowsKey);
    if (countKey) invalidate(countKey);
    count.refresh();
    return rows.refresh();
  }, [rowsKey, countKey, rows, count]);

  const runExport = async () => {
    setExporting(true);
    setExportedRows(0);
    try {
      const result = await exportReadingsToExcel(filters, { onProgress: setExportedRows });
      if (!result.rows) {
        Alert.alert('Nothing to export', 'No readings match the current filters.');
      } else if (result.truncated) {
        Alert.alert(
          'Export truncated',
          `The first ${result.rows.toLocaleString()} readings were exported — the limit is ` +
            `${MAX_ROWS.toLocaleString()} rows per file. Narrow the range to export the rest.`,
        );
      } else if (!result.shared) {
        Alert.alert(
          'Saved',
          `${result.rows.toLocaleString()} readings written to ${result.fileName}.`,
        );
      }
    } catch (err) {
      Alert.alert('Export failed', err?.message || 'The readings could not be exported.');
    } finally {
      setExporting(false);
    }
  };

  if (sitesError) return <ErrorView error={sitesError} onRetry={() => {}} />;

  // `sitePending` covers the gap after login where the site is still being
  // picked: no query has started, so nothing reports as loading.
  const showSkeleton = sitePending || sitesLoading || rows.loading || rows.refreshing;

  // Sensor Reading grants read to System Manager and Water Operator only, so a
  // refusal here is about the account's role, not about the data existing.
  const permissionDenied = rows.error?.isPermission;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={
        <RefreshControl
          refreshing={rows.refreshing}
          onRefresh={refresh}
          tintColor={t.accent}
          colors={[t.accent]}
        />
      }
    >
      {sitesLoading ? (
        <Skeleton height={38} radius={radius.pill} style={{ marginBottom: spacing.lg }} />
      ) : (
        <ChoiceButtons
          disabled={filtersLocked}
          style={{ marginBottom: spacing.lg }}
          options={RANGES.map((r) => ({ label: r.label, value: r.key }))}
          value={rangeKey}
          onChange={setRangeKey}
        />
      )}

      {permissionDenied ? (
        <EmptyState
          title="No access to raw readings"
          message={
            `${rows.error.message}\n\n` +
            'The Sensor Reading table grants read access to System Manager and Water Operator ' +
            'accounts only. Live and Dashboard work for every account — they reach the same ' +
            'data through the sensor API instead.'
          }
        />
      ) : !showSkeleton && rows.error ? (
        <ErrorView error={rows.error} onRetry={refresh} />
      ) : null}

      {showSkeleton ? <SkeletonList count={5} /> : null}

      {!showSkeleton && !rows.error ? (
        <>
          {/* Site name and row count on the left, export on the right — the
              export acts on this table, so it belongs at its head rather than
              below the pagination where it reads as a page-level action. */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-end',
              justifyContent: 'space-between',
              gap: spacing.md,
              marginBottom: spacing.sm,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text
                numberOfLines={1}
                style={[type.label, { color: t.textSecondary, textTransform: 'uppercase' }]}
              >
                {site || 'Readings'}
              </Text>
              <Text style={[type.caption, { color: t.textMuted, marginTop: 2 }]}>
                {total === null
                  ? `${data.length} row${data.length === 1 ? '' : 's'}`
                  : `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`}
              </Text>
            </View>

            {data.length ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Download readings for Excel"
                accessibilityState={{ busy: exporting }}
                onPress={runExport}
                disabled={exporting}
                hitSlop={6}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingVertical: 7,
                  paddingHorizontal: spacing.md,
                  borderRadius: radius.pill,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: t.borderStrong,
                  backgroundColor: t.surface,
                  opacity: exporting ? 0.6 : pressed ? 0.8 : 1,
                })}
              >
                {exporting ? (
                  <ActivityIndicator size="small" color={t.accent} />
                ) : (
                  <Ionicons name="download-outline" size={15} color={t.accent} />
                )}
                <Text
                  style={[
                    type.caption,
                    { color: t.textPrimary, fontWeight: '600', fontFamily: font('600') },
                  ]}
                >
                  {exporting ? `${exportedRows.toLocaleString()}…` : 'Excel'}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {data.length ? (
            <Card padded={false}>
              <View>
                <View
                  style={{
                    flexDirection: 'row',
                    paddingHorizontal: spacing.md,
                    paddingTop: spacing.lg,
                    paddingBottom: spacing.sm,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: t.borderStrong,
                  }}
                >
                  <HeaderCell flex={COLS.sensor}>Sensor</HeaderCell>
                  <HeaderCell flex={COLS.type}>Type</HeaderCell>
                  <HeaderCell flex={COLS.time}>Timestamp</HeaderCell>
                  <HeaderCell flex={COLS.value} align="right">
                    Value
                  </HeaderCell>
                </View>

                {data.map((row, i) => (
                  <View
                    key={row.name || `${row.timestamp}-${i}`}
                    style={{
                      flexDirection: 'row',
                      paddingHorizontal: spacing.md,
                      paddingVertical: 9,
                      backgroundColor: i % 2 ? t.surfaceSunken : 'transparent',
                    }}
                  >
                    <Cell flex={COLS.sensor}>{row.sensor_name || '—'}</Cell>
                    <Cell flex={COLS.type} muted>
                      {row.sensor_type || '—'}
                    </Cell>
                    <Cell flex={COLS.time} mono muted={isStale(row.timestamp)}>
                      {fullTimestamp(row.timestamp)}
                    </Cell>
                    <Cell flex={COLS.value} align="right" mono>
                      {isMeasured(row.value)
                        ? `${formatTick(Number(row.value))}${
                            unitForType(row.sensor_type) ? ` ${unitForType(row.sensor_type)}` : ''
                          }`
                        : '—'}
                    </Cell>
                  </View>
                ))}
              </View>
            </Card>
          ) : (
            <EmptyState
              title="No readings in this range"
              message={`Nothing recorded at ${site || 'any site'} between ${dateFrom} and ${dateTo}.`}
            />
          )}

          {data.length ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.sm,
                marginTop: spacing.lg,
              }}
            >
              <Button
                label="Previous"
                tone="ghost"
                compact
                style={{ flex: 1 }}
                disabled={page === 0}
                onPress={() => setPage((p) => Math.max(0, p - 1))}
              />
              <Text
                style={[
                  type.caption,
                  { color: t.textSecondary, minWidth: 82, textAlign: 'center' },
                ]}
              >
                {lastPage === null ? `Page ${page + 1}` : `Page ${page + 1} of ${lastPage + 1}`}
              </Text>
              <Button
                label="Next"
                tone="ghost"
                compact
                style={{ flex: 1 }}
                // With no total, fall back to "a full page came back, so there
                // may be more" rather than blocking at an unknown edge.
                disabled={lastPage === null ? data.length < PAGE_SIZE : page >= lastPage}
                onPress={() => setPage((p) => p + 1)}
              />
            </View>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
