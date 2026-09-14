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

export const HOME_ROUTE = 'Home';
export const LIVE_ROUTE = 'Live';
export const READINGS_ROUTE = 'Readings';
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

/** The landing screen: site status, the dashboards grid, quick links. */
export function goToHome() {
  if (navigationRef.isReady()) navigationRef.navigate(HOME_ROUTE);
}

/**
 * Live readings for the selected site. Also the destination of a tapped
 * limit-breach notification, which is why it has to be reachable from outside
 * the navigator: the tap handler lives in the push module, not in a screen.
 */
export function goToLive() {
  if (navigationRef.isReady()) navigationRef.navigate(LIVE_ROUTE);
}

export function goToReadings() {
  if (navigationRef.isReady()) navigationRef.navigate(READINGS_ROUTE);
}

export const SENSOR_DETAIL_ROUTE = 'SensorDetail';

/**
 * One sensor's chart, reached from its card on Live. A hidden tab, like App
 * activity: it has no tab button of its own, and the params name the sensor —
 * the site is fixed by the sensor, so the header's site filter is not offered
 * there.
 */
export function goToSensorDetail({ site, sensorName, sensorType }) {
  if (!navigationRef.isReady() || !sensorName) return;
  navigationRef.navigate(SENSOR_DETAIL_ROUTE, { site, sensorName, sensorType });
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
