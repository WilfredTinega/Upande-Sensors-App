import React from 'react';
import { ActivityIndicator, AppState, Pressable, View, useWindowDimensions } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { ChartsScreen } from '../screens/ChartsScreen';
import { DashboardScreen } from '../screens/DashboardScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { NotificationsScreen } from '../screens/NotificationsScreen';
import { ReadingsScreen } from '../screens/ReadingsScreen';
import { RouteHistoryScreen } from '../screens/RouteHistoryScreen';
import { SensorDetailScreen } from '../screens/SensorDetailScreen';
import { SensorLocationScreen } from '../screens/SensorLocationScreen';
import { SensorMapScreen } from '../screens/SensorMapScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { OfflineToast } from '../components/OfflineToast';
import { FloatingSidebar, SidebarToggle } from '../components/FloatingSidebar';
import { PushRegistrar } from '../components/PushRegistrar';
import { ReportButton } from '../components/ReportButton';
import { ReadingsTabIcon } from '../components/TabIcons';
import { UserAvatar } from '../components/UserAvatar';
import {
  DashboardHeaderTitle,
  HeaderAccountControls,
  HeaderSiteControls,
  HeaderSiteTitle,
} from '../components/HeaderControls';
import {
  NOTIFICATIONS_ROUTE,
  SENSOR_DETAIL_ROUTE,
  SENSOR_LOCATION_ROUTE,
  SENSOR_MAP_ROUTE,
  goToHome,
  goToLive,
  leaveNotifications,
  leaveSensorLocation,
  navigationRef,
  setCurrentRoute,
} from './ref';
import { recordRoute, setRouteHistoryEnabled } from '../utils/routeHistory';
import { DashboardProvider } from '../context/DashboardContext';
import { NotificationsProvider } from '../context/NotificationsContext';
import { useAuth } from '../context/AuthContext';
import { useUpdate } from '../context/UpdateContext';
import { useTheme } from '../hooks/useTheme';
import { font } from '../theme';

const Tab = createBottomTabNavigator();

const ICONS = {
  Live: ['pulse', 'pulse-outline'],
  // Readings is not here: its three bars are drawn by hand in TabIcons.js,
  // because neither Ionicons three-bar glyph matches the weight of the rest.
  // A bar chart, not the line-with-points 'analytics' glyph: at 24dp the
  // line reads as a stray squiggle, and bars are what a chart looks like
  // from across the room.
  Dashboard: ['bar-chart', 'bar-chart-outline'],
  [SENSOR_MAP_ROUTE]: ['map', 'map-outline'],
  Account: ['person-circle', 'person-circle-outline'],
};

/**
 * Logging out lives on the Account screen, not in the tab bar.
 *
 * It was a tab that cancelled its own navigation and opened a confirmation
 * instead — an action dressed as a destination, sitting one mis-tap away from
 * the screens people use all day. The tab bar is now five destinations that all
 * behave the same way, and the confirmation lives next to the account it ends.
 */

/** Screens whose data is scoped by the selected site. */
const SITE_FILTER_ROUTES = new Set([
  'Home',
  'Live',
  'Readings',
  'Dashboard',
  // The two location screens too: the picker lists the site's sensors and the
  // map draws them, so changing site has to be possible without leaving.
  SENSOR_LOCATION_ROUTE,
  SENSOR_MAP_ROUTE,
]);

/**
 * The one account whose screen visits are not recorded.
 *
 * Route History is an audit of how the app is used by the people it is for.
 * The Administrator is the account that deploys, tests and debugs it — every
 * Administrator visit is someone checking that a screen works, not someone
 * using it — and on a site where the same person also does support, those
 * visits outnumber real ones and swamp the activity report. The server applies
 * the identical rule to rows tagged `source: 'app'` (see `logRoutes`), so a
 * build that forgot this check would be refused rather than trusted.
 */
const UNTRACKED_USER = 'Administrator';

/** Away longer than this and reopening the app is a fresh visit, not a glance. */
const RESUME_HOME_AFTER_MS = 60 * 1000;

function SignedInApp() {
  const t = useTheme();
  const { user } = useAuth();
  const { available: updateAvailable } = useUpdate();
  const { width } = useWindowDimensions();

  /**
   * Enabled during render, not in an effect.
   *
   * React runs effects child-first, so `NavigationContainer`'s effect — which
   * fires `onReady` — ran before this component's effect. Recording was still
   * disabled at that point, so the first screen after every login was dropped.
   * Setting it here means it is on before any child can mount; the effect is
   * kept only to switch it off when the signed-in tree unmounts.
   */
  // The account is passed in because a direct insert has to name the user it
  // is recording; only the framework's queued route fills that in itself.
  setRouteHistoryEnabled(!!user?.name && user.name !== UNTRACKED_USER, user?.name);
  React.useEffect(() => () => setRouteHistoryEnabled(false), []);

  /**
   * Opening the app lands on Home, not on whichever screen was left open.
   *
   * A cold start already does — the navigator's `initialRouteName` — but
   * Android keeps the process alive, so coming back to the app hours later
   * resumed straight onto a screen from the last session. Only after a real
   * absence, though: switching out for ten seconds to copy something and being
   * yanked off the screen you were reading is worse than the problem.
   *
   * A tapped push still wins. It brings the app to the foreground, which fires
   * this, and THEN delivers the response that opens Notifications — later, so
   * last.
   */
  React.useEffect(() => {
    let leftAt = 0;
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') {
        leftAt = leftAt || Date.now();
        return;
      }
      const away = leftAt ? Date.now() - leftAt : 0;
      leftAt = 0;
      if (away >= RESUME_HOME_AFTER_MS) goToHome();
    });
    return () => sub.remove();
  }, []);

  const onRouteChange = () => {
    const current = navigationRef.getCurrentRoute();
    const name = current?.name;
    setCurrentRoute(name);
    // A sensor's chart is logged with the sensor's name: "SensorDetail" alone
    // would record every one of them identically, the way "Dashboard" alone
    // would for the tabs (see `selectTab`).
    const sensorName = name === SENSOR_DETAIL_ROUTE ? current?.params?.sensorName : null;
    recordRoute(sensorName ? `Sensor · ${sensorName}` : name);
  };

  const navTheme = {
    ...(t.mode === 'dark' ? DarkTheme : DefaultTheme),
    colors: {
      ...(t.mode === 'dark' ? DarkTheme : DefaultTheme).colors,
      primary: t.accent,
      background: t.background,
      card: t.surface,
      text: t.textPrimary,
      border: t.border,
    },
  };

  return (
    <DashboardProvider>
      {/* Inside DashboardProvider and around the navigator: the header bell
          reads it, and so does the Notifications screen. */}
      <NotificationsProvider>
        <View style={{ flex: 1 }}>
          <NavigationContainer
            ref={navigationRef}
            theme={navTheme}
            onReady={onRouteChange}
            onStateChange={onRouteChange}
          >
            <Tab.Navigator
              // Land on Home: the site's status at a glance, then the dashboards
              // as a grid. Someone opening the app to check on something gets
              // the answer without choosing a screen first.
              initialRouteName="Home"
              screenOptions={({ route }) => ({
                /**
               * The header is the page colour, not the card colour.
               *
               * Android draws the app under a transparent status bar, so the
               * strip behind the clock is whatever the header paints. A header
               * one shade lighter than the page produced two horizontal
               * boundaries at the top of every screen — bar to header, header
               * to content — which read as "lines from the phone bar". One
               * colour from the top edge to the first card leaves nothing to
               * see. (Where the OS forces an opaque bar — a hidden camera
               * cutout, or the Expo Go client — the app cannot paint there at
               * all; that band is the phone's, not the app's.)
               */
              headerStyle: { backgroundColor: t.background },
                headerTitleStyle: {
                  color: t.textPrimary,
                  fontSize: 17,
                  fontWeight: '700',
                  fontFamily: font('700'),
                },
                headerShadowVisible: false,
                // Everywhere but Home, whose dashboards grid IS the tab list —
                // an opener there would offer the same choice twice. Screens
                // that set their own headerLeft (a back chevron out of a task)
                // keep it: their override wins over this.
                headerLeft: route.name === 'Home' ? undefined : () => <SidebarToggle />,
                // The site-scoped screens carry the filter in the header rather
                // than each repeating it in a filters card — as the TITLE now,
                // centred, with the screen's own name under it; the right side
                // is the alerts bell alone.
                // Centred only where the title is the two-line site block. A
                // plain one-line title (Account, Notifications, App activity)
                // keeps the platform's own alignment.
                headerTitleAlign: SITE_FILTER_ROUTES.has(route.name) ? 'center' : 'left',
                headerRight: SITE_FILTER_ROUTES.has(route.name)
                  ? () => <HeaderSiteControls />
                  : route.name === 'Account'
                    ? () => <HeaderAccountControls />
                    : undefined,
                /**
                 * Room for the two-line block, and as wide as it can be.
                 *
                 * React Navigation budgets the title as "the width, less a flat
                 * 52 points for whatever is on the right" — written for a single
                 * icon. Here the title is the site name AND the screen name, and
                 * the second of those is aligned to the block's left edge, so
                 * the block has to span most of the bar for that edge to be the
                 * bar's. What is left goes to the sidebar button and the bell.
                 */
                headerTitleContainerStyle: SITE_FILTER_ROUTES.has(route.name)
                  ? { flexGrow: 1, flexBasis: 0, maxWidth: width }
                  : undefined,
                /**
                 * Let the two side slots hug their buttons — but only where the
                 * title is the two-line block that has to span the bar.
                 *
                 * Both are `flexGrow: 1, flexBasis: 0` by default, so with a
                 * title that also grows, the three split the bar in thirds and
                 * the title sits in the middle third — which is why a line
                 * "aligned left" inside it still looked centred. Hugging them
                 * leaves everything between to the title, whose own growth then
                 * pushes the bell back out to the right edge.
                 *
                 * Everywhere else the default has to stand: with a plain
                 * left-aligned title that does NOT grow, a hugged right slot
                 * has nothing pushing it, so the bell and the theme switch end
                 * up bunched against the title on the left.
                 */
                headerLeftContainerStyle: SITE_FILTER_ROUTES.has(route.name)
                  ? { flexGrow: 0, flexBasis: 'auto' }
                  : undefined,
                headerRightContainerStyle: SITE_FILTER_ROUTES.has(route.name)
                  ? { flexGrow: 0, flexBasis: 'auto' }
                  : undefined,
                tabBarActiveTintColor: t.accent,
                tabBarInactiveTintColor: t.textMuted,
                tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border },
                /**
                 * Icons alone, no captions.
                 *
                 * Five labels on a narrow phone left ~70dp each and the longest
                 * ("Dashboard") only fitted with the font size pinned at 10pt —
                 * small enough to read as noise under a glyph that already says
                 * the same thing. The label is still set on every screen below:
                 * it feeds the accessibility name, so a screen reader announces
                 * "Readings" even though nothing is drawn.
                 */
                tabBarShowLabel: false,
                tabBarAllowFontScaling: false,
                // flex: 1 on every visible item divides the bar evenly, and the
                // icon centres in its share now that nothing sits beneath it.
                tabBarItemStyle: { flex: 1, paddingHorizontal: 2 },
                tabBarIcon: ({ focused, color, size }) => {
                  // The account tab shows who is signed in — their ERPNext avatar,
                  // or their initials — rather than a generic person glyph.
                  if (route.name === 'Account') {
                    return (
                      <View>
                        <UserAvatar size={size ?? 24} focused={focused} color={color} />
                        {/* A new APK is the one thing the app must volunteer:
                            nothing else will tell a field phone it is out of
                            date. A dot, not a count — there is only ever one
                            newer version, and the number would mean nothing. */}
                        {updateAvailable ? (
                          <View
                            style={{
                              position: 'absolute',
                              top: -1,
                              right: -1,
                              width: 10,
                              height: 10,
                              borderRadius: 5,
                              backgroundColor: t.accent,
                              // Reads as a badge rather than a smudge on top of
                              // whichever avatar colour is underneath.
                              borderWidth: 1.5,
                              borderColor: t.surface,
                            }}
                          />
                        ) : null}
                      </View>
                    );
                  }
                  if (route.name === 'Readings') {
                    return <ReadingsTabIcon size={size ?? 24} color={color} />;
                  }
                  // Material's house rather than Ionicons', to match the menu
                  // glyph the sidebar opener uses.
                  if (route.name === 'Home') {
                    return (
                      <MaterialCommunityIcons
                        name={focused ? 'home' : 'home-outline'}
                        size={size ?? 24}
                        color={color}
                      />
                    );
                  }
                  const [active, inactive] = ICONS[route.name] || ICONS.Live;
                  return (
                    <Ionicons name={focused ? active : inactive} size={size ?? 24} color={color} />
                  );
                },
              })}
            >
              {/*
                `title` feeds BOTH the header and the tab label, so a descriptive
                header title ("Sensor readings") ends up wrapped across two lines
                in the tab bar. headerTitle and tabBarLabel are set separately so
                each reads correctly in its own place.
              */}
              <Tab.Screen
                name="Home"
                component={HomeScreen}
                // The mark instead of the word — the tab bar's house glyph
                // already says "Home", so the title is free to be the app.
                options={{
                  // Nothing: the greeting card below states the site and is the
                  // filter for it, so a header saying the same thing — plus the
                  // word the highlighted tab already says — is repetition.
                  headerTitle: () => null,
                  tabBarLabel: 'Home',
                  tabBarAccessibilityLabel: 'Home tab',
                }}
              />
              <Tab.Screen
                name="Live"
                component={DashboardScreen}
                options={{
                  headerTitle: () => <HeaderSiteTitle title="Live readings" />,
                  tabBarLabel: 'Live',
                  tabBarAccessibilityLabel: 'Live readings tab',
                }}
              />
              <Tab.Screen
                name="Readings"
                component={ReadingsScreen}
                options={{
                  headerTitle: () => <HeaderSiteTitle title="Sensor readings" />,
                  tabBarLabel: 'Readings',
                  tabBarAccessibilityLabel: 'Sensor readings tab',
                }}
              />
              <Tab.Screen
                name="Dashboard"
                component={ChartsScreen}
                options={{
                  headerTitle: () => <DashboardHeaderTitle />,
                  tabBarLabel: 'Dashboard',
                  tabBarAccessibilityLabel: 'Dashboard tab',
                }}
              />
              {/* Reached from Account, so it carries no tab button either. */}
              <Tab.Screen
                name="RouteHistory"
                component={RouteHistoryScreen}
                options={{
                  headerTitle: 'App activity',
                  tabBarButton: () => null,
                  tabBarItemStyle: { display: 'none' },
                }}
              />
              {/* Reached by tapping a sensor on Live. Hidden for the same reason
                  as App activity: it is about one sensor, so it is a place you
                  arrive at from something, never a destination in its own right.
                  The header title names the sensor the params carry. */}
              <Tab.Screen
                name="SensorDetail"
                component={SensorDetailScreen}
                options={({ route }) => ({
                  headerTitle: route.params?.sensorName || 'Sensor',
                  // Back to Live, where the card was tapped — a hidden tab has no
                  // button of its own to return by.
                  headerLeft: () => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Back to live readings"
                      onPress={goToLive}
                      hitSlop={10}
                      style={({ pressed }) => ({
                        paddingLeft: 16,
                        paddingRight: 8,
                        paddingVertical: 8,
                        opacity: pressed ? 0.6 : 1,
                      })}
                    >
                      <Ionicons name="chevron-back" size={24} color={t.textPrimary} />
                    </Pressable>
                  ),
                  tabBarButton: () => null,
                  tabBarItemStyle: { display: 'none' },
                })}
              />
              {/* Reached from the header bell on every screen, or a tapped push.
                  Hidden like the two above: a list of what happened is a place
                  you go to look, then leave — the back chevron returns to
                  whichever screen the bell was pressed on. */}
              <Tab.Screen
                name={NOTIFICATIONS_ROUTE}
                component={NotificationsScreen}
                options={{
                  headerTitle: 'Notifications',
                  headerLeft: () => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Back"
                      onPress={leaveNotifications}
                      hitSlop={10}
                      style={({ pressed }) => ({
                        paddingLeft: 16,
                        paddingRight: 8,
                        paddingVertical: 8,
                        opacity: pressed ? 0.6 : 1,
                      })}
                    >
                      <Ionicons name="chevron-back" size={24} color={t.textPrimary} />
                    </Pressable>
                  ),
                  tabBarButton: () => null,
                  tabBarItemStyle: { display: 'none' },
                }}
              />
              {/* Reached from the sensor list's header or empty state, or a
                  sensor's detail screen. Hidden like the rest: setting
                  coordinates is a task — stand at the sensor, scan, save — not a
                  place, and the back chevron returns to wherever the task was
                  started from. The header's site filter scopes its picker. */}
              <Tab.Screen
                name={SENSOR_LOCATION_ROUTE}
                component={SensorLocationScreen}
                options={{
                  headerTitle: () => <HeaderSiteTitle title="Set coordinates" />,
                  headerLeft: () => (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Back"
                      onPress={leaveSensorLocation}
                      hitSlop={10}
                      style={({ pressed }) => ({
                        paddingLeft: 16,
                        paddingRight: 8,
                        paddingVertical: 8,
                        opacity: pressed ? 0.6 : 1,
                      })}
                    >
                      <Ionicons name="chevron-back" size={24} color={t.textPrimary} />
                    </Pressable>
                  ),
                  tabBarButton: () => null,
                  tabBarItemStyle: { display: 'none' },
                }}
              />
              {/* Every positioned sensor on a map, and where a sensor's
                  coordinates are added. The add and refresh controls sit in the
                  screen's own counts row, not the header. */}
              <Tab.Screen
                name={SENSOR_MAP_ROUTE}
                component={SensorMapScreen}
                options={{
                  headerTitle: () => <HeaderSiteTitle title="Sensor list" />,
                  tabBarLabel: 'Sensor list',
                  tabBarAccessibilityLabel: 'Sensor list tab',
                  headerRight: () => <HeaderSiteControls />,
                }}
              />
              <Tab.Screen
                name="Account"
                component={SettingsScreen}
                options={{
                  headerTitle: 'Account',
                  tabBarLabel: 'Account',
                  tabBarAccessibilityLabel: 'Account tab',
                }}
              />
            </Tab.Navigator>
          </NavigationContainer>

          <FloatingSidebar />

          {/* Renders nothing. Inside the providers so it exists exactly as long
              as a session does; a tapped alert opens the Notifications list. */}
          <PushRegistrar />

          {/* Outside the navigator so it floats over every screen, and so the
              screenshot it captures is of the screen rather than of itself. */}
          <ReportButton />

          {/* Outside the navigator too: connectivity is the app's state, not one
              screen's, and the screens themselves stay on their skeletons. */}
          <OfflineToast />
        </View>
      </NotificationsProvider>
    </DashboardProvider>
  );
}

export function RootNavigator() {
  const t = useTheme();
  const { status } = useAuth();

  if (status === 'restoring') {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: t.background,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator size="large" color={t.accent} />
      </View>
    );
  }

  if (status === 'signedOut') return <LoginScreen />;

  return <SignedInApp />;
}
