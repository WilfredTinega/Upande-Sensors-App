import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as SecureStore from 'expo-secure-store';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';

import { Button, Card, EmptyState, ErrorView, SectionTitle, StatusChip } from '../components/ui';
import { SkeletonList } from '../components/Skeleton';
import { getAlerts } from '../api/endpoints';
import { useNotifications } from '../context/NotificationsContext';
import { useUpdate } from '../context/UpdateContext';
import { goToAccount } from '../navigation/ref';
import { useTheme, spacing, type } from '../hooks/useTheme';
import { font } from '../theme';
import { directionChip, groupAlertsBySite, isUnreadAlert } from '../utils/alerts';
import { fullTimestamp, relativeTime } from '../utils/dates';

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
/** Alerts opened in the message modal, so their unread dot stays off. */
const KEY_READ = 'upande_sensors_read_alerts';
/** Enough to cover the 30-day window many times over; oldest dropped first. */
const MAX_READ = 500;

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
      accessibilityLabel={`${unread ? 'Unread. ' : ''}${row.title || 'Alert'}. Open the alert message`}
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

function fmtNum(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : String(v);
}

/**
 * The full alert, read in place. A tapped notification is a message to READ —
 * opening Live instead dropped the reader on a screen that no longer showed
 * the breach once the reading moved on.
 */
function AlertModal({ row, onClose }) {
  const t = useTheme();
  if (!row) return null;
  const chip = directionChip(row.direction);
  const unit = row.unit || '';
  const details = [
    ['Site', row.site || '—'],
    ['Sensor', row.sensor_name || '—'],
    ['Measure', row.measure || '—'],
    ['Value', `${fmtNum(row.value)}${unit}`],
    ['Limit', `${fmtNum(row.limit_min)} – ${fmtNum(row.limit_max)}${unit}`],
    ['Reading time', fullTimestamp(row.reading_timestamp) || '—'],
    ['Alerted', fullTimestamp(row.creation) || '—'],
  ];
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          justifyContent: 'center',
          padding: spacing.lg,
          backgroundColor: t.mode === 'dark' ? 'rgba(0,0,0,0.65)' : 'rgba(0,0,0,0.4)',
        }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: t.surface,
            borderRadius: 12,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.border,
            padding: spacing.lg,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
            <Text style={[type.body, { flex: 1, color: t.textPrimary, fontWeight: '700', fontFamily: font('700'), lineHeight: 20 }]}>
              {row.title || row.sensor_name || 'Limit alert'}
            </Text>
            <StatusChip tone={chip.tone} label={chip.label} />
          </View>
          {row.body ? (
            <Text style={[type.body, { color: t.textSecondary, marginTop: spacing.sm, lineHeight: 20 }]}>{row.body}</Text>
          ) : null}
          <View style={{ marginTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.border }}>
            {details.map(([label, value]) => (
              <View key={label} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, paddingVertical: 6 }}>
                <Text style={[type.caption, { color: t.textMuted }]}>{label}</Text>
                <Text style={[type.caption, { color: t.textPrimary, flexShrink: 1, textAlign: 'right' }]}>{value}</Text>
              </View>
            ))}
          </View>
          <Button label="Close" tone="ghost" compact style={{ marginTop: spacing.md }} onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function NotificationsScreen() {
  const t = useTheme();
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
  const [selected, setSelected] = useState(null);
  useFocusEffect(
    useCallback(() => {
      setThreshold(markOpened());
      load(rowsRef.current ? 'refresh' : 'load');
      // Leaving the screen closes an open message, so it is not still up
      // (over another tab) the next time this one is visited.
      return () => setSelected(null);
    }, [markOpened, load]),
  );

  // A pull is "show me what is new", and reading it is reading it: the cursor
  // moves to whatever the server now has, and the markers keep the snapshot
  // from when the screen was opened so a row does not un-mark under a thumb.
  const pull = useCallback(() => {
    markOpened();
    load('refresh');
  }, [markOpened, load]);

  // Alerts opened in the modal are read from then on, whatever the cursor says.
  const [readNames, setReadNames] = useState(() => new Set());
  useEffect(() => {
    SecureStore.getItemAsync(KEY_READ)
      .then((raw) => {
        const names = JSON.parse(raw || '[]');
        if (Array.isArray(names)) setReadNames((prev) => new Set([...names, ...prev]));
      })
      .catch(() => {});
  }, []);
  const markRead = useCallback((name) => {
    if (!name) return;
    setReadNames((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev);
      next.add(name);
      const kept = [...next].slice(-MAX_READ);
      SecureStore.setItemAsync(KEY_READ, JSON.stringify(kept)).catch(() => {});
      return new Set(kept);
    });
  }, []);
  const open = useCallback(
    (row) => {
      setSelected(row);
      markRead(row?.name);
    },
    [markRead],
  );

  // A tapped push lands here with the alert's name; open it as soon as the list
  // that contains it has loaded, then drop the param so a later visit does not
  // reopen it.
  const route = useRoute();
  const navigation = useNavigation();
  const pushedAlert = route.params?.alert || null;
  // The rows on screen when the push arrived may predate the alert; the focus
  // refresh brings it. Give up only once a list loaded AFTER the tap lacks it.
  const staleRowsRef = useRef(undefined);
  useEffect(() => {
    if (!pushedAlert) {
      staleRowsRef.current = undefined;
      return;
    }
    if (staleRowsRef.current === undefined) staleRowsRef.current = rows;
    if (!rows) return;
    const hit = rows.find((r) => r.name === pushedAlert);
    if (hit) {
      setSelected(hit);
      markRead(hit.name);
    } else if (rows === staleRowsRef.current) {
      return; // still the pre-tap list; wait for the refresh
    }
    staleRowsRef.current = undefined;
    navigation.setParams({ alert: undefined });
  }, [pushedAlert, rows, navigation, markRead]);

  const list = rows || [];
  // Site is the first question a reader asks of a breach list ("where?"), so
  // the view is grouped by site, with unread sites first.
  const groups = groupAlertsBySite(list, threshold, readNames);
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
              {/* Site label on the left, unread tally on the right, in one
                  row. The tally is the one number worth reading before
                  deciding whether to expand mentally into the rows below. */}
              <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: spacing.xs }}>
                <SectionTitle>{group.label}</SectionTitle>
                <Text style={[type.caption, { color: group.unreadCount ? t.accent : t.textMuted }]}>
                  {group.unreadCount
                    ? `${group.unreadCount} unread · ${group.rows.length} total`
                    : `${group.rows.length} total`}
                </Text>
              </View>
              <Card>
                {group.rows.map((row, i) => (
                  <AlertRow
                    key={row.name || `${row.sensor_name}-${row.creation}-${i}`}
                    row={row}
                    unread={isUnreadAlert(row, threshold) && !readNames.has(row.name)}
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
      <AlertModal row={selected} onClose={() => setSelected(null)} />
    </ScrollView>
  );
}
