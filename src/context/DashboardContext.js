import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import * as SecureStore from 'expo-secure-store';

import { TTL_REFERENCE, cacheKey, invalidate } from '../api/cache';
import { getDashboardConfig, getServerTimezone, getUserSites } from '../api/endpoints';
import { fetchLiveForSite, latestStamp } from '../api/liveSite';
import { useQuery } from '../hooks/useQuery';
import { goToDashboard } from '../navigation/ref';
import { setStaleAfterMinutes } from '../utils/dates';
import { recordRoute } from '../utils/routeHistory';
import {
  deviceOffsetMinutes,
  deviceZoneName,
  getTimezoneState,
  offsetFromZoneName,
  setTimezoneState,
} from '../utils/timezone';

/** Stable empty, so a config without an `app` block does not re-memo on every render. */
const NO_APP_SETTINGS = {};

const KEY_SITE = 'upande.site';

/**
 * Units the server itself asserts, used only when Sensor Settings defines none.
 * Not guesses: `download_sensor_readings_xlsx` writes these exact headers —
 * "Temp °C", "Soil °C", "Humidity %", "Dew Point °C" — so the backend already
 * treats them as the units of these measures.
 *
 * Anything not on this list stays unlabelled rather than being assumed.
 *
 * At module scope because it never changes. Rebuilt inside the component it was
 * a new object on every render, which made it a dependency `unitForType` had to
 * declare and would have re-created that callback every time.
 */
const SERVER_ASSERTED_UNITS = {
  temperature: '°C',
  'soil temperature': '°C',
  'dew point': '°C',
  humidity: '%',
};
const KEY_TZ_MODE = 'upande.tzMode';
const KEY_TZ_OFFSET = 'upande.tzOffset';

const DashboardContext = createContext(null);

/**
 * Shared filter state and reference data.
 *
 * Three things used to be per-screen and are now global:
 *   - the site list and the selected site,
 *   - the Sensor Settings tab configuration,
 *   - which tab is active.
 *
 * That removes duplicate round trips (each screen was fetching its own copy of
 * data that is identical everywhere, at ~1s per request), and it means changing
 * the site on one tab doesn't silently leave another tab showing a different
 * one — which was its own small lie.
 */
export function DashboardProvider({ children }) {
  const [site, setSiteState] = useState(null);
  const [activeTabName, setActiveTabName] = useState(null);
  const [sensorType, setSensorType] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const sitesQuery = useQuery(cacheKey('user_sites'), () => getUserSites(), {
    ttl: TTL_REFERENCE,
  });
  const configQuery = useQuery(cacheKey('dashboard_config'), () => getDashboardConfig(), {
    ttl: TTL_REFERENCE,
  });

  const sites = useMemo(
    () => (Array.isArray(sitesQuery.data) ? sitesQuery.data : []),
    [sitesQuery.data],
  );

  /**
   * Exactly what Sensor Settings returns, in its order — no app-side allow or
   * deny list. `get_dashboard_config` already drops disabled tabs and applies
   * the user's tab permissions, so filtering again here would mean the app and
   * the web portal could disagree about which dashboards exist.
   */
  const tabs = useMemo(
    () => (Array.isArray(configQuery.data?.tabs) ? configQuery.data.tabs : []),
    [configQuery.data],
  );

  /**
   * Sensor type -> unit, built from every tab's configuration.
   *
   * Units are only defined in Sensor Settings, and several places need them
   * where the payload carries none: `get_live_readings` returns `uom: ""` on
   * its Sensor Reading fallback path, and `get_chart_series` hardcodes
   * `unit: ""` outright. Looked up across all tabs rather than the active one,
   * so a type configured with a unit anywhere is labelled everywhere.
   *
   * Server sensor_type values are lowercase ("temperature") while config labels
   * are title case, so both sides are folded before matching.
   */
  const unitsByType = useMemo(() => {
    const map = {};
    (configQuery.data?.tabs || []).forEach((tab) => {
      (tab.sensor_types || []).forEach((st) => {
        const label = String(st.label || '')
          .trim()
          .toLowerCase();
        if (label && st.unit) map[label] = st.unit;
      });
    });
    return map;
  }, [configQuery.data]);

  const unitForType = useCallback(
    (label) => {
      if (!label) return '';
      const key = String(label).trim().toLowerCase();
      return unitsByType[key] || SERVER_ASSERTED_UNITS[key] || '';
    },
    [unitsByType],
  );

  /**
   * The app-facing block of Sensor Settings: `welcome_message`,
   * `support_contact`, `stale_after_minutes`. Only the app method returns it;
   * the Server Script and legacy paths predate the fields, so an empty object
   * here means "an older server", and every reader treats absence as default.
   */
  const appSettings = useMemo(
    () =>
      configQuery.data?.app && typeof configQuery.data.app === 'object'
        ? configQuery.data.app
        : NO_APP_SETTINGS,
    [configQuery.data],
  );

  /**
   * Apply the site's freshness window as soon as the config lands.
   *
   * Written into `utils/dates.js` rather than threaded through props because
   * `isStale` is called from the Live cards, the header tallies, the Readings
   * table and the Home card, and each of those would otherwise need the value
   * passed in by hand. The setter does the validation: anything that is not a
   * positive finite number — including the absence of the block on an older
   * server — resets to the compiled default, so switching servers can never
   * carry one site's threshold onto another.
   */
  useEffect(() => {
    if (configQuery.loading) return;
    setStaleAfterMinutes(appSettings.stale_after_minutes);
  }, [appSettings, configQuery.loading]);

  /**
   * Live sensor tallies, published by the Live screen so the header can show
   * them beneath the site filter. Kept here because the header is rendered by
   * the navigator, outside the screen that computes them.
   */
  const [sensorCounts, setSensorCounts] = useState(null);

  /**
   * `null` means every site the user can see.
   *
   * On first run the app picks the site that reported most recently rather than
   * the first alphabetically — on a multi-site account that is the one someone
   * opening the app is most likely to want. It is a starting point, not a
   * constraint: a manual choice from the picker is never overridden.
   */
  const activeSite = site;
  const autoPicked = useRef(false);
  /**
   * True until a site has been settled on, one way or another.
   *
   * Between the site list arriving and the pick completing, every screen's
   * query key is null — so nothing is loading, and the screens were rendering
   * their "nothing here" states over a site that hadn't been chosen yet. That
   * empty flash is what this exists to cover: it starts true, and only the
   * paths below can clear it.
   */
  const [sitePending, setSitePending] = useState(true);

  useEffect(() => {
    if (autoPicked.current) return;
    // A site already chosen, or a finished site query with nothing in it, both
    // mean there is nothing left to pick — settle the step rather than leaving
    // the loading indicator waiting on work that will never happen.
    if (site || (!sites.length && !sitesQuery.loading)) {
      autoPicked.current = true;
      setSitePending(false);
      return;
    }
    // The list itself is still coming; stay pending.
    if (!sites.length) return;
    // Nothing to choose between.
    if (sites.length === 1) {
      autoPicked.current = true;
      setSiteState(sites[0]);
      setSitePending(false);
      return;
    }

    autoPicked.current = true;
    let cancelled = false;

    (async () => {
      try {
        /**
         * The site you were last on, if you can still see it.
         *
         * Probing every site costs two round trips each; remembering the previous
         * choice makes a repeat login immediate. Only a first-ever login on this
         * device pays for the probe.
         */
        const remembered = await SecureStore.getItemAsync(KEY_SITE).catch(() => null);
        if (cancelled) return;
        if (remembered && sites.includes(remembered)) {
          setSiteState(remembered);
          return;
        }

        /**
         * Ask every site for its latest reading, in parallel.
         *
         * This replaced a chain of up to three `sensor_dashboard` calls (today,
         * then a week, then 90 days). That endpoint is the heaviest query the app
         * makes, it was called with no site filter, and each attempt burned the
         * full 30s client timeout before the next was tried — up to a minute and
         * a half of an apparently frozen Live screen.
         *
         * These two calls per site are the same ones the Live screen makes, run
         * concurrently and cached under the key that screen reads, so picking the
         * site also warms its data instead of duplicating it.
         */
        const probes = sites.slice(0, 8).map(async (candidate) => {
          try {
            const payload = await fetchLiveForSite(candidate);
            const stamp = latestStamp(payload);
            return stamp ? { site: candidate, stamp } : null;
          } catch {
            // One unreadable site must not sink the others.
            return null;
          }
        });

        const settled = (await Promise.all(probes)).filter(Boolean);
        if (cancelled) return;

        if (settled.length) {
          const freshest = settled.reduce((a, b) => (b.stamp > a.stamp ? b : a));
          setSiteState(freshest.site);
          SecureStore.setItemAsync(KEY_SITE, freshest.site).catch(() => {});
          return;
        }

        // Nothing reported anywhere we could see. The picker has no "All sites"
        // entry, so an empty selection would strand the user in a state they
        // cannot choose their way out of — fall back to the first site.
        setSiteState(sites[0]);
      } finally {
        /**
         * However this ended — a remembered site, a probe, a fallback, a throw,
         * or a cancellation — the screens stop waiting.
         *
         * Deliberately not guarded by `cancelled`. If the site list changes
         * while a pick is in flight, the effect re-runs and returns at once
         * (`autoPicked` is already set), so a guarded clear here would leave
         * every screen skeletoning forever. The `setSiteState` calls above are
         * still guarded, so a cancelled pick cannot apply a stale site.
         */
        setSitePending(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sites, site, sitesQuery.loading]);

  const activeTab = useMemo(
    () => tabs.find((t) => t.name === activeTabName) || tabs[0] || null,
    [tabs, activeTabName],
  );

  /**
   * The tag the server uses to hide sensors belonging to a different tab
   * (cold_room / cold_chain / greenhouse). Passing the active tab's slug keeps
   * the app's sensor lists consistent with the web portal's; slugs that aren't
   * one of the gated three are ignored server-side, so this is safe to always
   * send.
   */
  const tabTag = activeTab?.slug || null;

  const sensorTypesForTab = useMemo(
    () => (Array.isArray(activeTab?.sensor_types) ? activeTab.sensor_types : []),
    [activeTab],
  );

  /**
   * `null` means "every sensor type in this tab, on one chart" — the default.
   * A tab like "Temperature and Humidity" is one dashboard, not two, so its
   * types are plotted together rather than being separate destinations.
   *
   * A type carried over from another tab would silently query something the
   * tab doesn't show, so it resets whenever the selection leaves the tab.
   */
  useEffect(() => {
    if (!sensorType) return;
    const stillValid = sensorTypesForTab.some((st) => st.label === sensorType);
    if (!stillValid) setSensorType(null);
  }, [sensorTypesForTab, sensorType]);

  /* ── Timezone ──────────────────────────────────────────────────────────── */

  const [timezone, setTimezoneLocal] = useState(getTimezoneState());

  const applyTimezone = useCallback((next) => {
    setTimezoneLocal(setTimezoneState(next));
  }, []);

  // Resolve the zone once per session: a stored manual override wins, then the
  // server's own setting when this account may read it, then the phone.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [storedMode, storedOffset] = await Promise.all([
        SecureStore.getItemAsync(KEY_TZ_MODE).catch(() => null),
        SecureStore.getItemAsync(KEY_TZ_OFFSET).catch(() => null),
      ]);
      if (cancelled) return;

      if (storedMode === 'manual' && storedOffset !== null) {
        applyTimezone({
          mode: 'manual',
          offsetMinutes: Number(storedOffset),
          source: 'manual',
          zoneName: null,
        });
        return;
      }

      applyTimezone({
        mode: 'auto',
        offsetMinutes: deviceOffsetMinutes(),
        source: 'device',
        zoneName: deviceZoneName(),
      });

      const serverZone = await getServerTimezone();
      if (cancelled) return;
      if (!serverZone) return;
      const serverOffset = offsetFromZoneName(serverZone);
      // A zone name we can't resolve to an offset is worse than useless — it
      // would look authoritative while silently keeping the device value.
      if (serverOffset === null) return;
      applyTimezone({
        mode: 'auto',
        offsetMinutes: serverOffset,
        source: 'server',
        zoneName: serverZone,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [applyTimezone]);

  const setTimezoneMode = useCallback(
    async (mode, offsetMinutes) => {
      if (mode === 'manual') {
        await Promise.all([
          SecureStore.setItemAsync(KEY_TZ_MODE, 'manual'),
          SecureStore.setItemAsync(KEY_TZ_OFFSET, String(offsetMinutes)),
        ]);
        applyTimezone({ mode: 'manual', offsetMinutes, source: 'manual', zoneName: null });
        return;
      }

      await Promise.all([
        SecureStore.deleteItemAsync(KEY_TZ_MODE).catch(() => {}),
        SecureStore.deleteItemAsync(KEY_TZ_OFFSET).catch(() => {}),
      ]);
      const serverZone = await getServerTimezone();
      const serverOffset = serverZone ? offsetFromZoneName(serverZone) : null;
      applyTimezone(
        serverOffset === null
          ? {
              mode: 'auto',
              offsetMinutes: deviceOffsetMinutes(),
              source: 'device',
              zoneName: deviceZoneName(),
            }
          : { mode: 'auto', offsetMinutes: serverOffset, source: 'server', zoneName: serverZone },
      );
    },
    [applyTimezone],
  );

  /**
   * `null` means "All sites" — a deliberate, explicit choice, never the
   * default. It is not written to SecureStore (only a real site name is), so
   * the NEXT launch auto-picks one site again rather than reopening on the
   * broad view somebody happened to leave it on — "All sites" is a
   * for-this-session look, not a standing preference. The last REAL site is
   * left alone, not cleared, so a detour through "All sites" and back still
   * remembers where you actually were.
   */
  const setSite = useCallback((next) => {
    setSiteState(next);
    if (next) SecureStore.setItemAsync(KEY_SITE, next).catch(() => {});
  }, []);

  const selectTab = useCallback(
    (name) => {
      setActiveTabName(name);
      // Land on the tab's combined view rather than whichever single type was
      // selected on the tab before it.
      setSensorType(null);
      setSidebarOpen(false);
      // Choosing a dashboard should show that dashboard. Without this the
      // selection lands silently on a screen the user isn't looking at.
      goToDashboard();
      // Logged with the dashboard's name: "Dashboard" alone would record every
      // one of them identically.
      const label = tabs.find((tab) => tab.name === name)?.label;
      if (label) recordRoute(`Dashboard · ${label}`);
    },
    [tabs],
  );

  const refreshReference = useCallback(async () => {
    invalidate('user_sites');
    invalidate('dashboard_config');
    // Both of the above are served from one consolidated request; without
    // dropping it too, `refresh()` forces the outer keys and is then handed the
    // memoised payload back, so a refresh would fetch nothing.
    invalidate('app_config');
    await Promise.all([sitesQuery.refresh(), configQuery.refresh()]);
  }, [sitesQuery, configQuery]);

  const value = useMemo(
    () => ({
      sites,
      site: activeSite,
      setSite,
      // Gated on `sitePending`, not on `site` being truthy: `site === null`
      // now means two different things depending on when you ask — "still
      // auto-picking" before the pick settles, and "All sites, on purpose"
      // after it. Only the first one should freeze the filters.
      filtersLocked: sitesQuery.loading || sitePending,
      sitesLoading: sitesQuery.loading,
      // Sites listed but not yet chosen between. Screens skeleton on this.
      sitePending: sitePending || sitesQuery.loading,
      sitesError: sitesQuery.error,

      tabs,
      activeTab,
      activeTabName: activeTab?.name || null,
      selectTab,
      tabTag,
      configLoading: configQuery.loading,
      configError: configQuery.error,
      dashboardTitle: configQuery.data?.title || 'Upande Sensors',
      appSettings,
      // Trimmed here so a field left as whitespace in Sensor Settings reads as
      // unset everywhere, rather than rendering a blank line on Home.
      welcomeMessage: String(appSettings.welcome_message || '').trim() || null,
      supportContact: String(appSettings.support_contact || '').trim() || null,

      sensorType,
      setSensorType,
      sensorTypesForTab,
      unitForType,
      sensorCounts,
      setSensorCounts,

      timezone,
      setTimezoneMode,

      sidebarOpen,
      openSidebar: () => setSidebarOpen(true),
      closeSidebar: () => setSidebarOpen(false),

      refreshReference,
    }),
    [
      sites,
      activeSite,
      setSite,
      sitePending,
      sitesQuery.loading,
      sitesQuery.error,
      tabs,
      activeTab,
      selectTab,
      tabTag,
      configQuery.loading,
      configQuery.error,
      configQuery.data,
      appSettings,
      sensorType,
      sensorTypesForTab,
      unitForType,
      sensorCounts,
      timezone,
      setTimezoneMode,
      sidebarOpen,
      refreshReference,
    ],
  );

  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used inside <DashboardProvider>');
  return ctx;
}
