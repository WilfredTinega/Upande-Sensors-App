import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, Switch, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import {
  Button,
  Card,
  Field,
  SectionTitle,
  StatusChip,
} from '../components/ui';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Skeleton } from '../components/Skeleton';
import { PoweredBy } from '../components/PoweredBy';
import { goToRouteHistory } from '../navigation/ref';
import { TTL_REFERENCE, cacheKey } from '../api/cache';
import { normaliseBaseUrl } from '../api/client';
import { getServerVersions, getUserRoles } from '../api/endpoints';
import { useAuth } from '../context/AuthContext';
import { useQuery } from '../hooks/useQuery';
import { UPDATE_ERRORS, formatBytes } from '../api/updates';
import { INSTALL_ERRORS, openUnknownAppSourcesSettings } from '../utils/installApk';
import { APP_VERSION, useUpdate } from '../context/UpdateContext';
import { RELEASES_URL } from '../config';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';

const PRIVILEGED_ROLE = 'System Manager';

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
  const { user, baseUrl, changeServer, biometrics, setBiometricEnabled, signOut } = useAuth();

  const [draftUrl, setDraftUrl] = useState(baseUrl);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [togglingBio, setTogglingBio] = useState(false);
  const [editingServer, setEditingServer] = useState(false);
  // Shared with the tab badge — the launch check has usually already run by the
  // time this screen opens, so the card renders populated rather than empty.
  const {
    update,
    checking: checkingUpdate,
    error: updateError,
    check: onCheckUpdate,
    // The download and the install belong to the provider, so they carry on
    // while this screen is closed and both paths report one state.
    downloading,
    progress,
    installError,
    install,
  } = useUpdate();

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


  /** Last resort, and the only route when a release has no APK attached. */
  const openInBrowser = async (url) => {
    const target = url || RELEASES_URL;
    const ok = await Linking.canOpenURL(target).catch(() => false);
    if (!ok) {
      Alert.alert('Cannot open link', `Open this address in a browser:\n\n${target}`);
      return;
    }
    await Linking.openURL(target);
  };

  /**
   * Download the APK and hand it straight to Android's installer.
   *
   * Falls back to the release page on failure rather than dead-ending: the
   * download can fail for reasons the user can work around in a browser (a
   * captive portal, a URL guessed from the atom feed that does not exist).
   */
  /**
   * Retry, essentially.
   *
   * The provider downloads and installs on its own as soon as it finds a
   * release, so by the time anyone reaches this button the attempt has usually
   * already been made. Pressing it repeats that attempt — for a first one that
   * was blocked by "Install unknown apps", or an installer the user dismissed.
   *
   * Only this path is allowed to raise an alert. A background attempt that
   * fails reports itself inline below instead, because interrupting someone with
   * a dialog about something they never asked for is worse than staying quiet.
   */
  const installUpdate = useCallback(async () => {
    if (!update?.downloadUrl) {
      await openInBrowser(update?.pageUrl);
      return;
    }
    const reached = await install(update, { auto: false });
    if (reached) return;

    // A blocked install is one toggle away from working, so send them there
    // rather than to a browser that would hit the same wall.
    const blocked = installError?.kind === INSTALL_ERRORS.BLOCKED;
    Alert.alert(
      'Update failed',
      installError?.message ?? 'The update could not be installed.',
      [
        { text: 'Cancel', style: 'cancel' },
        blocked
          ? { text: 'Open settings', onPress: () => openUnknownAppSourcesSettings().catch(() => {}) }
          : { text: 'Open in browser', onPress: () => openInBrowser(update?.pageUrl) },
      ],
    );
  }, [update, install, installError]);

  /**
   * The update button's whole story, in one string.
   *
   * Percentage and byte count both, because they answer different questions: a
   * percentage says how far along, the megabytes say whether it is moving at
   * all. Without a Content-Length there is no percentage to give, so the bytes
   * carry it alone rather than a bar sitting at zero.
   */
  const updateLabel = useMemo(() => {
    if (downloading) {
      const written = formatBytes(progress?.written) ?? '0.0 MB';
      const total = progress?.total ? formatBytes(progress.total) : null;
      if (progress?.fraction == null) {
        return total ? `Updating… ${written} of ${total}` : `Updating… ${written}`;
      }
      return `Updating ${Math.round(progress.fraction * 100)}% · ${written} of ${total}`;
    }
    if (checkingUpdate) return 'Checking…';
    if (update?.available) return `Update to ${update.version}`;
    return 'Check for updates';
  }, [downloading, progress, checkingUpdate, update?.available, update?.version]);

  /**
   * One button, three jobs, in the order they happen: check, then update, then
   * report progress.
   *
   * Two buttons meant the screen showed "Check for updates" next to "Update to
   * 1.0.5" — an invitation to look for something that had already been found.
   * With one, the control is only ever the next thing to do.
   */
  const onUpdatePress = useCallback(() => {
    if (downloading) return;
    if (update?.available) return installUpdate();
    return onCheckUpdate();
  }, [downloading, update?.available, installUpdate, onCheckUpdate]);

  const appVersions = useMemo(() => {
    const data = versions.data;
    if (!data || typeof data !== 'object') return [];
    return SHOWN_APPS.filter(([key]) => data[key]).map(([key, label]) => ({
      label,
      version: data[key].version || '—',
    }));
  }, [versions.data]);

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

      {/* No timezone card: the offset is resolved automatically — from the
          server when the account may read System Settings, otherwise from the
          phone. `setTimezoneMode` and the manual override still exist in
          DashboardContext and utils/timezone.js for when that needs exposing
          again; nothing here is the only caller of the resolution itself. */}

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
        <Row label="App" value={APP_VERSION} />

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

        {/* A background attempt reports itself here rather than in an alert.
            Left visible after a manual retry too — the alert is dismissed, and
            without this the screen would go back to looking as if all was
            well. */}
        {installError ? (
          <Text
            style={[
              type.caption,
              { color: t.status.critical, marginTop: spacing.xs, lineHeight: 17 },
            ]}
          >
            {installError.message}
          </Text>
        ) : null}

        {/*
            One control, carrying everything.

            It reads "Update" throughout — never "Install" or "Download", which
            describe the mechanism rather than what the user is doing — and the
            progress is on the button itself. The separate bar and byte line
            underneath are gone: three things reporting one download is two more
            than the screen needs, and the count belongs where the eye already
            is.
         */}
        <Button
          label={updateLabel}
          tone={update?.available || downloading ? 'accent' : 'ghost'}
          style={{ marginTop: spacing.md }}
          onPress={onUpdatePress}
          // The fill is the progress indicator. A spinner still covers the case
          // where the server sent no Content-Length and there is no fraction to
          // draw — "working, length unknown" is all that can honestly be said.
          progress={downloading ? progress?.fraction ?? null : null}
          loading={checkingUpdate || (downloading && progress?.fraction == null)}
          disabled={downloading}
        />

        {updateError ? (
          <Button
            label="Open releases page"
            tone="ghost"
            style={{ marginTop: spacing.sm }}
            onPress={() => openInBrowser(RELEASES_URL)}
          />
        ) : null}
      </Card>

      {/* Last on the screen, and the only destructive action on it.
          Ending the session belongs beside the account it belongs to, rather
          than in the tab bar where it used to sit one mis-tap away from the
          screens people use all day. */}
      <Card style={{ marginTop: spacing.xl }}>
        <Button label="Log out" tone="danger" onPress={() => setSignOutOpen(true)} />
      </Card>

      <PoweredBy style={{ marginTop: spacing.xl }} />

      {/* Confirmed, not immediate: a tap here ends the session, and the reverse
          costs a password. */}
      <ConfirmDialog
        visible={signOutOpen}
        title="Are you sure you want to log out?"
        confirmLabel="Yes"
        cancelLabel="No"
        destructive
        onCancel={() => setSignOutOpen(false)}
        onConfirm={() => {
          setSignOutOpen(false);
          signOut();
        }}
      />
    </ScrollView>
  );
}
