import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Button, Field } from '../components/ui';
import { PoweredBy } from '../components/PoweredBy';
import { useAuth } from '../context/AuthContext';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';

export function LoginScreen() {
  const t = useTheme();
  const {
    signIn,
    error,
    clearError,
    biometrics,
    unlockWithBiometrics,
    setBiometricEnabled,
    baseUrl,
    setServerUrl,
  } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  // On a fresh install there is no site to sign in against, so the server form
  // is the first thing shown rather than a hidden escape hatch.
  const [serverOpen, setServerOpen] = useState(false);
  const needsServer = !baseUrl;
  const [draftUrl, setDraftUrl] = useState(baseUrl);
  const [usePassword, setUsePassword] = useState(false);

  /**
   * Keyboard handling, done by hand rather than with `KeyboardAvoidingView`.
   *
   * That component has no Android behaviour of its own — it defers to the
   * window being resized by the system, which does not happen under
   * edge-to-edge display. The keyboard then simply covers the password field.
   *
   * So: measure the keyboard, pad the scroll content by however much of it the
   * window did *not* absorb, and scroll the form up above it.
   */
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const { height: windowHeight, width: windowWidth } = useWindowDimensions();

  /**
   * The window height with no keyboard in it, used to tell a window the system
   * resized from one the keyboard is merely covering.
   *
   * Tracked as the tallest height seen at this width, not as "the height while
   * `keyboardHeight` is 0". Android resizes the window *before* it fires
   * `keyboardDidShow`, so there is a render where the window has already shrunk
   * and the keyboard is still reported as absent — sampling there recorded the
   * shrunken height as the full one, made the inset below the entire keyboard
   * height on a window that had already given up that space, and the resulting
   * double padding scrolled the fields off the top of the screen.
   *
   * Keyed on width so a rotation starts a fresh measurement rather than
   * comparing portrait against landscape.
   */
  /**
   * A window that hasn't been measured yet reports 0.
   *
   * It happens on the first frames of a cold start and while the activity is
   * being recreated. Recording a 0 as the baseline would make every later
   * height look like growth, and dividing the screen against it would produce an
   * inset for a screen that has no size — so nothing is recorded or padded until
   * there is a real measurement to work from.
   */
  const measured = windowWidth > 0 && windowHeight > 0;

  const baseline = useRef({ width: 0, height: 0 });
  if (measured) {
    if (baseline.current.width !== windowWidth) {
      baseline.current = { width: windowWidth, height: windowHeight };
    } else if (windowHeight > baseline.current.height) {
      baseline.current.height = windowHeight;
    }
  }

  // Only the part of the keyboard the window did not already absorb. Where the
  // system resizes, this is 0 and nothing is padded twice.
  const uncovered =
    measured && keyboardHeight > 0
      ? Math.max(0, keyboardHeight - Math.max(0, baseline.current.height - windowHeight))
      : 0;

  /**
   * Never give up more than half the window.
   *
   * A keyboard height arriving larger than the screen it is on — a stale report
   * across a rotation, a split-screen window — would otherwise pad the content
   * clean off the top, which is the failure this whole block exists to prevent.
   */
  const keyboardInset = measured ? Math.min(uncovered, Math.floor(windowHeight / 2)) : 0;

  useEffect(() => {
    // iOS reports before the animation so the layout moves with the keyboard;
    // Android only reports once it has finished appearing.
    const shown = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hidden = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const show = Keyboard.addListener(shown, (e) =>
      setKeyboardHeight(e?.endCoordinates?.height || 0),
    );
    const hide = Keyboard.addListener(hidden, () => setKeyboardHeight(0));

    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  /**
   * Nothing scrolls the view programmatically.
   *
   * Two attempts at `scrollToEnd` both ended with the fields pushed off the top
   * of the screen: the scroll compounds with whatever the system has already
   * done to the window, and the two differ by device. Instead the content is
   * anchored to the top while typing and the generous spacing tightens, so the
   * fields sit in the part of the screen the keyboard leaves — and because
   * nothing is moved for you, the view can still be scrolled by hand.
   */
  const keyboardUp = keyboardHeight > 0;

  /**
   * With a saved sign-in, the credential fields are hidden entirely — there is
   * nothing to type. `usePassword` is the deliberate way back to them: a wet or
   * unrecognised finger, or a need to sign in as someone else, must not leave
   * anyone stranded on a screen with one button that won't work.
   */
  const biometricOnly = biometrics.canUnlock && !usePassword && !serverOpen && !needsServer;

  // The restore pass settles `baseUrl` asynchronously, so this reacts to it
  // rather than seeding the initial state — on a cold start it is still empty
  // when this component first renders.
  useEffect(() => {
    if (needsServer) {
      setServerOpen(true);
      setDraftUrl('');
    }
  }, [needsServer]);

  const canSubmit =
    !needsServer && username.trim().length > 0 && password.length > 0 && !busy && !unlocking;

  // Offer the prompt straight away — making the user tap a button first would
  // be an extra step for the common case.
  const autoPrompted = useRef(false);
  useEffect(() => {
    if (!biometrics.canUnlock || autoPrompted.current) return;
    autoPrompted.current = true;
    setUnlocking(true);
    unlockWithBiometrics().finally(() => setUnlocking(false));
  }, [biometrics.canUnlock, unlockWithBiometrics]);

  const runUnlock = async () => {
    setUnlocking(true);
    await unlockWithBiometrics();
    setUnlocking(false);
  };

  const offerBiometrics = () => {
    Alert.alert(
      `Use ${biometrics.label.toLowerCase()} next time?`,
      'Your sign-in stays on this device and is unlocked with your ' +
        `${biometrics.label.toLowerCase()} instead of typing your password.`,
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Turn on', onPress: () => setBiometricEnabled(true) },
      ],
    );
  };

  /**
   * Hidden server switch: long-press the logo.
   *
   * There is no role to check here — nobody is signed in yet — so this is a
   * deliberate escape hatch rather than a gated control. Keeping it behind a
   * long press means a field user cannot repoint the app by mistake, while an
   * installer setting up a new site still has a way in without a rebuild.
   */
  const openServerEditor = () => {
    setDraftUrl(baseUrl);
    setServerOpen(true);
  };

  const saveServer = async () => {
    const target = draftUrl.trim();
    if (!target) return;
    const firstRun = needsServer;
    const saved = await setServerUrl(target);
    setServerOpen(false);
    setPassword('');
    // On first run the form giving way to the login fields is feedback enough;
    // an alert confirming a change nobody made reads as an error.
    if (!firstRun) {
      Alert.alert('Server updated', `The app will sign in against ${saved}.`);
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    const ok = await signIn({ username, password });
    setBusy(false);
    if (ok && biometrics.available && !biometrics.enabled) offerBiometrics();
  };

  const errorBanner = error ? (
    <View
      style={{
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.status.critical,
        backgroundColor: t.surface,
        borderRadius: radius.md,
        padding: spacing.md,
        marginBottom: spacing.lg,
        flexDirection: 'row',
        gap: spacing.sm,
      }}
    >
      <Text style={{ color: t.status.critical, fontSize: 12, marginTop: 2 }}>■</Text>
      <Text style={[type.body, { color: t.textPrimary, flex: 1, lineHeight: 20 }]}>{error}</Text>
    </View>
  ) : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.background }} edges={['top', 'bottom']}>
      <ScrollView
        contentContainerStyle={{
          padding: spacing.xl,
          flexGrow: 1,
          // Centred while there is room; once the keyboard is up the form is
          // anchored to the top, where it is visible, rather than centred in a
          // box whose bottom half the keyboard is covering.
          justifyContent: keyboardUp ? 'flex-start' : 'center',
          paddingBottom: spacing.xl + keyboardInset,
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        <View
          style={{
            marginBottom: keyboardUp ? spacing.md : spacing.xxl,
            alignItems: 'center',
          }}
        >
          {/* Shown as supplied — it carries its own light disc, so it needs
                no tile behind it to stay legible on the dark theme. It stays
                put while typing; only the space around it tightens. */}
          <Pressable
            onLongPress={openServerEditor}
            delayLongPress={700}
            accessibilityRole="image"
            accessibilityLabel="Upande"
            accessibilityHint="Long press to change the server address"
            style={({ pressed }) => ({
              marginBottom: keyboardUp ? spacing.md : spacing.lg,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Image
              source={require('../../assets/upande-logo.png')}
              style={{ width: 76, height: 76 }}
              resizeMode="contain"
            />
          </Pressable>
          <Text style={[type.display, { color: t.textPrimary, textAlign: 'center' }]}>
            Upande Sensors
          </Text>
          {biometricOnly && biometrics.lockedUser ? (
            <Text
              style={[
                type.body,
                {
                  color: t.textSecondary,
                  marginTop: spacing.sm,
                  textAlign: 'center',
                },
              ]}
            >
              {biometrics.lockedUser}
            </Text>
          ) : null}
        </View>

        {serverOpen ? (
          <View
            style={{
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: t.borderStrong,
              backgroundColor: t.surface,
              borderRadius: radius.md,
              padding: spacing.lg,
              marginBottom: spacing.lg,
            }}
          >
            <Field
              label="Site URL"
              value={draftUrl}
              onChangeText={setDraftUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="your-site.example.com"
            />

            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              {/* No Cancel on a fresh install: there is nothing to go back to,
                  and a dismissable form would strand the user on a login screen
                  that cannot reach any server. */}
              {needsServer ? null : (
                <Button
                  label="Cancel"
                  tone="ghost"
                  style={{ flex: 1 }}
                  onPress={() => setServerOpen(false)}
                />
              )}
              <Button
                label={needsServer ? 'Continue' : 'Save'}
                style={{ flex: 1 }}
                onPress={saveServer}
                disabled={!draftUrl.trim()}
              />
            </View>
          </View>
        ) : biometricOnly ? (
          <>
            {errorBanner}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Sign in with ${biometrics.label}`}
              onPress={runUnlock}
              disabled={unlocking}
              style={({ pressed }) => ({
                alignItems: 'center',
                justifyContent: 'center',
                gap: spacing.md,
                paddingVertical: spacing.xl,
                borderRadius: radius.lg,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: t.borderStrong,
                backgroundColor: t.surface,
                opacity: unlocking ? 0.6 : pressed ? 0.85 : 1,
              })}
            >
              <View
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: radius.pill,
                  backgroundColor: t.accentSoft,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Ionicons name={biometrics.icon} size={34} color={t.accent} />
              </View>
              <Text style={[type.heading, { color: t.textPrimary }]}>
                {unlocking ? 'Waiting…' : `Sign in with ${biometrics.label.toLowerCase()}`}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => {
                clearError();
                setUsePassword(true);
              }}
              style={{
                alignSelf: 'center',
                marginTop: spacing.lg,
                padding: spacing.sm,
              }}
            >
              <Text style={[type.body, { color: t.accent }]}>Use password instead</Text>
            </Pressable>
          </>
        ) : (
          /* The credential fields stay hidden while the server is being
               changed. Which instance those credentials go to is exactly what
               is in flux, and offering a Sign in button mid-edit invites
               sending a password to whichever server happened to be set. */
          <>
            <Field
              label="Email or username"
              value={username}
              onChangeText={(v) => {
                setUsername(v);
                if (error) clearError();
              }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="username"
              placeholder="you@upande.com"
              returnKeyType="next"
            />

            <Field
              label="Password"
              value={password}
              onChangeText={(v) => {
                setPassword(v);
                if (error) clearError();
              }}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="password"
              placeholder="••••••••"
              returnKeyType="go"
              onSubmitEditing={submit}
            />

            {errorBanner}

            <Button label="Sign in" onPress={submit} disabled={!canSubmit} loading={busy} />

            {biometrics.canUnlock ? (
              <Pressable
                onPress={() => {
                  clearError();
                  setUsePassword(false);
                }}
                style={{
                  alignSelf: 'center',
                  marginTop: spacing.lg,
                  padding: spacing.sm,
                }}
              >
                <Text style={[type.body, { color: t.accent }]}>
                  Use {biometrics.label.toLowerCase()} instead
                </Text>
              </Pressable>
            ) : null}
          </>
        )}

        <PoweredBy style={{ marginTop: spacing.xxl }} />
      </ScrollView>
    </SafeAreaView>
  );
}
