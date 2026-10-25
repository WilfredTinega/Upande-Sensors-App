import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useIsFocused } from '@react-navigation/native';

import { Button, Card, EmptyState, ErrorView, StatusChip } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SkeletonList } from '../components/Skeleton';
import { TTL_LIVE, TTL_REFERENCE, cacheKey, invalidate } from '../api/cache';
import { getPumpAccess, getSession, listPumpSockets, switchPumpSocket } from '../api/endpoints';
import { subscribeToPumpUpdates } from '../api/realtime';
import { useQuery } from '../hooks/useQuery';
import { useTheme, spacing, type } from '../hooks/useTheme';
import { font } from '../theme';
import { relativeTime } from '../utils/dates';

// Same pair the server treats as the pump tab (mobile.py PUMP_CONTROL_TABS):
// the seeded default is labelled "Irrigation Pump Control".
export const PUMP_CONTROL_SLUGS = ['irrigation-pump-control', 'pump-control'];

// Live updates arrive over the socket; polling is the fallback for when it
// cannot connect — tight while a command waits for its ack, relaxed otherwise.
const POLL_MS = 10000;
const POLL_PENDING_MS = 3000;
/** How long the per-card "is On" / "did not confirm" line stays up. */
const OUTCOME_MS = 10000;

function stateTone(state) {
  const s = String(state || '').toLowerCase();
  if (s === 'on') return 'good';
  if (s === 'off') return 'serious';
  return 'warning';
}

function SocketCard({ socket, canSwitch, busy, outcome, onSwitch }) {
  const t = useTheme();
  const state = String(socket.state || 'Unknown');
  const isOn = state.toLowerCase() === 'on';
  const pending = socket.pending;
  const disabled = !canSwitch || !socket.enabled || Boolean(pending) || busy;

  return (
    <Card style={{ marginBottom: spacing.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <Ionicons name="power-outline" size={22} color={isOn ? t.status.good : t.textMuted} />
        <View style={{ flex: 1 }}>
          <Text style={[type.body, { color: t.textPrimary, fontWeight: '600', fontFamily: font('600') }]}>
            {socket.socket_name || socket.name}
          </Text>
          <Text numberOfLines={1} style={[type.caption, { color: t.textSecondary, marginTop: 2 }]}>
            {[socket.site, socket.last_uplink ? `seen ${relativeTime(socket.last_uplink)}` : 'no uplink yet']
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
        <StatusChip tone={stateTone(state)} label={pending ? `${pending.command} pending` : state} />
      </View>

      <View style={{ flexDirection: 'row', gap: spacing.lg, marginTop: spacing.md }}>
        <Text style={[type.caption, { color: t.textSecondary }]}>{`${socket.active_power ?? 0} W`}</Text>
        <Text style={[type.caption, { color: t.textSecondary }]}>{`${socket.voltage ?? 0} V`}</Text>
        <Text style={[type.caption, { color: t.textSecondary }]}>
          {`${socket.runtime_today_hours ?? 0} h today`}
        </Text>
      </View>

      {outcome ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.md }}>
          <Ionicons
            name={outcome.ok ? 'checkmark-circle-outline' : 'alert-circle-outline'}
            size={16}
            color={outcome.ok ? t.status.good : t.status.critical}
          />
          <Text style={[type.caption, { flex: 1, color: outcome.ok ? t.status.good : t.status.critical }]}>
            {outcome.text}
          </Text>
        </View>
      ) : null}

      {canSwitch ? (
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
          <Button
            label="On"
            compact
            style={{ flex: 1 }}
            disabled={disabled || isOn}
            loading={busy}
            onPress={() => onSwitch(socket, 'on')}
          />
          <Button
            label="Off"
            tone="danger"
            compact
            style={{ flex: 1 }}
            disabled={disabled || state.toLowerCase() === 'off'}
            onPress={() => onSwitch(socket, 'off')}
          />
        </View>
      ) : null}
    </Card>
  );
}

export function PumpControlScreen() {
  const t = useTheme();
  const isFocused = useIsFocused();

  const accessQuery = useQuery(cacheKey('pump_access'), () => getPumpAccess(), { ttl: TTL_LIVE });
  const sessionQuery = useQuery(cacheKey('pump_session'), () => getSession(), { ttl: TTL_REFERENCE });

  // Live updates pushed over the socket, laid over the last fetched list until
  // the next fetch brings the same state back.
  const [live, setLive] = useState({});
  // Every pump the user may see, not just the dashboard's selected site: the
  // server already scopes by permitted sites, and a pump with no Sensor Site
  // would otherwise never appear. Each card names its site.
  const key = cacheKey('pump_sockets');
  const [anyPending, setAnyPending] = useState(false);
  // Each fetch is stamped with when it STARTED, so a poll that was already in
  // flight can never undo a newer push or resolve a command sent after it.
  const socketsQuery = useQuery(key, () => {
    const at = Date.now();
    return listPumpSockets().then((rows) => ({ rows: Array.isArray(rows) ? rows : [], at }));
  }, {
    ttl: TTL_LIVE,
    pollMs: isFocused ? (anyPending ? POLL_PENDING_MS : POLL_MS) : 0,
  });

  const [busyName, setBusyName] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [outcomes, setOutcomes] = useState({});
  // Spinner only for a user's pull, not for the silent poll.
  const [pulling, setPulling] = useState(false);
  // Commands sent from this screen, so a timeout or failure is reported on the
  // card instead of the pending chip just vanishing with the state unchanged.
  const sentRef = useRef({});

  const canSwitch = Boolean(accessQuery.data?.can_switch);

  const fetchedAt = socketsQuery.data?.at || 0;
  // A fetch supersedes only the pushes that arrived before it started.
  useEffect(() => {
    setLive((prev) => {
      const kept = {};
      let changed = false;
      for (const [name, update] of Object.entries(prev)) {
        if (update._at > fetchedAt) kept[name] = update;
        else changed = true;
      }
      return changed ? kept : prev;
    });
  }, [fetchedAt]);

  const sockets = useMemo(() => {
    const rows = socketsQuery.data?.rows || [];
    return rows.map((row) =>
      live[row.name] ? { ...row, ...live[row.name] } : { ...row, _at: fetchedAt },
    );
  }, [socketsQuery.data, live, fetchedAt]);

  useEffect(() => {
    setAnyPending(sockets.some((s) => s.pending) || Object.keys(sentRef.current).length > 0);
  }, [sockets]);

  const names = useMemo(() => sockets.map((s) => s.name).sort().join('|'), [sockets]);
  const siteName = sessionQuery.data?.site_name || null;
  useEffect(() => {
    if (!isFocused || !names) return undefined;
    return subscribeToPumpUpdates(
      names.split('|'),
      (update) => setLive((prev) => ({ ...prev, [update.name]: { ...update, _at: Date.now() } })),
      { siteName },
    );
  }, [isFocused, names, siteName]);

  const setOutcome = useCallback((name, outcome) => {
    setOutcomes((prev) => ({ ...prev, [name]: outcome }));
    setTimeout(() => {
      setOutcomes((prev) => {
        if (prev[name] !== outcome) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }, OUTCOME_MS);
  }, []);

  // Resolve commands this screen sent once their pending clears — from a socket
  // push the instant the device acks, or from a poll.
  useEffect(() => {
    for (const row of sockets) {
      const sent = sentRef.current[row.name];
      // Only evidence gathered after the command went out counts.
      if (!sent || !(row._at > sent.at)) continue;
      const state = String(row.state || 'Unknown').toLowerCase();
      if (row.pending) {
        sent.seenPending = true;
        continue;
      }
      // Resolved once it has been seen pending and that has cleared — or the
      // ack beat every fetch and the state is already the one asked for.
      if (!sent.seenPending && state !== sent.expected) continue;
      delete sentRef.current[row.name];
      const label = row.socket_name || row.name;
      // A confirmed switch speaks for itself through the state chip; only a
      // failure gets a line in the card.
      if (state !== sent.expected) {
        setOutcome(row.name, { ok: false, text: `${label} did not confirm — still ${row.state || 'Unknown'}.` });
      }
    }
  }, [sockets, setOutcome]);

  const { refresh: refreshSockets } = socketsQuery;
  const { refresh: refreshAccess } = accessQuery;
  const refresh = useCallback(() => {
    invalidate(key);
    return Promise.all([refreshSockets(), refreshAccess()]);
  }, [key, refreshSockets, refreshAccess]);

  const pull = useCallback(async () => {
    setPulling(true);
    setActionError(null);
    try {
      await refresh();
    } finally {
      setPulling(false);
    }
  }, [refresh]);

  const send = useCallback(async () => {
    const pick = confirm;
    setConfirm(null);
    if (!pick) return;
    const name = pick.socket.name;
    setBusyName(name);
    setActionError(null);
    setOutcomes((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    // Recorded before the request so a fetch that starts while it is in flight
    // is already later than `at` and can observe the pending command.
    sentRef.current[name] = { expected: pick.state, at: Date.now(), seenPending: false };
    setAnyPending(true);
    try {
      await switchPumpSocket(name, pick.state);
    } catch (err) {
      delete sentRef.current[name];
      setOutcome(name, { ok: false, text: err?.message || String(err) });
    } finally {
      setBusyName(null);
      refresh();
    }
  }, [confirm, refresh, setOutcome]);

  const error = socketsQuery.error;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={
        <RefreshControl refreshing={pulling} onRefresh={pull} tintColor={t.accent} colors={[t.accent]} />
      }
    >
      {actionError ? (
        <Text style={[type.caption, { color: t.status.critical, marginBottom: spacing.md }]}>{actionError}</Text>
      ) : null}

      {socketsQuery.loading && !socketsQuery.data ? (
        <SkeletonList count={3} />
      ) : error && error.isMissingEndpoint ? (
        <Card>
          <EmptyState title="Pump control unavailable" message="This server does not have pump control installed." />
        </Card>
      ) : error && !sockets.length ? (
        <ErrorView error={error} onRetry={pull} />
      ) : !sockets.length ? (
        <Card>
          <EmptyState title="No pumps" message="No pumps connected." />
        </Card>
      ) : (
        sockets.map((socket) => (
          <SocketCard
            key={socket.name}
            socket={socket}
            canSwitch={canSwitch}
            busy={busyName === socket.name}
            outcome={outcomes[socket.name]}
            onSwitch={(s, state) => setConfirm({ socket: s, state })}
          />
        ))
      )}

      <ConfirmDialog
        visible={Boolean(confirm)}
        title={confirm ? `Turn ${confirm.state} ${confirm.socket.socket_name || confirm.socket.name}?` : ''}
        message="The pump changes state once the device confirms."
        confirmLabel={confirm ? `Turn ${confirm.state}` : 'Yes'}
        cancelLabel="Cancel"
        destructive={confirm?.state === 'off'}
        onConfirm={send}
        onCancel={() => setConfirm(null)}
      />
    </ScrollView>
  );
}
