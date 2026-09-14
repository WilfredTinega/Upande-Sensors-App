import React, { useCallback, useMemo } from 'react';
import {
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Card, EmptyState, SectionTitle, StatusChip } from '../components/ui';
import { Skeleton } from '../components/Skeleton';
import { TTL_LIVE, cacheKey, invalidate } from '../api/cache';
import { getDashboardHealth, getLocationCoverage } from '../api/endpoints';
import { latestStamp, liveKey, loadLiveForSite, siteKey } from '../api/liveSite';
import { useAuth } from '../context/AuthContext';
import { useDashboard } from '../context/DashboardContext';
import { useQuery } from '../hooks/useQuery';
import { goToLive, goToSensorLocation, goToSensorMap } from '../navigation/ref';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';
import { isStale, relativeTime } from '../utils/dates';

/**
 * The landing screen.
 *
 * Everything on it is driven by Sensor Settings through `useDashboard()`: the
 * title and welcome line, the dashboards grid (exactly the enabled, permitted
 * Main Tabs, in the server's order), the support contact. Nothing here is a
 * destination of its own — it is the place that says how the selected site is
 * doing and offers the way to each screen, for someone opening the app to
 * check rather than to work.
 */

/**
 * Ionicon per dashboard, chosen by keyword in the tab's slug or label.
 *
 * Sensor Settings' `icon` field is a Frappe desk icon name ("octicon
 * octicon-thermometer"), which is not an Ionicon and cannot be passed through.
 * Matching on the words is the honest alternative: it follows what the tab is
 * called, first match wins, so "Cold Room Temperature" is a snowflake rather
 * than a thermometer — the room is the subject, the measure is the detail.
 */
const TAB_ICONS = [
  ['weather', 'rainy-outline'],
  ['soil', 'leaf-outline'],
  ['water', 'water-outline'],
  ['power', 'flash-outline'],
  ['energy', 'flash-outline'],
  ['pump', 'cog-outline'],
  ['floor', 'map-outline'],
  ['door', 'enter-outline'],
  ['vehicle', 'car-outline'],
  ['cold', 'snow-outline'],
  ['greenhouse', 'leaf-outline'],
  ['pest', 'bug-outline'],
  ['temperature', 'thermometer-outline'],
];

function iconForTab(tab) {
  const words = `${tab?.slug || ''} ${tab?.label || ''}`.toLowerCase();
  const hit = TAB_ICONS.find(([keyword]) => words.includes(keyword));
  return hit ? hit[1] : 'grid-outline';
}

/** Morning / afternoon / evening, by the phone's clock — a greeting, not data. */
function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Shared constants, so a pending query doesn't yield a new object per render. */
const EMPTY_SENSORS = [];
const EMPTY_LIVE = {};
const EMPTY_COVERAGE = { with_coordinates: 0, without_coordinates: 0 };

/**
 * One dashboard's counts out of a `dashboard_health` payload, or null.
 *
 * The server keys `tabs` by the Sensor Setting CHILD ROW NAME — the same `name`
 * the config endpoint gives each tab — and this looks the row up by `tab.name`
 * and by nothing else. Not the slug, not the label: two tabs can share a label
 * and a slug is derived from one, so either would match the wrong row or no row
 * at all, and a tile that silently found no row is indistinguishable from a
 * dashboard with no sensors.
 *
 * Returns null rather than zeros when the row is absent, because null is
 * "unknown" and the tile renders nothing for it. Zeros would be a claim.
 *
 * Exported for `tests/dashboardHealth.test.js`; nothing else imports it.
 */
export function healthForTab(payload, tab) {
  const tabs = payload?.tabs;
  const key = tab?.name;
  if (!key || !tabs || typeof tabs !== 'object') return null;
  const row = tabs[key];
  if (!row || typeof row !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    total: num(row.total),
    active: num(row.active),
    stale: num(row.stale),
    lastReading: row.last_reading || null,
    // "monitoring" / "floor-plan" / "types" / "none" — how the server decided
    // which sensors this dashboard owns. Carried through so a tile can stay
    // silent about a scope the server could not resolve.
    scope: row.scope || null,
  };
}

/* ── Pieces ──────────────────────────────────────────────────────────────── */

/**
 * The top of Home: which site you are looking at, then who you are.
 *
 * The big line used to be the Sensor Settings dashboard title — "Upande
 * Sensors" — which is the same on every site, on every screen, for everybody,
 * and so told the reader nothing they could act on. The selected site is the
 * one fact the whole rest of the screen is scoped by: the status card and the
 * per-dashboard counts are all about that site and nothing else, so naming it
 * here is naming the subject of the page.
 *
 * The logo is gone from the card. The header directly above it now carries the
 * mark, and repeating it 60px lower reads as a rendering fault rather than as
 * branding; a site name is also a place, which a brand mark does not introduce.
 * Losing it lets the name have the full card width, which matters — site names
 * run long ("Kuehne Nagel KN1 & KN2").
 *
 * `pending` is the post-login gap where the site is still being auto-picked. A
 * skeleton there rather than a title that resolves into a *different* string a
 * moment later, which is worse than one that visibly hasn't arrived yet. Once
 * settled, `site` is either a real name or `null` — "All sites", picked on
 * purpose from the header filter — and both read straight off `site` itself,
 * so there is no third, no-site-at-all case left to cover with a fallback.
 */
function Hero({ site, pending, name, message }) {
  const t = useTheme();
  return (
    <Card style={{ marginBottom: spacing.xl }}>
      <View>
        {pending ? (
          // Sized to the line it stands in for, so the card does not resize
          // under the reader when the name lands.
          <Skeleton width="65%" height={22} radius={radius.sm} />
        ) : (
          <Text numberOfLines={2} style={[type.title, { color: t.textPrimary }]}>
            {site || 'All sites'}
          </Text>
        )}
        <Text numberOfLines={1} style={[type.body, { color: t.textSecondary, marginTop: 2 }]}>
          {greeting()}
          {name ? ', ' : ''}
          {/* The name is the one word on the line that is about this person;
              it carries the weight, the greeting around it stays regular. */}
          {name ? (
            <Text style={{ color: t.textPrimary, fontWeight: '700', fontFamily: font('700') }}>{name}</Text>
          ) : null}
        </Text>
      </View>
      {message ? (
        <Text
          style={[
            type.body,
            {
              color: t.textSecondary,
              lineHeight: 20,
              marginTop: spacing.md,
              paddingTop: spacing.md,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: t.border,
            },
          ]}
        >
          {message}
        </Text>
      ) : null}
    </Card>
  );
}

/** One number of the live / stale / total trio. Word beside colour, always. */
function Count({ value, label, colour }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.7}
        style={[type.title, { color: colour || t.textPrimary, fontVariant: ['tabular-nums'] }]}
      >
        {value}
      </Text>
      <Text numberOfLines={1} style={[type.caption, { color: t.textSecondary }]}>
        {label}
      </Text>
    </View>
  );
}

function SiteStatusCard({ site, pending, counts, newest, error }) {
  const t = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Live readings for ${site || 'the selected site'}`}
      onPress={goToLive}
      style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1, marginBottom: spacing.xl })}
    >
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <View style={{ flex: 1 }}>
            <Text style={[type.label, { color: t.textSecondary, textTransform: 'uppercase' }]}>
              Site status
            </Text>
            <Text numberOfLines={1} style={[type.heading, { color: t.textPrimary, marginTop: 2 }]}>
              {/* `site` is null both while still picking AND once "All sites"
                  has been chosen — `pending` is what tells the two apart. */}
              {pending ? 'Loading…' : site || 'All sites'}
            </Text>
          </View>
          {pending ? (
            <Skeleton width={72} height={20} radius={radius.pill} />
          ) : error ? (
            <StatusChip tone="serious" label="Unavailable" />
          ) : newest ? (
            <StatusChip
              tone={isStale(newest) ? 'warning' : 'good'}
              label={relativeTime(newest) || 'Live'}
            />
          ) : (
            <StatusChip tone="serious" label="No data" />
          )}
        </View>

        <View
          style={{
            flexDirection: 'row',
            gap: spacing.md,
            marginTop: spacing.md,
            paddingTop: spacing.md,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: t.border,
          }}
        >
          {pending ? (
            [0, 1, 2].map((i) => (
              <View key={i} style={{ flex: 1, gap: 6 }}>
                <Skeleton width="50%" height={20} />
                <Skeleton width="70%" height={10} />
              </View>
            ))
          ) : (
            <>
              <Count value={counts.live} label="live" colour={t.status.good} />
              <Count
                value={counts.stale}
                label="stale"
                colour={counts.stale ? t.status.critical : t.textMuted}
              />
              <Count value={counts.total} label="sensors" />
            </>
          )}
        </View>

        {!pending && error ? (
          <Text style={[type.caption, { color: t.textMuted, marginTop: spacing.sm, lineHeight: 16 }]}>
            {error.message}
          </Text>
        ) : null}
      </Card>
    </Pressable>
  );
}

/**
 * "<total> sensors · <active> active · <stale> stale", on one line.
 *
 * The total leads because it is the number people came for; the other two are
 * its breakdown, in the colouring the header's site filter uses — active in
 * green, stale in red only when there is any. One row rather than two: the
 * three figures are one fact about the dashboard, and split across lines the
 * total read as a heading over the breakdown instead of part of it.
 */
function HealthLine({ health }) {
  const t = useTheme();
  if (!health) return null;
  const total = Number(health.total) || 0;
  const small = { fontSize: 10, lineHeight: 14, fontFamily: font('600') };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Text numberOfLines={1} style={[type.caption, small, { color: t.textSecondary }]}>
        {total} sensor{total === 1 ? '' : 's'}
      </Text>
      <Text style={[type.caption, small, { color: t.textMuted }]}>·</Text>
      <Text numberOfLines={1} style={[type.caption, small, { color: t.status.good }]}>
        {health.active} active
      </Text>
      <Text style={[type.caption, small, { color: t.textMuted }]}>·</Text>
      <Text
        numberOfLines={1}
        style={[type.caption, small, { color: health.stale ? t.status.critical : t.textMuted }]}
      >
        {health.stale} stale
      </Text>
    </View>
  );
}

function TabCard({ tab, width, active, onPress, health, healthLoading, showHealth }) {
  const t = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Open ${tab.title || tab.label} dashboard`}
      onPress={onPress}
      // Fixed width AND height: every tile in the grid is the same box, so a
      // long subtitle, a missing one, or a counts line that has not arrived
      // yet never makes one card taller than its neighbour. Each text row has
      // a fixed line count and ellipses instead of growing.
      style={({ pressed }) => ({ width, height: TILE_HEIGHT, flexGrow: 0, opacity: pressed ? 0.8 : 1 })}
    >
      <Card
        style={{
          flex: 1,
          // The active dashboard is marked the way the sidebar marks it — an
          // accent edge, not a coloured label.
          borderColor: active ? t.accent : t.border,
          borderWidth: active ? 1.5 : StyleSheet.hairlineWidth,
        }}
      >
        <View
          style={{
            width: 36,
            height: 36,
            borderRadius: radius.md,
            backgroundColor: t.accentSoft,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: spacing.sm,
          }}
        >
          <Ionicons name={iconForTab(tab)} size={20} color={t.accent} />
        </View>
        {/* Two lines reserved whether the title needs them or not. */}
        <Text numberOfLines={2} style={[type.heading, { color: t.textPrimary, lineHeight: 20, height: 40 }]}>
          {tab.title || tab.label}
        </Text>
        {/*
          How many sensors this dashboard has — the question a tile is actually
          being asked.

          It used to read "2 sensor types", or the word "Dashboard" where a tab
          configured none. Neither is information: the type count says how the
          dashboard was set up, not what is on it, and "Dashboard" says only
          that a dashboard is a dashboard. The number here is
          `tabs[tab.name].total` from `dashboard_health`, which is scoped to the
          sensors ASSIGNED to this dashboard — placed on its floor plan, or
          carrying its Sensor Monitoring Type — and never the site's total.

          The row keeps its height whatever it contains, so a tile without
          counts still lines up with the one beside it.
        */}
        <View style={{ height: 16, marginTop: 2, justifyContent: 'center' }}>
          {!showHealth ? null : healthLoading ? (
            <Skeleton width="70%" height={10} />
          ) : (
            <HealthLine health={health} />
          )}
        </View>
      </Card>
    </Pressable>
  );
}

/** Icon 36 + gap 8 + title 40 + counts row 18 + card padding 32. */
const TILE_HEIGHT = 134;

/**
 * The sensor roster, in one tile: is it reporting (active/stale, the same
 * numbers `SiteStatusCard` shows) and is it positioned (with/without
 * coordinates, from `location_coverage`) — the two questions the map and the
 * coordinates screen each answer, so the tile is the front door to both.
 *
 * The whole card opens the sensor list; the "+" is its own target (the
 * header's own add-coordinates button, repeated here so Home offers the same
 * shortcut) and stops its own touch from also opening the list underneath it.
 */
function SensorListTile({ counts, coverage, coverageLoading, coverageUnsupported, canSet, pending }) {
  const t = useTheme();
  const rowStyle = {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.border,
  };
  const skeletonPair = (key) => (
    <View key={key} style={{ flex: 1, gap: 6 }}>
      <Skeleton width="50%" height={20} />
      <Skeleton width="70%" height={10} />
    </View>
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open the sensor list"
      onPress={() => goToSensorMap()}
      style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1, marginBottom: spacing.md })}
    >
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: radius.md,
              backgroundColor: t.accentSoft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Ionicons name="map-outline" size={20} color={t.accent} />
          </View>
          <Text style={[type.heading, { color: t.textPrimary, flex: 1 }]}>Sensor list</Text>
          {canSet ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add a sensor's coordinates"
              onPress={(event) => {
                event.stopPropagation();
                goToSensorLocation();
              }}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, padding: 2 })}
            >
              <Ionicons name="add-circle-outline" size={22} color={t.accent} />
            </Pressable>
          ) : null}
          <Ionicons name="chevron-forward" size={16} color={t.textMuted} />
        </View>

        <View style={rowStyle}>
          {pending ? (
            [0, 1].map(skeletonPair)
          ) : (
            <>
              <Count value={counts.live} label="active" colour={t.status.good} />
              <Count
                value={counts.stale}
                label="stale"
                colour={counts.stale ? t.status.critical : t.textMuted}
              />
            </>
          )}
        </View>

        {/* Coordinate coverage needs its own server support (location_coverage
            is app-only, no Server Script fallback); an older server just gets
            one row of counts instead of two, not a row of false zeros. */}
        {coverageUnsupported ? null : (
          <View style={rowStyle}>
            {pending || coverageLoading ? (
              [0, 1].map(skeletonPair)
            ) : (
              <>
                <Count value={coverage.with_coordinates ?? 0} label="with coordinates" colour={t.status.good} />
                <Count
                  value={coverage.without_coordinates ?? 0}
                  label="without coordinates"
                  colour={coverage.without_coordinates ? t.status.warning : t.textMuted}
                />
              </>
            )}
          </View>
        )}
      </Card>
    </Pressable>
  );
}

/**
 * A phone number or an email, as configured. Anything with an `@` is mail;
 * anything that is digits with the usual punctuation is a call; anything else
 * — a name, a desk, "ask the office" — is shown but not made tappable, because
 * a link that opens nothing is worse than plain text.
 */
function contactHref(contact) {
  const text = String(contact || '').trim();
  if (!text) return null;
  if (text.includes('@')) return `mailto:${text}`;
  if (/^\+?[\d\s().-]{6,}$/.test(text)) return `tel:${text.replace(/[^\d+]/g, '')}`;
  return null;
}

function SupportLine({ contact }) {
  const t = useTheme();
  const href = contactHref(contact);
  const open = useCallback(() => {
    if (!href) return;
    Linking.openURL(href).catch(() => {
      // No dialler or mail app on this device. The text is still on screen.
    });
  }, [href]);

  return (
    <Pressable
      accessibilityRole={href ? 'link' : 'text'}
      disabled={!href}
      onPress={open}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.xs,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Ionicons
        name={href?.startsWith('tel:') ? 'call-outline' : 'help-buoy-outline'}
        size={17}
        color={t.textSecondary}
      />
      <Text style={[type.caption, { color: t.textSecondary }]}>Support</Text>
      <Text
        numberOfLines={1}
        style={[
          type.caption,
          { color: href ? t.accent : t.textPrimary, flex: 1, fontFamily: font('600') },
        ]}
      >
        {contact}
      </Text>
    </Pressable>
  );
}

/* ── Screen ──────────────────────────────────────────────────────────────── */

export function HomeScreen() {
  const t = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const { user } = useAuth();
  const {
    site,
    sitePending,
    sitesLoading,
    tabs,
    activeTabName,
    selectTab,
    configLoading,
    configError,
    welcomeMessage,
    supportContact,
    unitForType,
    refreshReference,
    appSettings,
  } = useDashboard();

  /**
   * Its own key, NOT `liveKey(site)`.
   *
   * `fetchLiveForSite` caches under `liveKey` itself. Handing `useQuery` that
   * same key would make the loader ask `cached` for the key it was being loaded
   * for — the re-entrant cycle `cache.js` documents, which never settles. So
   * this reads the shared request through `loadLiveForSite`, which caches only
   * under `siteKey`, and keeps a Home-specific outer key for the hook.
   */
  const live = useQuery(
    sitePending ? null : cacheKey('home_live', { site }),
    () => loadLiveForSite(site),
    { ttl: TTL_LIVE },
  );

  const sensors = useMemo(
    () => (Array.isArray(live.data?.sensors) ? live.data.sensors : EMPTY_SENSORS),
    [live.data],
  );
  const values = useMemo(() => live.data?.live || EMPTY_LIVE, [live.data]);

  // Same arithmetic as the Live screen's header tallies, so the two agree.
  const counts = useMemo(() => {
    let reporting = 0;
    let stale = 0;
    sensors.forEach((s) => {
      const entry = values[s.sensor_name];
      const params = entry?.params?.length ? entry.params : entry ? [entry] : [];
      if (!params.length) return;
      reporting += 1;
      const latest = params.reduce((newest, p) => (p.ts > (newest || '') ? p.ts : newest), null);
      if (isStale(latest)) stale += 1;
    });
    return { total: sensors.length, live: reporting - stale, stale };
  }, [sensors, values]);

  const newest = useMemo(() => latestStamp(live.data), [live.data]);

  /**
   * Per-dashboard sensor tallies, once per site. App-only, newer than the
   * rest: on a server without it the cards simply carry no counts line — a
   * row of zeros would claim every dashboard is empty.
   */
  const health = useQuery(
    sitePending ? null : cacheKey('dashboard_health', { site }),
    () => getDashboardHealth(site),
    { ttl: TTL_LIVE },
  );
  // A server with neither the app method nor the Server Script deployed. The
  // tiles then carry no count at all: a fallback number would be the site's
  // total wearing a dashboard's name.
  const healthUnsupported = Boolean(health.error?.isMissingEndpoint);

  /**
   * With/without coordinates, for the Sensor list tile. App-only (no Server
   * Script fallback), so an older server answers `isMissingEndpoint` and the
   * tile drops that row rather than showing false zeros.
   */
  const coverage = useQuery(
    sitePending ? null : cacheKey('location_coverage', { site }),
    () => getLocationCoverage(site),
    { ttl: TTL_LIVE },
  );
  const coverageUnsupported = Boolean(coverage.error?.isMissingEndpoint);

  const refresh = useCallback(async () => {
    // Gated on `sitePending`, not `site`: "All sites" is `site === null` once
    // settled, and a pull there must still refresh — it was skipping the
    // invalidation and the refetch entirely, so pulling to refresh on "All
    // sites" silently did nothing.
    if (!sitePending) {
      // `siteKey` is the shared request; leaving it cached would hand the same
      // payload straight back and the pull would fetch nothing. `liveKey` is
      // the Live screen's copy of it, dropped so the two screens agree.
      invalidate(siteKey(site));
      invalidate(liveKey(site));
      invalidate(cacheKey('dashboard_health', { site }));
      invalidate(cacheKey('location_coverage', { site }));
    }
    await Promise.all([
      !sitePending ? live.refresh() : Promise.resolve(),
      !sitePending && !healthUnsupported ? health.refresh() : Promise.resolve(),
      !sitePending && !coverageUnsupported ? coverage.refresh() : Promise.resolve(),
      refreshReference(),
    ]);
  }, [site, sitePending, live, health, healthUnsupported, coverage, coverageUnsupported, refreshReference]);

  const pending = sitePending || sitesLoading || live.loading;
  const refreshing = live.refreshing;

  // Two columns, whatever the phone: the gap is subtracted once, the padding
  // twice, and the remainder is split. Floor so rounding cannot push the
  // second card onto a third row.
  const columnWidth = Math.floor((screenWidth - spacing.lg * 2 - spacing.md) / 2);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: t.background }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={refresh}
          tintColor={t.accent}
          colors={[t.accent]}
        />
      }
    >
      <Hero
        site={site}
        // Only the pick itself, not the readings: the name is known as soon as
        // the site is, and waiting on `live` would skeleton a settled title.
        pending={sitePending || sitesLoading}
        name={user?.fullName || user?.name}
        message={welcomeMessage}
      />

      <SiteStatusCard
        site={site}
        pending={pending}
        counts={counts}
        newest={newest}
        error={live.error}
      />

      {/* No alerts card here any more: limit breaches live behind the bell in
          the header, across every site, where they do not crowd the landing
          page or vanish when the site filter changes. */}

      <SectionTitle>Dashboards</SectionTitle>
      {configLoading ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.xl }}>
          {[0, 1, 2, 3].map((i) => (
            // The tile's real height, not a hardcoded guess: a placeholder 30px
            // short made the whole page below it jump once the tabs arrived.
            <Skeleton key={i} width={columnWidth} height={TILE_HEIGHT} radius={radius.lg} />
          ))}
        </View>
      ) : configError ? (
        <Text
          style={[
            type.caption,
            { color: t.status.serious, lineHeight: 17, marginBottom: spacing.xl },
          ]}
        >
          ▲ Couldn’t load tabs — {configError.message}
        </Text>
      ) : tabs.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.xl }}>
          {tabs.map((tab) => (
            <TabCard
              key={tab.name}
              tab={tab}
              width={columnWidth}
              active={tab.name === activeTabName}
              onPress={() => selectTab(tab.name)}
              showHealth={Boolean(site) && !healthUnsupported}
              healthLoading={health.loading || sitePending}
              // By `tab.name` and nothing else — see `healthForTab`.
              health={healthForTab(health.data, tab)}
            />
          ))}
        </View>
      ) : (
        <Card style={{ marginBottom: spacing.xl }}>
          <EmptyState
            title="No dashboards"
            message="No tabs are enabled in Sensor Settings for your account."
          />
        </Card>
      )}

      {/* Readings and Account are still one tap away — the bottom tab bar and
          the header's account icon — so dropping their shortcuts here does
          not strand either screen; it makes room for the roster below. */}
      <SensorListTile
        counts={counts}
        coverage={coverage.data || EMPTY_COVERAGE}
        coverageLoading={coverage.loading}
        coverageUnsupported={coverageUnsupported}
        canSet={Boolean(appSettings?.can_set_location)}
        pending={pending}
      />

      {supportContact ? <SupportLine contact={supportContact} /> : null}
    </ScrollView>
  );
}
