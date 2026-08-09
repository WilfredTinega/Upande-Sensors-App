import { useEffect, useState } from 'react';
import { createNavigationContainerRef } from '@react-navigation/native';

/**
 * Navigation handle usable from outside the navigator.
 *
 * The sidebar is rendered as a sibling of `NavigationContainer` (so it can
 * float above every screen), which puts it outside React Navigation's context —
 * `useNavigation` is unavailable there. This ref is the supported way across
 * that boundary.
 */
export const navigationRef = createNavigationContainerRef();

export const DASHBOARD_ROUTE = 'Dashboard';
export const ROUTE_HISTORY_ROUTE = 'RouteHistory';
export const ACCOUNT_ROUTE = 'Account';

/**
 * Show the chart for whichever tab was just chosen.
 *
 * Picking a dashboard from the sidebar while standing on Live or Readings used
 * to change state invisibly — the selection took effect on a screen the user
 * couldn't see. Navigating makes the tap do what it looks like it does.
 */
export function goToDashboard() {
  if (navigationRef.isReady()) navigationRef.navigate(DASHBOARD_ROUTE);
}

/** App activity, reachable from Account. No tab of its own. */
export function goToRouteHistory() {
  if (navigationRef.isReady()) navigationRef.navigate(ROUTE_HISTORY_ROUTE);
}

export function goToAccount() {
  if (navigationRef.isReady()) navigationRef.navigate(ACCOUNT_ROUTE);
}

/* ── Current route, observable from outside the navigator ─────────────────── */

let currentRoute = null;
const listeners = new Set();

export function setCurrentRoute(name) {
  if (name === currentRoute) return;
  currentRoute = name;
  listeners.forEach((fn) => fn(name));
}

/** Lets the sidebar mark the screen you're actually on. */
export function useCurrentRoute() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    listeners.add(setRoute);
    setRoute(currentRoute);
    return () => listeners.delete(setRoute);
  }, []);
  return route;
}
