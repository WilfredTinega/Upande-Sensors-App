import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

import { client, normaliseBaseUrl, NO_BASE_URL, FrappeError } from '../api/client';
import { invalidate } from '../api/cache';
import { getBiometricCapability, promptBiometric } from '../utils/biometrics';
import { getUserProfile } from '../api/endpoints';
import { flushRouteHistory } from '../utils/routeHistory';

const KEY_SID = 'upande.sid';
const KEY_USER = 'upande.user';
const KEY_BASE_URL = 'upande.baseUrl';
const KEY_PASSWORD = 'upande.pwd';
const KEY_BIOMETRIC = 'upande.biometric';

const AuthContext = createContext(null);

/**
 * Session state for the whole app.
 *
 * The password is kept in the OS keystore (expo-secure-store) alongside the
 * sid. That is deliberate: Frappe session cookies expire server-side, and
 * without a stored password every expiry would dump a field user back at the
 * login form — often with no signal in an irrigation shed. The stored password
 * only ever leaves the keystore to re-run the same login the user already
 * performed, and `signOut` erases it.
 */
export function AuthProvider({ children }) {
  const [status, setStatus] = useState('restoring'); // restoring | signedOut | signedIn
  const [user, setUser] = useState(null);
  const [baseUrl, setBaseUrlState] = useState(NO_BASE_URL);
  const [error, setError] = useState(null);

  // What the hardware supports, whether the user turned it on, and whether
  // there is actually a stored credential for it to unlock.
  const [capability, setCapability] = useState(null);
  const [biometricEnabled, setBiometricEnabledState] = useState(false);
  const [lockedUser, setLockedUser] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getBiometricCapability().then((cap) => {
      if (!cancelled) setCapability(cap);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * End the session.
   *
   * With biometric sign-in enabled the saved credential is deliberately KEPT,
   * so the user can get back in with face or fingerprint instead of retyping a
   * password — logging out ends the session, it does not forget the device.
   * `forget: true` is the separate, explicit action that erases it.
   *
   * The distinction matters: "Log out" here does not mean "remove my password
   * from this phone", so the UI has to say so and offer the real erase.
   */
  /**
   * The user id the server knows, not the one that was typed.
   *
   * Signing in as "administrator" leaves Frappe's user as "Administrator", and
   * an email alias may differ again. Anything keyed on identity — which issues
   * are yours, who a report is assigned to — has to compare against the
   * server's value or it silently matches nothing. Falls back to the typed
   * name if the lookup fails; a wrong-case name is better than none.
   */
  const resolveUserName = useCallback(async (typed) => {
    try {
      const resolved = await client.whoAmI();
      return resolved && resolved !== 'Guest' ? resolved : typed;
    } catch {
      return typed;
    }
  }, []);

  const signOut = useCallback(async ({ remote = true, forget = false } = {}) => {
    /**
     * Last chance to deliver: after `logout()` the session is gone and any
     * visit still queued could only be sent as nobody. Failure here is
     * survivable — the queue is written to disk and goes out next sign-in.
     */
    await flushRouteHistory().catch(() => {});

    if (remote) await client.logout();
    else client.setSession(null);

    // Cached sites, tabs and readings belong to the session that just ended —
    // keeping them would show one user's sites to the next.
    invalidate();
    client.credentials = null;
    await SecureStore.deleteItemAsync(KEY_SID).catch(() => {});

    const storedBio = await SecureStore.getItemAsync(KEY_BIOMETRIC).catch(() => null);
    const keepForBiometrics = !forget && storedBio === '1';

    if (keepForBiometrics) {
      const storedUser = await SecureStore.getItemAsync(KEY_USER).catch(() => null);
      setUser(null);
      setLockedUser(storedUser || null);
      setStatus('signedOut');
      return;
    }

    await Promise.all([
      SecureStore.deleteItemAsync(KEY_USER).catch(() => {}),
      SecureStore.deleteItemAsync(KEY_PASSWORD).catch(() => {}),
      SecureStore.deleteItemAsync(KEY_BIOMETRIC).catch(() => {}),
    ]);
    setUser(null);
    setLockedUser(null);
    setBiometricEnabledState(false);
    setStatus('signedOut');
  }, []);

  /** Erase the saved credential outright. The honest "remove me" action. */
  const forgetDevice = useCallback(() => signOut({ forget: true }), [signOut]);

  // Restore a previous session on cold start.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [storedUrl, storedSid, storedUser, storedPwd, storedBio] = await Promise.all([
          SecureStore.getItemAsync(KEY_BASE_URL),
          SecureStore.getItemAsync(KEY_SID),
          SecureStore.getItemAsync(KEY_USER),
          SecureStore.getItemAsync(KEY_PASSWORD),
          SecureStore.getItemAsync(KEY_BIOMETRIC),
        ]);

        // Nothing stored means a fresh install: stay unconfigured so the login
        // screen asks for a site rather than guessing one.
        const url = normaliseBaseUrl(storedUrl);
        client.setBaseUrl(url);
        if (!cancelled) setBaseUrlState(url);

        const bioOn = storedBio === '1';
        if (!cancelled) setBiometricEnabledState(bioOn);

        // No live session, but a credential kept for biometric sign-in. This is
        // the state after logging out with biometrics on — offer the unlock
        // rather than a bare password form.
        if (!storedSid && storedUser && storedPwd && bioOn) {
          const cap = await getBiometricCapability();
          if (cancelled) return;
          setCapability(cap);
          if (cap.available) setLockedUser(storedUser);
          setStatus('signedOut');
          return;
        }

        if (!storedSid || !storedUser) {
          if (!cancelled) setStatus('signedOut');
          return;
        }

        // With biometrics on, a cold start must not walk straight into the app
        // — the whole point is that possession of the unlocked phone alone
        // isn't enough. Hold at the lock screen and let the user prove it.
        if (bioOn && storedPwd) {
          const cap = await getBiometricCapability();
          if (cancelled) return;
          setCapability(cap);
          if (cap.available) {
            setLockedUser(storedUser);
            setStatus('signedOut');
            return;
          }
          // Enrolment was removed since the toggle was set. Falling through to
          // a normal restore is the honest behaviour — the credential is still
          // there and we can no longer gate it, so don't pretend we can.
        }

        client.setSession(storedSid);
        if (storedPwd) client.credentials = { usr: storedUser, pwd: storedPwd };

        // Confirm the cookie is still live before showing signed-in UI —
        // otherwise the first screen renders and then immediately errors.
        try {
          const loggedIn = await client.whoAmI();
          if (cancelled) return;
          if (loggedIn && loggedIn !== 'Guest') {
            // `whoAmI` already answered, so use its value directly.
            setUser({ name: loggedIn, fullName: storedUser });
            setStatus('signedIn');
            return;
          }
        } catch {
          /* falls through to the stored-password retry below */
        }

        if (storedPwd) {
          try {
            const session = await client.login(storedUser, storedPwd);
            if (cancelled) return;
            await SecureStore.setItemAsync(KEY_SID, session.sid);
            setUser({ name: await resolveUserName(storedUser), fullName: session.fullName });
            setStatus('signedIn');
            return;
          } catch {
            /* credentials no longer valid — fall through to signed out */
          }
        }

        if (!cancelled) await signOut({ remote: false });
      } catch {
        if (!cancelled) setStatus('signedOut');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [signOut, resolveUserName]);

  /**
   * Fill in the display name and avatar once there is a session.
   *
   * Deliberately after sign-in rather than part of it: the app is fully usable
   * without either, so a slow or refused profile lookup must not delay entry.
   */
  useEffect(() => {
    if (status !== 'signedIn' || !user?.name || user.image !== undefined) return undefined;
    let cancelled = false;
    getUserProfile(user.name).then((profile) => {
      if (cancelled || !profile) return;
      setUser((current) =>
        current
          ? { ...current, fullName: profile.fullName || current.fullName, image: profile.image }
          : current,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [status, user?.name, user?.image]);

  // Any call that finds the session dead unwinds the whole app to the login
  // screen, so a stale session can never leave a screen half-usable.
  useEffect(() => {
    client.onSessionLost = () => {
      setStatus((current) => (current === 'signedIn' ? 'signedOut' : current));
    };
    return () => {
      client.onSessionLost = null;
    };
  }, []);

  const signIn = useCallback(
    async ({ username, password, siteUrl }) => {
      setError(null);
      const url = normaliseBaseUrl(siteUrl || baseUrl);
      client.setBaseUrl(url);

      try {
        const session = await client.login(username.trim(), password);
        await Promise.all([
          SecureStore.setItemAsync(KEY_BASE_URL, url),
          SecureStore.setItemAsync(KEY_SID, session.sid),
          SecureStore.setItemAsync(KEY_USER, username.trim()),
          SecureStore.setItemAsync(KEY_PASSWORD, password),
        ]);
        setBaseUrlState(url);
        const resolvedName = await resolveUserName(username.trim());
        setUser({ name: resolvedName, fullName: session.fullName });
        setLockedUser(null);
        setStatus('signedIn');
        return true;
      } catch (err) {
        const message =
          err instanceof FrappeError
            ? err.message
            : 'Could not sign in. Check the site URL and your connection.';
        setError(message);
        return false;
      }
    },
    [baseUrl, resolveUserName],
  );

  /**
   * Unlock a stored session with fingerprint / face.
   *
   * This is an unlock, not a login: it only works when a previous password
   * sign-in left a credential behind. After an explicit sign-out there is
   * nothing to unlock, which is why `signOut` clears the toggle too.
   */
  const unlockWithBiometrics = useCallback(async () => {
    setError(null);
    const cap = capability || (await getBiometricCapability());
    if (!cap.available) {
      setError('Biometric unlock isn’t available on this device.');
      return false;
    }

    const result = await promptBiometric('Unlock Upande Sensors');
    if (!result.success) {
      // A deliberate cancel is not an error — the user chose the password.
      if (!result.cancelled) setError('Biometric check failed. Use your password to sign in.');
      return false;
    }

    const [storedUser, storedPwd] = await Promise.all([
      SecureStore.getItemAsync(KEY_USER),
      SecureStore.getItemAsync(KEY_PASSWORD),
    ]);
    if (!storedUser || !storedPwd) {
      setError('No saved sign-in on this device. Enter your password once to set it up.');
      setLockedUser(null);
      return false;
    }

    try {
      const session = await client.login(storedUser, storedPwd);
      await SecureStore.setItemAsync(KEY_SID, session.sid);
      setUser({ name: await resolveUserName(storedUser), fullName: session.fullName });
      setLockedUser(null);
      setStatus('signedIn');
      return true;
    } catch (err) {
      setError(
        err instanceof FrappeError
          ? err.message
          : 'Saved sign-in no longer works. Enter your password.',
      );
      return false;
    }
  }, [capability]);

  /**
   * Turn biometric unlock on or off.
   *
   * Enabling requires passing the prompt first — otherwise someone holding an
   * already-unlocked phone could switch on a lock they can't themselves pass,
   * and the owner would be the one locked out.
   */
  const setBiometricEnabled = useCallback(
    async (enabled) => {
      if (!enabled) {
        await SecureStore.deleteItemAsync(KEY_BIOMETRIC).catch(() => {});
        setBiometricEnabledState(false);
        return true;
      }

      const cap = capability || (await getBiometricCapability());
      if (!cap.available) return false;

      const result = await promptBiometric('Confirm to enable biometric sign-in');
      if (!result.success) return false;

      await SecureStore.setItemAsync(KEY_BIOMETRIC, '1');
      setBiometricEnabledState(true);
      return true;
    },
    [capability],
  );

  /**
   * Set the server from the login screen, before anyone is authenticated.
   *
   * Unlike `changeServer` this does not sign anyone out — there is no session
   * yet. It does clear any saved credential, because a stored password belongs
   * to the site it was issued against: replaying it at a different instance
   * would send someone's password to a server they never gave it to.
   */
  const setServerUrl = useCallback(
    async (nextUrl) => {
      const url = normaliseBaseUrl(nextUrl);
      await SecureStore.setItemAsync(KEY_BASE_URL, url);
      client.setBaseUrl(url);
      setBaseUrlState(url);
      setError(null);

      if (url !== baseUrl) {
        await Promise.all([
          SecureStore.deleteItemAsync(KEY_SID).catch(() => {}),
          SecureStore.deleteItemAsync(KEY_USER).catch(() => {}),
          SecureStore.deleteItemAsync(KEY_PASSWORD).catch(() => {}),
          SecureStore.deleteItemAsync(KEY_BIOMETRIC).catch(() => {}),
        ]);
        invalidate();
        client.credentials = null;
        setLockedUser(null);
        setBiometricEnabledState(false);
      }
      return url;
    },
    [baseUrl],
  );

  /**
   * Point the app at a different ERPNext instance.
   *
   * A Frappe session belongs to one site, so there is no way to carry the
   * current login across — this necessarily signs the user out and returns them
   * to the login screen with the new URL already filled in. Saying so up front
   * beats silently dropping them at a login form with no explanation.
   */
  const changeServer = useCallback(
    async (nextUrl) => {
      const url = normaliseBaseUrl(nextUrl);
      await SecureStore.setItemAsync(KEY_BASE_URL, url);
      client.setBaseUrl(url);
      setBaseUrlState(url);
      await signOut();
      return url;
    },
    [signOut],
  );

  const biometrics = useMemo(
    () => ({
      available: !!capability?.available,
      hasHardware: !!capability?.hasHardware,
      isEnrolled: !!capability?.isEnrolled,
      label: capability?.label || 'Biometrics',
      icon: capability?.icon || 'finger-print-outline',
      enabled: biometricEnabled,
      // Only true when there is genuinely a credential behind the prompt, so
      // the unlock button is never offered as a dead end.
      canUnlock: !!lockedUser && !!capability?.available,
      lockedUser,
    }),
    [capability, biometricEnabled, lockedUser],
  );

  const value = useMemo(
    () => ({
      status,
      user,
      baseUrl,
      error,
      signIn,
      signOut,
      forgetDevice,
      changeServer,
      setServerUrl,
      biometrics,
      unlockWithBiometrics,
      setBiometricEnabled,
      clearError: () => setError(null),
    }),
    [
      status,
      user,
      baseUrl,
      error,
      signIn,
      signOut,
      forgetDevice,
      changeServer,
      setServerUrl,
      biometrics,
      unlockWithBiometrics,
      setBiometricEnabled,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
