import { useEffect } from 'react';

import { INSTALL_REASONS, reportInstall } from '../api/install';
import {
  installForegroundHandler,
  registerForPushNotifications,
  watchNotificationTaps,
} from '../api/push';
import { useAuth } from '../context/AuthContext';
import { useDashboard } from '../context/DashboardContext';
import { APP_VERSION } from '../context/UpdateContext';
import { goToLive } from '../navigation/ref';

/**
 * Wires push notifications to the signed-in session. Renders nothing.
 *
 * A component rather than an effect in `SignedInApp` because the tap handler
 * needs `setSite` from `DashboardContext`, and `SignedInApp` is the thing that
 * *renders* that provider — it cannot read from it. Mounted inside the provider,
 * this can.
 *
 * Mounting is the trigger: this tree exists only while a session does, so a
 * fresh sign-in and a restored one on cold start both register the same way,
 * and unmounting (sign-out) is what `AuthContext.signOut` pairs with the
 * unregister call. Everything inside is failure-silent — see `api/push.js`.
 *
 * The device register (`api/install.js`) rides along here for the same reason:
 * both need a session, both are about *this phone*, and having one component
 * own "tell the server about this device" means there is a single place to look
 * when asking what the app reports about itself.
 */
export function PushRegistrar() {
  const { user } = useAuth();
  const { setSite } = useDashboard();

  // Re-run when the account changes — a different user on the same phone is a
  // different registration server-side.
  useEffect(() => {
    if (!user?.name) return;
    registerForPushNotifications({ appVersion: APP_VERSION });
  }, [user?.name]);

  // The launch half of the device register. Sign-ins report themselves from
  // `AuthContext`, where the authentication actually happens; this covers the
  // cold start that walked straight back into a live session without one.
  //
  // Not awaited and not chained to the push registration: the register is
  // bookkeeping, and nothing on screen waits for it. `reportInstall` itself
  // guarantees one launch report per cold start and at most one an hour per
  // account, so the account in the dependency list re-arms nothing — it is
  // passed so that a phone whose last report was somebody else's is not held
  // back by that hour.
  useEffect(() => {
    if (!user?.name) return;
    reportInstall({ appVersion: APP_VERSION, reason: INSTALL_REASONS.LAUNCH, user: user.name });
  }, [user?.name]);

  useEffect(() => {
    installForegroundHandler();
    // A tapped breach lands on the site it happened at, not whichever site was
    // last selected: the notification is about a place, and Live is where the
    // current reading for that place is.
    return watchNotificationTaps(({ site }) => {
      if (site) setSite(site);
      goToLive();
    });
  }, [setSite]);

  return null;
}
