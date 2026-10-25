import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useIsFocused } from '@react-navigation/native';

import { Button, Card, EmptyState, ErrorView, StatusChip } from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SkeletonList } from '../components/Skeleton';
import { TTL_LIVE, cacheKey, invalidate } from '../api/cache';
import { getPumpAccess, listPumpSockets, switchPumpSocket } from '../api/endpoints';
import { useQuery } from '../hooks/useQuery';
import { useTheme, spacing, type } from '../hooks/useTheme';
import { font } from '../theme';
import { relativeTime } from '../utils/dates';

// Same pair the server treats as the pump tab (mobile.py PUMP_CONTROL_TABS):
// the seeded default is labelled "Irrigation Pump Control".
export const PUMP_CONTROL_SLUGS = ['irrigation-pump-control', 'pump-control'];

// A pending command is confirmed or timed out within ~30-60 s; polling faster
// than that while one is open is what makes the state flip feel live.
const POLL_MS = 10000;

function stateTone(state) {
  const s = String(state || '').toLowerCase();
  if (s === 'on') return 'good';
  if (s === 'off') return 'serious';
  return 'warning';
}

function SocketCard({ socket, canSwitch, busy, onSwitch }) {
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
  // Every pump the user may see, not just the dashboard's selected site: the
  // server already scopes by permitted sites, and a pump with no Sensor Site
  // would otherwise never appear. Each card names its site.
  const key = cacheKey('pump_sockets');
  const socketsQuery = useQuery(key, () => listPumpSockets(), {
    ttl: TTL_LIVE,
    pollMs: isFocused ? POLL_MS : 0,
  });

  const [busyName, setBusyName] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);
  // Spinner only for a user's pull, not for the silent 10 s poll.
  const [pulling, setPulling] = useState(false);
  // The command last sent, so a timeout or failure is reported instead of the
  // pending chip just vanishing with the state unchanged.
  const sentRef = useRef(null);

  const canSwitch = Boolean(accessQuery.data?.can_switch);
  const sockets = Array.isArray(socketsQuery.data) ? socketsQuery.data : [];

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

  useEffect(() => {
    const sent = sentRef.current;
    if (!sent || !Array.isArray(socketsQuery.data)) return;
    const row = socketsQuery.data.find((s) => s.name === sent.name);
    if (!row || row.pending) return;
    sentRef.current = null;
    const state = String(row.state || 'Unknown');
    if (state.toLowerCase() === sent.expected) {
      setNotice(`${row.socket_name || row.name} is ${state}.`);
    } else {
      setActionError(`${row.socket_name || row.name} did not confirm — still ${state}.`);
    }
  }, [socketsQuery.data]);

  const send = useCallback(async () => {
    const pick = confirm;
    setConfirm(null);
    if (!pick) return;
    setBusyName(pick.socket.name);
    setActionError(null);
    setNotice(null);
    try {
      await switchPumpSocket(pick.socket.name, pick.state);
      sentRef.current = { name: pick.socket.name, expected: pick.state };
    } catch (err) {
      setActionError(err?.message || String(err));
    } finally {
      setBusyName(null);
      refresh();
    }
  }, [confirm, refresh]);

  const error = socketsQuery.error;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={
        <RefreshControl
          refreshing={pulling}
          onRefresh={pull}
          tintColor={t.accent}
          colors={[t.accent]}
        />
      }
    >
      {actionError ? (
        <Text style={[type.caption, { color: t.status.critical, marginBottom: spacing.md }]}>{actionError}</Text>
      ) : null}
      {notice && !actionError ? (
        <Text style={[type.caption, { color: t.status.good, marginBottom: spacing.md }]}>{notice}</Text>
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
