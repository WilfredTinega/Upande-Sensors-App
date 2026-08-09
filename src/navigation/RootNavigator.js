import React, { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import Ionicons from '@expo/vector-icons/Ionicons';

import { ChartsScreen } from '../screens/ChartsScreen';
import { DashboardScreen } from '../screens/DashboardScreen';
import { LoginScreen } from '../screens/LoginScreen';
import { ReadingsScreen } from '../screens/ReadingsScreen';
import { RouteHistoryScreen } from '../screens/RouteHistoryScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { FloatingSidebar, SidebarToggle } from '../components/FloatingSidebar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ReportButton } from '../components/ReportButton';
import { UserAvatar } from '../components/UserAvatar';
import {
  DashboardHeaderTitle,
  HeaderSiteFilter,
  HeaderThemeSwitch,
} from '../components/HeaderControls';
import { navigationRef, setCurrentRoute } from './ref';
import { recordRoute, setRouteHistoryEnabled } from '../utils/routeHistory';
import { DashboardProvider } from '../context/DashboardContext';
import { useAuth } from '../context/AuthContext';
import { useUpdate } from '../context/UpdateContext';
import { useTheme } from '../hooks/useTheme';
import { font } from '../theme';

const Tab = createBottomTabNavigator();

const ICONS = {
  Live: ['pulse', 'pulse-outline'],
  Readings: ['list', 'list-outline'],
  Dashboard: ['analytics', 'analytics-outline'],
  Account: ['person-circle', 'person-circle-outline'],
  SignOut: ['log-out', 'log-out-outline'],
};

/**
 * Placeholder for the sign-out tab.
 *
 * The tab is an action, not a destination — its `tabPress` listener cancels
 * navigation, so this never renders. It exists only because a bottom tab must
 * be backed by a screen.
 */
function NeverRendered() {
  return null;
}

/** Screens the dashboard-tab sidebar applies to. */
const SIDEBAR_ROUTES = new Set(['Live', 'Readings', 'Dashboard']);

/** Screens whose data is scoped by the selected site. */
const SITE_FILTER_ROUTES = new Set(['Live', 'Readings', 'Dashboard']);

function SignedInApp() {
  const t = useTheme();
  const { signOut, user } = useAuth();
  const { available: updateAvailable } = useUpdate();

  const [signOutOpen, setSignOutOpen] = useState(false);

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
  setRouteHistoryEnabled(true, user?.name);
  React.useEffect(() => () => setRouteHistoryEnabled(false), []);

  const onRouteChange = () => {
    const name = navigationRef.getCurrentRoute()?.name;
    setCurrentRoute(name);
    recordRoute(name);
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
      <View style={{ flex: 1 }}>
        <NavigationContainer
          ref={navigationRef}
          theme={navTheme}
          onReady={onRouteChange}
          onStateChange={onRouteChange}
        >
          <Tab.Navigator
            // Land on the dashboard: it is the view people open the app for.
            initialRouteName="Dashboard"
            screenOptions={({ route }) => ({
              headerStyle: { backgroundColor: t.surface },
              headerTitleStyle: {
                color: t.textPrimary,
                fontSize: 17,
                fontWeight: '700',
                fontFamily: font('700'),
              },
              headerShadowVisible: false,
              // Only the data screens are scoped by a dashboard tab, so only
              // they get the opener — a list icon on Account would open a
              // sidebar that changes nothing on screen.
              headerLeft: SIDEBAR_ROUTES.has(route.name) ? () => <SidebarToggle /> : undefined,
              // The three site-scoped screens carry the filter in the header,
              // beside the sidebar button, rather than each repeating it in a
              // filters card.
              headerRight: SITE_FILTER_ROUTES.has(route.name)
                ? () => <HeaderSiteFilter />
                : route.name === 'Account'
                  ? () => <HeaderThemeSwitch />
                  : undefined,
              tabBarActiveTintColor: t.accent,
              tabBarInactiveTintColor: t.textMuted,
              tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border },
              // Five tabs on a narrow phone leaves ~70dp each. 10pt with font
              // scaling pinned keeps the longest label ("Dashboards") on one
              // line instead of ellipsing to "Dashboa…" at large system fonts.
              tabBarLabelStyle: { fontSize: 10, fontWeight: '600', fontFamily: font('600') },
              tabBarAllowFontScaling: false,
              // flex: 1 on every visible item divides the bar evenly, whatever
              // the label lengths.
              tabBarItemStyle: { flex: 1, paddingHorizontal: 2 },
              tabBarIcon: ({ focused, color, size }) => {
                // The account tab shows who is signed in — their ERPNext avatar,
                // or their initials — rather than a generic person glyph.
                if (route.name === 'Account') {
                  return (
                    <View>
                      <UserAvatar size={size ?? 22} focused={focused} color={color} />
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
                const [active, inactive] = ICONS[route.name] || ICONS.Live;
                return (
                  <Ionicons name={focused ? active : inactive} size={size ?? 22} color={color} />
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
              name="Live"
              component={DashboardScreen}
              options={{ headerTitle: 'Live readings', tabBarLabel: 'Live' }}
            />
            <Tab.Screen
              name="Readings"
              component={ReadingsScreen}
              options={{ headerTitle: 'Sensor readings', tabBarLabel: 'Readings' }}
            />
            <Tab.Screen
              name="Dashboard"
              component={ChartsScreen}
              options={{
                headerTitle: () => <DashboardHeaderTitle />,
                tabBarLabel: 'Dashboard',
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
            <Tab.Screen
              name="Account"
              component={SettingsScreen}
              options={{ headerTitle: 'Account', tabBarLabel: 'Account' }}
            />
            {/* An action dressed as a tab: the listener cancels the navigation
                and opens the confirmation instead, so a stray tap can never
                sign anyone out on its own. */}
            <Tab.Screen
              name="SignOut"
              component={NeverRendered}
              options={{ tabBarLabel: 'Log out' }}
              listeners={{
                tabPress: (e) => {
                  e.preventDefault();
                  setSignOutOpen(true);
                },
              }}
            />
          </Tab.Navigator>
        </NavigationContainer>

        <FloatingSidebar />

        {/* Outside the navigator so it floats over every screen, and so the
            screenshot it captures is of the screen rather than of itself. */}
        <ReportButton />

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
      </View>
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
