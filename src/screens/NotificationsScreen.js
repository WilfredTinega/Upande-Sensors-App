import React, { useCallback, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from '@react-navigation/native';

import { Button, Card, EmptyState, ErrorView, SectionTitle, StatusChip } from '../components/ui';
import { SkeletonList } from '../components/Skeleton';
import { getAlerts } from '../api/endpoints';
import { useDashboard } from '../context/DashboardContext';
import { useNotifications } from '../context/NotificationsContext';
import { useUpdate } from '../context/UpdateContext';
import { goToAccount, goToLive } from '../navigation/ref';
import { useTheme, spacing, type } from '../hooks/useTheme';
import { font } from '../theme';
import { directionChip, groupAlertsByDay, isUnreadAlert } from '../utils/alerts';
import { relativeTime } from '../utils/dates';

/**
 * Every limit breach the account may see, newest first, reached from the bell
 * in the header.
 *
 * Not scoped by the selected site — that filter is about what the data screens
 * show, and a person responsible for three sites wants one list, not three
 * visits. Each row names its site for that reason, and tapping a row selects
 * that site before opening Live, so the reading behind the alert is the one on
 * screen when they arrive.
 *
 * The rows are the notifications themselves: `title` and `body` are the exact
 * text the server pushed, so someone who dismissed a banner finds the same
 * words here rather than a re-worded version of them.
 */

/** Rows per request. Thirty is a screenful and a half on a phone. */
const PAGE_SIZE = 30;
/** The window the empty state names. Matches the server's default. */
const SINCE_DAYS = 30;

/**
 * One alert. The unread dot is the ONLY thing that changes between read and
 * unread — no bold-versus-regular title, no tinted background — because the
 * title is already bold for every row and a second emphasis would fight it.
 */
function AlertRow({ row, unread, onPress, last }) {
  const t = useTheme();
  const chip = directionChip(row.direction);
  const when = relativeTime(row.creation);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${unread ? 'Unread. ' : ''}${row.title || 'Alert'}. Open live readings for ${row.site || 'this site'}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: spacing.sm,
        paddingVertical: spacing.md,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: t.border,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {/* Reserved whether or not it is drawn, so read and unread rows share
          one left edge and the titles line up down the list. */}
      <View style={{ width: 8, alignItems: 'center', paddingTop: 6 }}>
        {unread ? (
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.accent }} />
        ) : null}
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
          <Text
            numberOfLines={2}
            style={[type.body, { color: t.textPrimary, flex: 1, fontWeight: '700', fontFamily: font('700'), lineHeight: 20 }]}
          >
            {row.title || row.sensor_name || 'Limit alert'}
          </Text>
          <StatusChip tone={chip.tone} label={chip.label} />
        </View>
        {row.body ? (
          <Text style={[type.caption, { color: t.textSecondary, marginTop: 2, lineHeight: 17 }]}>
            {row.body}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: spacing.xs }}>
          <Ionicons name="location-outline" size={12} color={t.textMuted} />
          <Text numberOfLines={1} style={[type.caption, { color: t.textMuted, flexShrink: 1 }]}>
            {row.site || '—'}
          </Text>
          <Text style={[type.caption, { color: t.textMuted }]}>·</Text>
          <Text style={[type.caption, { color: t.textMuted }]}>{when || '—'}</Text>
        </View>
      </View>
    </Pressable>
  );
}

export function NotificationsScreen() {
  const t = useTheme();
  const { setSite } = useDashboard();
  const { markOpened } = useNotifications();
  const { available: updateAvailable, update } = useUpdate();

  /**
   * Hand-rolled paging rather than `useQuery`: that hook holds one payload per
   * key, and "Load more" needs the pages APPENDED, not swapped. `seq` guards
   * against a slow page landing after a refresh has replaced the list — the
   * same job `keyRef` does in the hook.
   */
  const [rows, setRows] = useState(null);
  const [total, setTotal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const seq = useRef(0);

  const load = useCallback(async (mode) => {
    seq.current += 1;
    const mine = seq.current;
    if (mode === 'refresh') setRefreshing(true);
    else if (mode === 'more') setLoadingMore(true);
    else setLoading(true);
    setError(null);

    const start = mode === 'more' ? rowsRef.current?.length || 0 : 0;
    try {
      const answer = await getAlerts({ sinceDays: SINCE_DAYS, start, pageLength: PAGE_SIZE });
      if (mine !== seq.current) return;
      const page = Array.isArray(answer?.rows) ? answer.rows : [];
      setRows((previous) => {
        if (mode !== 'more') return page;
        // A row raised between two pages shifts the offsets by one, so the
        // next page can begin with the last row of this one. Names are unique.
        const seen = new Set((previous || []).map((r) => r.name));
        return [...(previous || []), ...page.filter((r) => !r.name || !seen.has(r.name))];
      });
      const count = Number(answer?.total);
      setTotal(Number.isFinite(count) ? count : null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(err);
    } finally {
      if (mine === seq.current) {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    }
  }, []);

  /**
   * What counted as unread when the list came into view: the read cursor as
   * it stood BEFORE this visit moved it.
   *
   * Captured on every focus rather than once on mount — a tab screen stays
   * mounted after you leave it, so a mount effect would fire only the first
   * time and the badge would stop clearing. The markers are drawn against this
   * snapshot so the rows that were new when you arrived stay marked while you
   * read them; the context, meanwhile, already considers everything read, the
   * badge is zero, and the cursor is moving to the server's newest row.
   */
  const [threshold, setThreshold] = useState(null);
  useFocusEffect(
    useCallback(() => {
      setThreshold(markOpened());
      load(rowsRef.current ? 'refresh' : 'load');
    }, [markOpened, load]),
  );

  // A pull is "show me what is new", and reading it is reading it: the cursor
  // moves to whatever the server now has, and the markers keep the snapshot
  // from when the screen was opened so a row does not un-mark under a thumb.
  const pull = useCallback(() => {
    markOpened();
    load('refresh');
  }, [markOpened, load]);

  const open = useCallback(
    (row) => {
      if (row.site) setSite(row.site);
      goToLive();
    },
    [setSite],
  );

  const list = rows || [];
  const groups = groupAlertsByDay(list);
  const hasMore = total === null ? list.length > 0 && list.length % PAGE_SIZE === 0 : list.length < total;
  const unsupported = Boolean(error?.isMissingEndpoint);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={pull}
          tintColor={t.accent}
          colors={[t.accent]}
        />
      }
    >
      {/* A new build is the one thing here that does not come from the server,
          so it is drawn outside every branch below: it belongs in the list even
          while the alerts are still loading, have failed, or are unsupported —
          those are all reasons the rest of the screen says nothing, and none of
          them make the update less true. Tapping it opens Account, where the
          button that installs it lives. */}
      {updateAvailable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`App update available${update?.version ? `, version ${update.version}` : ''}`}
          onPress={goToAccount}
          style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1, marginBottom: spacing.md })}
        >
          <Card style={{ borderColor: t.accent }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <Ionicons name="arrow-down-circle-outline" size={22} color={t.accent} />
              <View style={{ flex: 1 }}>
                <Text style={[type.body, { color: t.textPrimary, fontWeight: '600', fontFamily: font('600') }]}>
                  App update available
                </Text>
                {update?.version ? (
                  <Text numberOfLines={1} style={[type.caption, { color: t.textSecondary, marginTop: 2 }]}>
                    {`Version ${update.version}`}
                  </Text>
                ) : null}
              </View>
              <Ionicons name="chevron-forward" size={17} color={t.textMuted} />
            </View>
          </Card>
        </Pressable>
      ) : null}

      {loading && !rows ? (
        <SkeletonList count={5} />
      ) : unsupported ? (
        // Not an error box: the app is fine, the server is older than it, and
        // the fix is on the server. Said in those words.
        <Card>
          <EmptyState
            title="Alerts need a newer server"
            message="This server's upande_sensors predates limit alerts. Once it is updated, breaches will be listed here."
          />
        </Card>
      ) : error && !list.length ? (
        <ErrorView error={error} onRetry={() => load('load')} />
      ) : !list.length ? null : (
        <>
          {groups.map((group) => (
            <View key={group.key} style={{ marginBottom: spacing.lg }}>
              <SectionTitle>{group.label}</SectionTitle>
              <Card>
                {group.rows.map((row, i) => (
                  <AlertRow
                    key={row.name || `${row.sensor_name}-${row.creation}-${i}`}
                    row={row}
                    unread={isUnreadAlert(row, threshold)}
                    onPress={() => open(row)}
                    last={i === group.rows.length - 1}
                  />
                ))}
              </Card>
            </View>
          ))}

          {/* A failed "Load more" reports itself under the rows it failed to
              extend, and leaves what did load on screen. */}
          {error ? (
            <Text style={[type.caption, { color: t.status.critical, marginBottom: spacing.sm, lineHeight: 17 }]}>
              More could not be loaded — {error.message}
            </Text>
          ) : null}

          {hasMore ? (
            <Button
              label={loadingMore ? 'Loading…' : 'Load more'}
              tone="ghost"
              compact
              loading={loadingMore}
              onPress={() => load('more')}
            />
          ) : (
            <Text style={[type.caption, { color: t.textMuted, textAlign: 'center' }]}>
              {list.length} alert{list.length === 1 ? '' : 's'} in the last {SINCE_DAYS} days
            </Text>
          )}
        </>
      )}
    </ScrollView>
  );
}
