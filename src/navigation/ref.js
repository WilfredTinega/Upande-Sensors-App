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
 * Live readings for the selected site. Also where a row on the Notifications
 * list lands, after selecting the row's site — reachable from outside the
 * navigator because that list is opened by the push tap handler, which lives
 * in the push module, not in a screen.
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

/* ── Notifications, and the way back from it ─────────────────────────────── */

export const NOTIFICATIONS_ROUTE = 'Notifications';

/**
 * Where the bell was pressed from, so its back chevron returns THERE.
 *
 * A hidden tab has no history of its own: the tab navigator's `goBack` walks
 * to the first route, which would send someone who opened the list from
 * Account back to Home. Remembering the departure route is the whole of the
 * fix. Home is the fallback — for a push tap on a cold start, there is no
 * departure route, and Home is where the app would have landed anyway.
 */
let notificationsReturnRoute = HOME_ROUTE;

/**
 * The full list of limit alerts. Opened by the header bell on every screen
 * and by a tapped push, which is why it is reachable from outside the
 * navigator like `goToLive`.
 */
export function goToNotifications() {
  if (!navigationRef.isReady()) return;
  if (currentRoute && currentRoute !== NOTIFICATIONS_ROUTE) notificationsReturnRoute = currentRoute;
  navigationRef.navigate(NOTIFICATIONS_ROUTE);
}

/** The Notifications header's back chevron. */
export function leaveNotifications() {
  if (!navigationRef.isReady()) return;
  navigationRef.navigate(notificationsReturnRoute || HOME_ROUTE);
}

/* ── Sensor coordinates and the map ──────────────────────────────────────── */

export const SENSOR_LOCATION_ROUTE = 'SensorLocation';
export const SENSOR_MAP_ROUTE = 'SensorMap';

/**
 * Departure routes by route name, for screens with a back chevron instead of
 * a tab button — the same problem Notifications solves above. Only "Set
 * coordinates" reads this today (the sensor list is a tab of its own now, not
 * something to leave), but it can be reached from more than one place — the
 * list's header, a sensor's detail screen — so its own arrival still has to
 * be remembered. Home is the fallback for the same reason.
 *
 * One extra rule: opening X from Y when Y was itself opened from X leaves X's
 * departure alone. Otherwise map → "Set coordinates" → "View on map" → back
 * would bounce between the two for ever; with it, the pair unwinds to wherever
 * it was entered from.
 */
const returnRoutes = {};

function openHidden(route, params) {
  if (!navigationRef.isReady()) return;
  if (currentRoute && currentRoute !== route && returnRoutes[currentRoute] !== route) {
    returnRoutes[route] = currentRoute;
  }
  navigationRef.navigate(route, params);
}

function leaveHidden(route) {
  if (!navigationRef.isReady()) return;
  navigationRef.navigate(returnRoutes[route] || HOME_ROUTE);
}

/**
 * The GPS capture for one sensor's coordinates. `sensor` is the Sensor
 * docname, `sensorName` the label — either preselects; neither opens the
 * picker empty. Params are always an object, never undefined: a tab screen
 * keeps its last params, and a stale preselection would otherwise survive
 * into the next visit.
 */
export function goToSensorLocation({ sensor, sensorName } = {}) {
  openHidden(SENSOR_LOCATION_ROUTE, { sensor: sensor || null, sensorName: sensorName || null });
}

export function leaveSensorLocation() {
  leaveHidden(SENSOR_LOCATION_ROUTE);
}

/**
 * Every positioned sensor on a map. `focus` names a sensor whose popup opens
 * on arrival — the way a "View on map" button lands on the sensor it was
 * pressed beside rather than on the whole site.
 */
export function goToSensorMap({ focus } = {}) {
  openHidden(SENSOR_MAP_ROUTE, { focus: focus || null });
}
