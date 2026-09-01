/**
 * Deployment constants that are not worth a settings screen but must not be
 * buried in the middle of a component.
 */

import Constants from 'expo-constants';

/**
 * Where the app's timezone assumption lives: `src/utils/timezone.js`.
 *
 * It is resolved at runtime — from the server when the account may read System
 * Settings, otherwise from the phone, with a manual override in Account — so
 * there is deliberately no hardcoded offset constant here.
 */

/** A reading older than this is called out as stale rather than shown as live. */
export const STALE_AFTER_MINUTES = 120;

/**
 * Where released APKs come from. The CI pipeline publishes one GitHub Release
 * per merge to main, with the APK attached — see docs/RELEASING.md.
 *
 * Stamped into `expo.extra` at build time from the repository that ran the
 * workflow, so a build always checks for updates against the repo it came from
 * rather than one hardcoded here. The literal below is the fallback for local
 * development, where nothing has stamped anything.
 */
export const GITHUB_REPO =
  Constants.expoConfig?.extra?.githubRepo || 'WilfredTinega/Upande-Sensors-App';

/** Human-facing page, used as the fallback whenever the API cannot be read. */
export const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;


/**
 * Tolerance before a server timestamp that sits in the *future* is treated as
 * a clock/timezone misconfiguration rather than a fresh reading. Small clock
 * drift between phone and server is normal; hours of it is not.
 */
export const CLOCK_SKEW_TOLERANCE_MINUTES = 10;

/**
 * Sites offered as one-tap suggestions on the server form.
 *
 * NOT a default. `client.js` deliberately starts with no server at all: a
 * hardcoded address means every fresh install points at one customer's instance
 * until somebody changes it, and an installer who forgets is signing in against
 * the wrong farm. A suggestion still has to be tapped, so the choice stays
 * explicit — it only saves typing the address that is right almost every time.
 */
export const SUGGESTED_SITES = ['sensor.upande.com'];
