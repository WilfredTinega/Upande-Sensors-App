/**
 * Deployment constants that are not worth a settings screen but must not be
 * buried in the middle of a component.
 */

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
 * Tolerance before a server timestamp that sits in the *future* is treated as
 * a clock/timezone misconfiguration rather than a fresh reading. Small clock
 * drift between phone and server is normal; hours of it is not.
 */
export const CLOCK_SKEW_TOLERANCE_MINUTES = 10;

