import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import Constants from 'expo-constants';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  Button,
  Card,
  Field,
  SectionTitle,
  SelectField,
  StatusChip,
} from '../components/ui';
import { Skeleton } from '../components/Skeleton';
import { PoweredBy } from '../components/PoweredBy';
import { goToRouteHistory } from '../navigation/ref';
import { TTL_REFERENCE, cacheKey } from '../api/cache';
import { normaliseBaseUrl } from '../api/client';
import { getServerVersions, getUserRoles } from '../api/endpoints';
import { useAuth } from '../context/AuthContext';
import { useDashboard } from '../context/DashboardContext';
import { useQuery } from '../hooks/useQuery';
import { autoCheckForUpdate, checkForUpdate, UPDATE_ERRORS } from '../api/updates';
import { RELEASES_URL } from '../config';
import { formatOffset, offsetOptions } from '../utils/timezone';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';

const PRIVILEGED_ROLE = 'System Manager';

/** The running build, as stamped into app.json by the release workflow. */
const APP_VERSION = Constants.expoConfig?.version ?? null;

/** Apps worth naming on this screen, in the order they matter here. */
const SHOWN_APPS = [
  ['upande_sensors', 'Upande Sensors'],
  ['erpnext', 'ERPNext'],
  ['frappe', 'Frappe'],
];

function Row({ label, value, muted }) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: spacing.lg,
        paddingVertical: spacing.sm,
      }}
    >
      <Text style={[type.body, { color: t.textSecondary }]}>{label}</Text>
      <Text
        numberOfLines={1}
        style={[
          type.body,
          {
            color: muted ? t.textMuted : t.textPrimary,
            fontWeight: '600', fontFamily: font('600'),
            flexShrink: 1,
            textAlign: 'right',
            fontVariant: ['tabular-nums'],
          },
        ]}
      >
        {value ?? '—'}
      </Text>
    </View>
  );
}

export function SettingsScreen() {
  const t = useTheme();
  const { user, baseUrl, changeServer, biometrics, setBiometricEnabled } = useAuth();
  const { timezone, setTimezoneMode } = useDashboard();

  const [draftUrl, setDraftUrl] = useState(baseUrl);
  const [switching, setSwitching] = useState(false);
  const [togglingBio, setTogglingBio] = useState(false);
  const [editingServer, setEditingServer] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [update, setUpdate] = useState(null);
  const [updateError, setUpdateError] = useState(null);

  const roles = useQuery(
    user?.name ? cacheKey('user_roles', { user: user.name }) : null,
    () => getUserRoles(user?.name),
    { ttl: TTL_REFERENCE },
  );

  const versions = useQuery(cacheKey('server_versions'), () => getServerVersions(), {
    ttl: TTL_REFERENCE,
  });

  const isSystemManager = useMemo(
    () => (Array.isArray(roles.data) ? roles.data : []).includes(PRIVILEGED_ROLE),
    [roles.data],
  );

  const onToggleBiometrics = async (next) => {
    setTogglingBio(true);
    const ok = await setBiometricEnabled(next);
    setTogglingBio(false);
    if (next && !ok) {
      Alert.alert(
        'Not enabled',
        `${biometrics.label} sign-in was not turned on — the check wasn’t completed.`,
      );
    }
  };

  const confirmSwitch = () => {
    const target = normaliseBaseUrl(draftUrl);
    if (target === baseUrl) {
      setEditingServer(false);
      return;
    }
    Alert.alert('Switch server?', `Connect to ${target} and log out?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Switch',
        style: 'destructive',
        onPress: async () => {
          setSwitching(true);
          try {
            await changeServer(target);
          } finally {
            setSwitching(false);
          }
        },
      },
    ]);
  };


  // Silent, throttled to once a day, and never surfaces an error: this runs
  // because the screen opened, not because anyone asked.
  useEffect(() => {
    let cancelled = false;
    autoCheckForUpdate(APP_VERSION).then((result) => {
      if (!cancelled && result) setUpdate((current) => current ?? result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onCheckUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateError(null);
    try {
      setUpdate(await checkForUpdate(APP_VERSION));
    } catch (err) {
      setUpdate(null);
      setUpdateError({
        kind: err?.kind ?? UPDATE_ERRORS.FAILED,
        message: err?.message ?? 'The check could not be completed.',
      });
    } finally {
      setCheckingUpdate(false);
    }
  };

  /**
   * Hands off to the browser rather than installing in-app: an in-app installer
   * needs the REQUEST_INSTALL_PACKAGES permission and a new native dependency,
   * and would not work at all under Expo Go. The browser download ends in the
   * same Android install prompt.
   */
  const openUpdate = async (url) => {
    const target = url || RELEASES_URL;
    const ok = await Linking.canOpenURL(target).catch(() => false);
    if (!ok) {
      Alert.alert('Cannot open link', `Open this address in a browser:\n\n${target}`);
      return;
    }
    await Linking.openURL(target);
  };

  const appVersions = useMemo(() => {
    const data = versions.data;
    if (!data || typeof data !== 'object') return [];
    return SHOWN_APPS.filter(([key]) => data[key]).map(([key, label]) => ({
      label,
      version: data[key].version || '—',
    }));
  }, [versions.data]);

  const tzSource =
    timezone.source === 'server'
      ? `From server${timezone.zoneName ? ` · ${timezone.zoneName}` : ''}`
      : timezone.source === 'manual'
        ? 'Set manually'
        : `From this phone${timezone.zoneName ? ` · ${timezone.zoneName}` : ''}`;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      keyboardShouldPersistTaps="handled"
    >
      <Card style={{ marginBottom: spacing.xl }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <View
            style={{
              width: 44,
              height: 44,
              borderRadius: radius.pill,
              backgroundColor: t.accentSoft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="person" size={22} color={t.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={[type.heading, { color: t.textPrimary }]}>
              {user?.fullName || user?.name}
            </Text>
            <Text numberOfLines={1} style={[type.caption, { color: t.textMuted, marginTop: 2 }]}>
              {baseUrl?.replace(/^https?:\/\//, '')}
            </Text>
          </View>
          {roles.loading ? (
            <Skeleton width={70} height={20} />
          ) : isSystemManager ? (
            <StatusChip tone="good" label="Admin" />
          ) : null}
        </View>
      </Card>

      <SectionTitle>Security</SectionTitle>
      <Card style={{ marginBottom: spacing.xl }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <Ionicons
            name={biometrics.icon}
            size={22}
            color={biometrics.available ? t.accent : t.textMuted}
          />
          <View style={{ flex: 1 }}>
            <Text style={[type.body, { color: t.textPrimary, fontWeight: '600', fontFamily: font('600') }]}>
              {biometrics.label} sign-in
            </Text>
            <Text style={[type.caption, { color: t.textSecondary, marginTop: 2, lineHeight: 16 }]}>
              {!biometrics.hasHardware
                ? 'No biometric hardware on this device.'
                : !biometrics.isEnrolled
                  ? 'Add a fingerprint or face in Android settings first.'
                  : biometrics.enabled
                    ? 'Stays available after logging out.'
                    : 'Sign in without typing your password.'}
            </Text>
          </View>
          <Switch
            value={biometrics.enabled}
            onValueChange={onToggleBiometrics}
            disabled={!biometrics.available || togglingBio}
            trackColor={{ false: t.surfaceSunken, true: t.accent }}
            thumbColor={t.surface}
          />
        </View>
      </Card>

      {/* Timezone decides whether a reading counts as stale, so it is a
          first-class setting rather than a build-time constant. */}
      <SectionTitle>Time zone</SectionTitle>
      <Card style={{ marginBottom: spacing.xl }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: spacing.md,
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={[type.body, { color: t.textPrimary, fontWeight: '600', fontFamily: font('600') }]}>
              Detect automatically
            </Text>
            <Text style={[type.caption, { color: t.textSecondary, marginTop: 2 }]}>{tzSource}</Text>
          </View>
          <Switch
            value={timezone.mode === 'auto'}
            onValueChange={(auto) => setTimezoneMode(auto ? 'auto' : 'manual', timezone.offsetMinutes)}
            trackColor={{ false: t.surfaceSunken, true: t.accent }}
            thumbColor={t.surface}
          />
        </View>

        {timezone.mode === 'manual' ? (
          <View style={{ marginTop: spacing.lg }}>
            <SelectField
              label="Offset from UTC"
              value={timezone.offsetMinutes}
              options={offsetOptions()}
              onChange={(v) => setTimezoneMode('manual', v)}
            />
          </View>
        ) : (
          <Row label="Applied to charts" value={formatOffset(timezone.offsetMinutes)} />
        )}
      </Card>

      {/* Open to everyone: the audit views inside are role-gated and say so,
          but raising an issue is not — hiding the entry would hide the only way
          to report a problem. */}
      <>
          <SectionTitle>{isSystemManager ? 'Activity' : 'Support'}</SectionTitle>
          <Card style={{ marginBottom: spacing.xl }}>
            <Pressable
              accessibilityRole="button"
              onPress={goToRouteHistory}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.md,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              {/* Named for what the account will actually find: an admin lands
                  on the audit views, everyone else on their own reports. A
                  label promising "app activity" to someone who cannot read it
                  would be a dead end. */}
              <Ionicons
                name={isSystemManager ? 'footsteps-outline' : 'alert-circle-outline'}
                size={22}
                color={t.accent}
              />
              <View style={{ flex: 1 }}>
                <Text style={[type.body, { color: t.textPrimary, fontWeight: '600', fontFamily: font('600') }]}>
                  {isSystemManager ? 'App activity' : 'Issues'}
                </Text>
                <Text style={[type.caption, { color: t.textSecondary, marginTop: 2 }]}>
                  {isSystemManager
                    ? 'Issues · sign-ins · screen visits'
                    : 'Problems and requests raised from the app'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={17} color={t.textMuted} />
            </Pressable>
          </Card>
      </>

      <SectionTitle>Server</SectionTitle>
      <Card style={{ marginBottom: spacing.xl }}>
        <Row label="Site" value={baseUrl?.replace(/^https?:\/\//, '')} />
        {versions.loading ? (
          <Skeleton height={16} style={{ marginTop: spacing.sm }} />
        ) : (
          appVersions.map((a) => <Row key={a.label} label={a.label} value={a.version} />)
        )}
        <Row label="App" value={Constants.expoConfig?.version} />

        {isSystemManager ? (
          editingServer ? (
            <View style={{ marginTop: spacing.md }}>
              <Field
                label="Site URL"
                value={draftUrl}
                onChangeText={setDraftUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Button
                  label="Cancel"
                  tone="ghost"
                  style={{ flex: 1 }}
                  onPress={() => setEditingServer(false)}
                />
                <Button
                  label="Save"
                  style={{ flex: 1 }}
                  onPress={confirmSwitch}
                  loading={switching}
                />
              </View>
            </View>
          ) : (
            <Button
              label="Change server"
              tone="ghost"
              style={{ marginTop: spacing.md }}
              onPress={() => {
                setDraftUrl(baseUrl);
                setEditingServer(true);
              }}
            />
          )
        ) : null}
      </Card>

      {/* Updates arrive as APKs on GitHub Releases, so the app has to tell
          people a new one exists — nothing else will. Checked on demand, never
          on a timer: GitHub allows 60 unauthenticated calls an hour per IP, and
          a whole office shares one. */}
      <SectionTitle>App updates</SectionTitle>
      <Card style={{ marginBottom: spacing.xl }}>
        <Row label="Installed" value={APP_VERSION} />

        {update ? (
          <>
            <Row
              label="Latest"
              value={update.version}
              muted={!update.available}
            />
            <Text
              style={[
                type.caption,
                {
                  color: update.available ? t.accent : t.textSecondary,
                  marginTop: spacing.xs,
                  lineHeight: 17,
                },
              ]}
            >
              {update.available
                ? `Version ${update.version} is available${update.size ? ` · ${update.size}` : ''}.`
                : 'You are on the latest version.'}
            </Text>

            {update.available && update.notes ? (
              <Text
                numberOfLines={6}
                style={[
                  type.caption,
                  { color: t.textMuted, marginTop: spacing.sm, lineHeight: 17 },
                ]}
              >
                {update.notes}
              </Text>
            ) : null}
          </>
        ) : null}

        {updateError ? (
          <Text
            style={[
              type.caption,
              {
                color:
                  updateError.kind === UPDATE_ERRORS.RATE_LIMITED
                    ? t.status.warning
                    : t.status.critical,
                marginTop: spacing.xs,
                lineHeight: 17,
              },
            ]}
          >
            {updateError.message}
            {updateError.kind === UPDATE_ERRORS.RATE_LIMITED
              ? ' The releases page still works.'
              : ''}
          </Text>
        ) : null}

        <Button
          label={checkingUpdate ? 'Checking…' : 'Check for updates'}
          tone="ghost"
          style={{ marginTop: spacing.md }}
          onPress={onCheckUpdate}
          loading={checkingUpdate}
        />

        {update?.available ? (
          <Button
            label={update.downloadUrl ? 'Download update' : 'Open release page'}
            style={{ marginTop: spacing.sm }}
            onPress={() => openUpdate(update.downloadUrl || update.pageUrl)}
          />
        ) : null}

        {updateError ? (
          <Button
            label="Open releases page"
            tone="ghost"
            style={{ marginTop: spacing.sm }}
            onPress={() => openUpdate(RELEASES_URL)}
          />
        ) : null}
      </Card>

      <PoweredBy style={{ marginTop: spacing.xl }} />

    </ScrollView>
  );
}
