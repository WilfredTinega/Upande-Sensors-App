import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  Button,
  Card,
  ChoiceButtons,
  EmptyState,
  ErrorView,
  SectionTitle,
  Segmented,
  StatTile,
  StatusChip,
} from '../components/ui';
import { SkeletonList, SkeletonStatTiles } from '../components/Skeleton';
import { BarList } from '../components/LineChart';
import { TTL_REFERENCE, TTL_SERIES, cacheKey, invalidate } from '../api/cache';
import {
  ISSUE_KINDS,
  firstAssignee,
  getUserFullNames,
  getUserRoles,
  getAuthActivity,
  getIssues,
  getRouteHistory,
  getRouteHistoryCount,
} from '../api/endpoints';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '@react-navigation/native';

import { useQuery } from '../hooks/useQuery';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { RANGES, fullTimestamp, rangeToDates, relativeTime } from '../utils/dates';
import { isMeasured } from '../utils/measures';
import { getRecordingStatus } from '../utils/routeHistory';

/** Issue lifecycle → chip tone. Anything unrecognised stays neutral. */
function statusTone(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'closed' || value === 'resolved') return 'good';
  if (value === 'replied' || value === 'paused') return 'warning';
  if (value === 'open') return 'serious';
  return 'warning';
}

const PAGE_SIZE = 50;
/** How often the issue list re-reads statuses while it is open. */
const ISSUE_POLL_MS = 60000;
/** Matches the endpoint default; used to detect a truncated login window. */
const LOGIN_CAP = 1000;

export function RouteHistoryScreen() {
  const t = useTheme();
  const { user } = useAuth();
  const navigation = useNavigation();
  const [rangeKey, setRangeKey] = useState('today');
  const [page, setPage] = useState(0);
  const [authPage, setAuthPage] = useState(0);
  const [view, setView] = useState('screens'); // screens | sessions
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);

  /** Which kind of report the list is filtered to. */
  const [kind, setKind] = useState('issue');
  /**
   * Only System Managers may read Route History and Activity Log, so those two
   * views are theirs alone. Everyone else gets Issues, which is about their own
   * reports rather than other people's activity.
   */
  const roles = useQuery(
    user?.name ? cacheKey('user_roles', { user: user.name }) : null,
    () => getUserRoles(user?.name),
    { ttl: TTL_REFERENCE },
  );
  const isSystemManager = useMemo(
    () => (Array.isArray(roles.data) ? roles.data : []).includes('System Manager'),
    [roles.data],
  );

  /** Whose screen visits to show; null is everyone. */
  // Named apart from `people` below, which is the per-person activity rollup.

  const { dateFrom, dateTo } = useMemo(() => rangeToDates(rangeKey), [rangeKey]);

  /**
   * Nothing to drain any more.
   *
   * Visits used to reach `Route History` only through Frappe's
   * `deferred_insert`, which parks them in Redis until a 15-minute cron
   * runs. So this screen asked the server to run that job, slept 1.5s for
   * the worker, then re-fetched everything it had just loaded: two extra
   * requests, a deliberate stall, and three duplicate reads every time it
   * opened.
   *
   * `upande_sensors_app.log_routes` writes the row before the request
   * returns, so the table is already current and the queries below are all
   * this screen needs.
   */

  // The page number belongs to a result set; changing the window invalidates it.
  useEffect(() => {
    setPage(0);
  }, [dateFrom, dateTo]);

  const auth = useQuery(
    cacheKey('auth_activity', { dateFrom, dateTo }),
    () => getAuthActivity({ dateFrom, dateTo, pageLength: LOGIN_CAP }),
    { ttl: TTL_SERIES },
  );

  const routesKey = cacheKey('route_history', {
    dateFrom,
    dateTo,
    start: page * PAGE_SIZE,
  });
  const routes = useQuery(
    routesKey,
    () =>
      getRouteHistory({
        dateFrom,
        dateTo,
        start: page * PAGE_SIZE,
        pageLength: PAGE_SIZE,
      }),
    { ttl: TTL_SERIES },
  );

  /**
   * Every visit in the window, for the per-person breakdown.
   *
   * Fetched only when the modal opens — it is a much larger pull than the
   * paged list, and most visits to this screen never need it. Capped, with the
   * cap disclosed rather than silently skewing the counts.
   */
  const AGG_CAP = 2000;
  const aggregate = useQuery(
    peopleOpen ? cacheKey('route_history_all', { dateFrom, dateTo }) : null,
    () => getRouteHistory({ dateFrom, dateTo, pageLength: AGG_CAP }),
    { ttl: TTL_SERIES },
  );

  /**
   * Re-read every minute while the list is on screen: the status of a report is
   * changed by whoever is working on it, not from here, so nothing else would
   * ever tell this screen it had moved on.
   */
  const issues = useQuery(
    view === 'issues' ? cacheKey('issues', { kind }) : null,
    () => getIssues({ kind, pageLength: 50 }),
    { ttl: TTL_SERIES, pollMs: ISSUE_POLL_MS },
  );

  const countKey = cacheKey('route_history_count', { dateFrom, dateTo });
  const count = useQuery(countKey, () => getRouteHistoryCount({ dateFrom, dateTo }), {
    ttl: TTL_SERIES,
  });

  // A new window starts at its first page rather than wherever the last one
  // was left.
  useEffect(() => setAuthPage(0), [dateFrom, dateTo]);

  const authRows = useMemo(() => (Array.isArray(auth.data) ? auth.data : []), [auth.data]);

  /**
   * Paged in the client, not the server.
   *
   * The whole window is already fetched — the tiles, the per-day bars and the
   * per-person breakdown are all computed across every event, so paging the
   * request would either break those figures or need a second query for them.
   * What this fixes is the rendering: a busy month put a thousand rows into one
   * scroll view.
   */
  const authPageCount = Math.max(1, Math.ceil(authRows.length / PAGE_SIZE));
  const authPageSafe = Math.min(authPage, authPageCount - 1);
  const authPageRows = useMemo(
    () => authRows.slice(authPageSafe * PAGE_SIZE, authPageSafe * PAGE_SIZE + PAGE_SIZE),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [auth.data, authPageSafe],
  );
  const loginsTruncated = authRows.length >= LOGIN_CAP;

  /** Successful sign-ins only — what the counts and the per-day bars mean. */
  const loginRows = useMemo(
    () => authRows.filter((r) => r.operation === 'Login' && (!r.status || r.status === 'Success')),
    [authRows],
  );

  /** Logins per calendar day, oldest first, with empty days left out. */
  const loginsByDay = useMemo(() => {
    const byDay = new Map();
    loginRows.forEach((row) => {
      const day = String(row.creation || '').slice(0, 10);
      if (!day) return;
      byDay.set(day, (byDay.get(day) || 0) + 1);
    });
    return [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, value]) => ({ label: day, value }));
  }, [loginRows]);

  const uniqueUsers = useMemo(
    () => new Set(loginRows.map((r) => r.user).filter(Boolean)).size,
    [loginRows],
  );

  const aggregateRows = useMemo(
    () => (Array.isArray(aggregate.data) ? aggregate.data : []),
    [aggregate.data],
  );
  const aggregateTruncated = aggregateRows.length >= AGG_CAP;

  /** One entry per person: sign-ins, total visits, and visits per screen. */
  const people = useMemo(() => {
    const byUser = new Map();
    const ensure = (u) => {
      if (!byUser.has(u)) byUser.set(u, { user: u, logins: 0, visits: 0, routes: new Map() });
      return byUser.get(u);
    };

    loginRows.forEach((r) => {
      if (r.user) ensure(r.user).logins += 1;
    });
    aggregateRows.forEach((r) => {
      if (!r.user) return;
      const entry = ensure(r.user);
      entry.visits += 1;
      const route = r.route || '—';
      entry.routes.set(route, (entry.routes.get(route) || 0) + 1);
    });

    return [...byUser.values()]
      .map((e) => ({
        ...e,
        routes: [...e.routes.entries()]
          .map(([route, count]) => ({ route, count }))
          .sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.visits - a.visits || b.logins - a.logins);
  }, [loginRows, aggregateRows]);

  const selected = people.find((p) => p.user === selectedUser) || null;

  // Declared above the lookup that reads it: a `const` named in a hook's
  // dependencies is evaluated during render, so a later declaration would put
  // it in the temporal dead zone.
  const routeRows = useMemo(() => (Array.isArray(routes.data) ? routes.data : []), [routes.data]);

  /**
   * Full names for the accounts on screen.
   *
   * Keyed on the actual set of accounts rather than on the filters, so paging
   * through one person's visits doesn't re-request a name already held, and the
   * lookup is skipped entirely when nothing new has appeared.
   */
  const shownUsers = useMemo(() => {
    const set = new Set();
    routeRows.forEach((r) => r.user && set.add(r.user));
    loginRows.forEach((r) => r.user && set.add(r.user));
    return [...set].sort();
  }, [routeRows, loginRows]);

  const names = useQuery(
    shownUsers.length ? cacheKey('user_full_names', { users: shownUsers.join(',') }) : null,
    () => getUserFullNames(shownUsers),
    { ttl: TTL_REFERENCE },
  );

  /**
   * "Wilfred Tinega · wilfred@upande.com", or just the id when there is no name
   * on the account — never a dangling separator.
   */
  const labelFor = useCallback(
    (user) => {
      const full = names.data?.[user];
      return full && full !== user ? `${full} · ${user}` : user;
    },
    [names.data],
  );

  const total = isMeasured(count.data) ? Number(count.data) : null;
  const lastPage = total === null ? null : Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  const from = routeRows.length ? page * PAGE_SIZE + 1 : 0;
  const to = page * PAGE_SIZE + routeRows.length;

  const refresh = useCallback(() => {
    invalidate('auth_activity');
    invalidate('route_history');
    auth.refresh();
    count.refresh();
    return routes.refresh();
  }, [auth, count, routes]);

  // Both doctypes grant read to System Manager only, so a refusal here is about
  // the role — not about there being no activity.
  const denied = routes.error?.isPermission || auth.error?.isPermission;

  const rangePicker = (
    <ChoiceButtons
      style={{ marginBottom: spacing.lg }}
      options={RANGES.map((r) => ({ label: r.label, value: r.key }))}
      value={rangeKey}
      onChange={setRangeKey}
    />
  );

  /**
   * Rendered into the header rather than the page, so the title and the switch
   * share a row. `setOptions` is how a screen contributes to its own header;
   * lifting `view` into a context purely for placement would be worse.
   */
  useEffect(() => {
    if (!roles.loading && !isSystemManager && view !== 'issues') setView('issues');
  }, [roles.loading, isSystemManager, view]);

  useLayoutEffect(() => {
    navigation.setOptions({
      // With one view there is nothing to switch between, so the control goes
      // rather than sitting there as a single dead tab.
      headerRight: isSystemManager
        ? () => (
            <View style={{ paddingRight: spacing.md, width: 214 }}>
              <Segmented
                compact
                options={[
                  { label: 'Screens', value: 'screens' },
                  { label: 'Sign-ins', value: 'sessions' },
                  { label: 'Issues', value: 'issues' },
                ]}
                value={view}
                onChange={setView}
              />
            </View>
          )
        : undefined,
    });
  }, [navigation, view, isSystemManager]);

  /** Sign-ins: counts, per-day volume, then the in/out trail. */
  const sessionsView = (
    <>
      <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md }}>
        <StatTile label="Sign-ins" value={loginRows.length} accent={t.series[0]} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${uniqueUsers} people. Opens the per-person breakdown`}
          onPress={() => {
            setSelectedUser(null);
            setPeopleOpen(true);
          }}
          style={({ pressed }) => ({ flex: 1, opacity: pressed ? 0.7 : 1 })}
        >
          <StatTile label="People ›" value={uniqueUsers} />
        </Pressable>
      </View>

      <Card style={{ marginBottom: spacing.lg }}>
        {loginsByDay.length ? (
          <>
            <BarList items={loginsByDay} />
            {loginsTruncated ? (
              <Text style={[type.caption, { color: t.status.serious, marginTop: spacing.md }]}>
                ▲ Counting stops at {LOGIN_CAP.toLocaleString()} events, so this window is
                incomplete. Narrow the range for exact figures.
              </Text>
            ) : null}
          </>
        ) : (
          <Text style={[type.caption, { color: t.textMuted }]}>
            No sign-ins recorded between {dateFrom} and {dateTo}.
          </Text>
        )}
      </Card>

      <SectionTitle hint={`${authRows.length} event${authRows.length === 1 ? '' : 's'}`}>
        In and out
      </SectionTitle>

      {authRows.length ? (
        <Card padded={false}>
          {authPageRows.map((row, i) => {
            const out = row.operation === 'Logout';
            const failed = row.status && row.status !== 'Success';
            return (
              <View
                key={row.name}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                  paddingHorizontal: spacing.lg,
                  paddingVertical: 10,
                  borderBottomWidth: i === authPageRows.length - 1 ? 0 : StyleSheet.hairlineWidth,
                  borderBottomColor: t.border,
                }}
              >
                {/* Direction carries an icon and a word, never colour alone —
                    and a failed attempt is named rather than counted as entry. */}
                <Ionicons
                  name={
                    failed ? 'close-circle-outline' : out ? 'log-out-outline' : 'log-in-outline'
                  }
                  size={18}
                  color={failed ? t.status.critical : out ? t.textMuted : t.status.good}
                />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={[type.body, { color: t.textPrimary }]}>
                    {labelFor(row.user)}
                  </Text>
                  <Text numberOfLines={1} style={[type.caption, { color: t.textMuted }]}>
                    {failed ? 'Failed sign-in' : out ? 'Signed out' : 'Signed in'}
                  </Text>
                </View>
                <Text style={[type.caption, { color: t.textSecondary, textAlign: 'right' }]}>
                  {relativeTime(row.creation) || fullTimestamp(row.creation)}
                </Text>
              </View>
            );
          })}

          {/* Only when there is more than one page: a pager under six rows is
              furniture. */}
          {authPageCount > 1 ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.sm,
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.md,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: t.border,
              }}
            >
              <Button
                label="Previous"
                tone="ghost"
                compact
                style={{ flex: 1 }}
                disabled={authPageSafe === 0}
                onPress={() => setAuthPage((p) => Math.max(0, p - 1))}
              />
              <Text
                style={[
                  type.caption,
                  { color: t.textSecondary, minWidth: 82, textAlign: 'center' },
                ]}
              >
                Page {authPageSafe + 1} of {authPageCount}
              </Text>
              <Button
                label="Next"
                tone="ghost"
                compact
                style={{ flex: 1 }}
                disabled={authPageSafe >= authPageCount - 1}
                onPress={() => setAuthPage((p) => p + 1)}
              />
            </View>
          ) : null}
        </Card>
      ) : (
        <EmptyState
          title="No sign-ins recorded"
          message={`Nothing between ${dateFrom} and ${dateTo}.`}
        />
      )}
    </>
  );

  /**
   * Issues: everything raised from the app, filtered by kind.
   *
   * No form here — reporting is the floating button, available from every
   * screen. Everything raised from the app is listed, not only your own: it is
   * how you find out a problem is already known.
   */
  const issuesView = (
    <>
      <Segmented
        style={{ marginBottom: spacing.lg }}
        options={ISSUE_KINDS.map((k) => ({ label: k.label, value: k.value }))}
        value={kind}
        onChange={setKind}
      />

      {issues.loading ? (
        <SkeletonList count={4} />
      ) : issues.error ? (
        issues.error.isPermission ? (
          <EmptyState
            title="Reports aren't visible to this account"
            message={
              'The Issue doctype grants read access to the Support Team role only. Ask an ' +
              'administrator to add that role if you need to track reports here.'
            }
          />
        ) : (
          <ErrorView error={issues.error} onRetry={() => issues.refresh()} />
        )
      ) : (issues.data || []).length ? (
        <Card padded={false}>
          {(issues.data || []).map((row, i) => {
            const assignee = firstAssignee(row);
            const mine = row.owner === user?.name;
            return (
              <View
                key={row.name}
                style={{
                  paddingHorizontal: spacing.lg,
                  paddingVertical: 12,
                  borderBottomWidth: i === issues.data.length - 1 ? 0 : StyleSheet.hairlineWidth,
                  borderBottomColor: t.border,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
                  <Text numberOfLines={2} style={[type.body, { color: t.textPrimary, flex: 1 }]}>
                    {row.subject}
                  </Text>
                  <Text style={[type.caption, { color: t.textSecondary }]}>
                    {relativeTime(row.creation) || fullTimestamp(row.creation)}
                  </Text>
                </View>

                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.sm,
                    marginTop: 4,
                  }}
                >
                  {/* Status is the point of this list: whether anyone has
                      picked the report up yet. Word and colour together. */}
                  <StatusChip tone={statusTone(row.status)} label={row.status || 'Open'} />
                  <Text numberOfLines={1} style={[type.caption, { color: t.textMuted, flex: 1 }]}>
                    {assignee
                      ? `Assigned to ${assignee}`
                      : mine
                        ? 'Raised by you · unassigned'
                        : `Raised by ${row.owner}`}
                  </Text>
                </View>
              </View>
            );
          })}
        </Card>
      ) : (
        <EmptyState
          title="Nothing here yet"
          message={`Nothing reported under ${
            ISSUE_KINDS.find((k) => k.value === kind)?.label.toLowerCase() || 'this kind'
          } yet. Use the ⓘ button on any screen to report one.`}
        />
      )}
    </>
  );

  /** Screens: the paged route-history list. */
  const recording = getRecordingStatus();

  const screensView = (
    <>
      {/* Whether this device is managing to record at all. Without it, an
          account whose sends are being refused looks identical to one that
          simply hasn't opened anything. */}
      {/* The fallback is not a failure, but it is the difference between a
          visit being a row now and being a row whenever the site's scheduler
          next runs — which on this instance is why entries stopped appearing.
          Naming the missing permission saves the search. */}
      {recording.directRefused ? (
        <Text
          style={[
            type.caption,
            { color: t.status.warning, marginBottom: spacing.sm, lineHeight: 16 },
          ]}
        >
          ▲ This account may not write route history directly, so visits go to the site queue and
          appear only when its scheduler runs. Grant create on Route History to fix it.
        </Text>
      ) : null}

      {recording.error ? (
        <Text
          style={[
            type.caption,
            { color: t.status.serious, marginBottom: spacing.sm, lineHeight: 16 },
          ]}
        >
          ▲ This device could not send {recording.pending} visit
          {recording.pending === 1 ? '' : 's'} — they are queued and will be retried.{' '}
          {recording.error}
        </Text>
      ) : recording.sentAt ? (
        <Text style={[type.caption, { color: t.textMuted, marginBottom: spacing.sm }]}>
          {/* Age computed against the device clock, not `relativeTime`: this
              timestamp is local, and that helper expects a server-timezone
              string — feeding it one would misreport the age. */}
          This device has sent {recording.sentCount} visit
          {recording.sentCount === 1 ? '' : 's'} · last{' '}
          {Math.max(0, Math.round((Date.now() - recording.sentAt) / 1000))}s ago
          {recording.pending ? ` · ${recording.pending} queued` : ''}
          {/* Which route is in use. On the fallback the rows only appear when
              the site's scheduler next runs, which is worth knowing before
              wondering where they went. */}
          {recording.via === 'queued' ? ' · via the site queue' : ''}
        </Text>
      ) : null}

      <SectionTitle
        hint={
          total === null
            ? `${routeRows.length} entries`
            : `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`
        }
      >
        Screen visits
      </SectionTitle>

      {routes.loading || routes.refreshing ? (
        <SkeletonList count={5} />
      ) : routes.error ? (
        <ErrorView error={routes.error} onRetry={refresh} />
      ) : routeRows.length ? (
        <Card padded={false}>
          {routeRows.map((row, i) => (
            <View
              key={row.name}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.md,
                paddingHorizontal: spacing.lg,
                paddingVertical: 10,
                borderBottomWidth: i === routeRows.length - 1 ? 0 : StyleSheet.hairlineWidth,
                borderBottomColor: t.border,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[type.body, { color: t.textPrimary }]}>
                  {row.route || '—'}
                </Text>
                <Text numberOfLines={1} style={[type.caption, { color: t.textMuted }]}>
                  {labelFor(row.user)}
                </Text>
              </View>
              <Text style={[type.caption, { color: t.textSecondary, textAlign: 'right' }]}>
                {relativeTime(row.creation) || fullTimestamp(row.creation)}
              </Text>
            </View>
          ))}
        </Card>
      ) : (
        <EmptyState
          title="No screen visits recorded"
          message={`Nothing between ${dateFrom} and ${dateTo}.`}
        />
      )}

      {routeRows.length ? (
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
            style={[type.caption, { color: t.textSecondary, minWidth: 82, textAlign: 'center' }]}
          >
            {lastPage === null ? `Page ${page + 1}` : `Page ${page + 1} of ${lastPage + 1}`}
          </Text>
          <Button
            label="Next"
            tone="ghost"
            compact
            style={{ flex: 1 }}
            disabled={lastPage === null ? routeRows.length < PAGE_SIZE : page >= lastPage}
            onPress={() => setPage((p) => p + 1)}
          />
        </View>
      ) : null}
    </>
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={
        <RefreshControl
          refreshing={routes.refreshing}
          onRefresh={refresh}
          tintColor={t.accent}
          colors={[t.accent]}
        />
      }
    >
      {roles.loading ? null : view === 'issues' ? null : rangePicker}

      {/* Until the roles come back it isn't known which view this account is
          allowed to land on, and rendering the default first shows a
          non-administrator a screen they are about to be moved off. */}
      {roles.loading ? (
        <SkeletonList count={5} />
      ) : view === 'issues' ? (
        issuesView
      ) : denied ? (
        <EmptyState
          title="Not available for this account"
          message={
            'Route History and Activity Log grant read access to System Manager accounts only. ' +
            'Ask an administrator if you need to review app activity.'
          }
        />
      ) : (
        <>
          {view === 'sessions' ? (
            auth.loading || auth.refreshing ? (
              <>
                <SkeletonStatTiles count={2} style={{ marginBottom: spacing.lg }} />
                <SkeletonList count={5} />
              </>
            ) : auth.error ? (
              <ErrorView error={auth.error} onRetry={refresh} />
            ) : (
              sessionsView
            )
          ) : (
            screensView
          )}
        </>
      )}

      <Modal
        visible={peopleOpen}
        transparent
        animationType="slide"
        onRequestClose={() => (selected ? setSelectedUser(null) : setPeopleOpen(false))}
      >
        <View style={{ flex: 1, backgroundColor: '#00000099', justifyContent: 'flex-end' }}>
          <View
            style={{
              backgroundColor: t.background,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              maxHeight: '85%',
              paddingBottom: spacing.xl,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.sm,
                paddingHorizontal: spacing.lg,
                paddingTop: spacing.lg,
                paddingBottom: spacing.md,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: t.border,
              }}
            >
              {selected ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Back to everyone"
                  onPress={() => setSelectedUser(null)}
                  hitSlop={10}
                >
                  <Ionicons name="chevron-back" size={22} color={t.textPrimary} />
                </Pressable>
              ) : null}

              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={[type.title, { color: t.textPrimary }]}>
                  {selected ? selected.user : 'People'}
                </Text>
                <Text style={[type.caption, { color: t.textMuted, marginTop: 2 }]}>
                  {selected
                    ? `${selected.logins} sign-in${selected.logins === 1 ? '' : 's'} · ${selected.visits} screen view${selected.visits === 1 ? '' : 's'}`
                    : `${dateFrom} to ${dateTo}`}
                </Text>
              </View>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close"
                onPress={() => setPeopleOpen(false)}
                hitSlop={10}
              >
                <Ionicons name="close" size={22} color={t.textMuted} />
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
              {aggregate.loading ? (
                <SkeletonList count={4} />
              ) : aggregate.error ? (
                <ErrorView error={aggregate.error} onRetry={() => aggregate.refresh()} />
              ) : selected ? (
                selected.routes.length ? (
                  <BarList
                    items={selected.routes.map((r) => ({ label: r.route, value: r.count }))}
                  />
                ) : (
                  <Text style={[type.caption, { color: t.textMuted }]}>
                    No screen views recorded for this person in this period.
                  </Text>
                )
              ) : people.length ? (
                people.map((person) => (
                  <Pressable
                    key={person.user}
                    accessibilityRole="button"
                    onPress={() => setSelectedUser(person.user)}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing.md,
                      paddingVertical: 12,
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: t.border,
                      backgroundColor: pressed ? t.surfaceSunken : 'transparent',
                    })}
                  >
                    <View
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: radius.pill,
                        backgroundColor: t.accentSoft,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Ionicons name="person" size={16} color={t.accent} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={[type.body, { color: t.textPrimary }]}>
                        {labelFor(person.user)}
                      </Text>
                      <Text style={[type.caption, { color: t.textMuted, marginTop: 1 }]}>
                        {person.logins} sign-in{person.logins === 1 ? '' : 's'} · {person.visits}{' '}
                        screen view{person.visits === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={t.textMuted} />
                  </Pressable>
                ))
              ) : (
                <Text style={[type.caption, { color: t.textMuted }]}>
                  Nobody used the app between {dateFrom} and {dateTo}.
                </Text>
              )}

              {aggregateTruncated ? (
                <Text
                  style={[
                    type.caption,
                    { color: t.status.serious, marginTop: spacing.lg, lineHeight: 16 },
                  ]}
                >
                  ▲ Counts cover the most recent {AGG_CAP.toLocaleString()} screen views in this
                  period, so totals may be understated. Narrow the period for exact figures.
                </Text>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}
