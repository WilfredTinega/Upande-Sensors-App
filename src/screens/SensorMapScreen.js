import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { WebView } from 'react-native-webview';

import { Button, EmptyState, ErrorView } from '../components/ui';
import { Skeleton } from '../components/Skeleton';
import { TTL_LIVE, cacheKey } from '../api/cache';
import { getSensorMap } from '../api/endpoints';
import { useDashboard } from '../context/DashboardContext';
import { useQuery } from '../hooks/useQuery';
import { goToSensorDetail, goToSensorLocation } from '../navigation/ref';
import { useTheme, spacing, radius, type } from '../hooks/useTheme';
import { font } from '../theme';
import { relativeTime } from '../utils/dates';
import { formatMetres, hasCoordinates } from '../utils/geo';

/**
 * Every positioned sensor at the selected site on a map, coloured by whether
 * it is reporting, with a tap through to the sensor's own screen.
 *
 * Leaflet in a WebView rather than a native map SDK: react-native-maps needs a
 * Google Maps API key and a Play-services device, and the website already
 * draws its maps with Leaflet — so this is the same picture the desk shows,
 * with the same tiles (Mapbox when the site has a token, OpenStreetMap when it
 * has not), and no key or account to keep alive. The map needs the internet
 * for tiles and for Leaflet itself, which the app needs for everything else.
 *
 * Nothing the server sent is ever put into the page as HTML. The page is a
 * fixed string with no data in it; every payload goes in afterwards as a JSON
 * literal through `injectJavaScript`, and the page builds its popups with
 * `textContent` and `createElement`. A sensor called `<img onerror=…>` is a
 * sensor called that.
 */

/** How often the map re-asks while it is on screen. Same cadence as Live. */
const POLL_MS = 60 * 1000;

const EMPTY_SENSORS = [];

/* ── The header's refresh button, talking to whichever map is mounted ─────── */

/**
 * A ScrollView refresh control does not mix with a WebView — the pull gesture
 * is the map's pan — so refreshing is a header icon instead. The header is
 * rendered by the navigator, outside this screen, so the two meet through a
 * tiny module-level bus: the button asks, the mounted screen answers, and the
 * button spins for as long as the screen says it is busy.
 */
const refreshRequests = new Set();
const busyListeners = new Set();
let busy = false;

function setMapBusy(next) {
  if (next === busy) return;
  busy = next;
  busyListeners.forEach((fn) => fn(next));
}

export function SensorMapRefreshButton() {
  const t = useTheme();
  const [spinning, setSpinning] = useState(busy);
  useEffect(() => {
    busyListeners.add(setSpinning);
    setSpinning(busy);
    return () => busyListeners.delete(setSpinning);
  }, []);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Refresh the map"
      accessibilityState={{ busy: spinning }}
      disabled={spinning}
      onPress={() => refreshRequests.forEach((fn) => fn())}
      hitSlop={8}
      style={({ pressed }) => ({
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {spinning ? (
        <ActivityIndicator size="small" color={t.accent} />
      ) : (
        <Ionicons name="refresh" size={22} color={t.textPrimary} />
      )}
    </Pressable>
  );
}

/**
 * The header's own "add coordinates" button — for whichever site the header's
 * own filter is set to, so it reads as "add a sensor's position AT THIS SITE"
 * rather than a generic, site-less shortcut.
 *
 * Placed here rather than only in the two empty states below: those only show
 * while the map has nothing (or the server can't answer at all), so once a
 * single sensor at a site gets a pin, every OTHER unlocated sensor at that
 * same site lost its only way in. A header button is visible in every state —
 * loading, populated, or empty — because "add one more" is exactly as common
 * a need as "add the first one".
 */
export function SensorMapAddLocationButton() {
  const t = useTheme();
  const { appSettings } = useDashboard();
  if (!appSettings?.can_set_location) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Set a sensor's coordinates at this site"
      onPress={() => goToSensorLocation()}
      hitSlop={8}
      style={({ pressed }) => ({
        width: 36,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name="add-circle-outline" size={24} color={t.accent} />
    </Pressable>
  );
}

/* ── The page ────────────────────────────────────────────────────────────── */

/**
 * OpenStreetMap's public tiles, no key. Mapbox's raster tiles when the site
 * has a token — the website's basemap, so the phone and the desk agree on what
 * the ground looks like. Mapbox serves 512 px tiles one zoom level "ahead",
 * which is what `tileSize`/`zoomOffset` correct for.
 */
/**
 * The basemap, streets or satellite, with or without a Mapbox token.
 *
 * With a token: Mapbox's own satellite-streets style — imagery WITH the road
 * and place labels drawn over it, which is what every real map app calls
 * "satellite" (bare imagery with no labels is hard to read a farm layout on).
 * Without one: Esri World Imagery, the same no-key satellite source the
 * website and the desk Sensor form already draw from — so a site with no
 * Mapbox token still gets imagery, just without Mapbox's road labels on top.
 */
function tilesFor(token, satellite) {
  if (satellite) {
    if (token) {
      return {
        url: `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/{z}/{x}/{y}?access_token=${encodeURIComponent(token)}`,
        attribution: '© Mapbox © Maxar',
        maxZoom: 22,
        tileSize: 512,
        zoomOffset: -1,
      };
    }
    return {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: '© Esri, Maxar, Earthstar Geographics',
      maxZoom: 19,
      tileSize: 256,
      zoomOffset: 0,
    };
  }
  if (token) {
    return {
      url: `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/{z}/{x}/{y}?access_token=${encodeURIComponent(token)}`,
      attribution: '© Mapbox © OpenStreetMap',
      maxZoom: 22,
      tileSize: 512,
      zoomOffset: -1,
    };
  }
  return {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
    tileSize: 256,
    zoomOffset: 0,
  };
}

/**
 * The HTML, once. Theme colours are the only thing baked in — they are the
 * app's own constants, not server data — so a theme change rebuilds the page
 * and nothing else ever does. Leaflet 1.9.4 from unpkg, pinned.
 */
function buildHtml(t) {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html, body, #map { margin: 0; height: 100%; background: ${t.background}; }
  .leaflet-container { font-family: -apple-system, Roboto, sans-serif; }
  .lbl { background: ${t.surface}; color: ${t.textPrimary}; border: 1px solid ${t.border}; border-radius: 6px;
         padding: 2px 6px; font-size: 11px; font-weight: 600; box-shadow: none; white-space: nowrap; }
  .lbl::before { border-top-color: ${t.border}; }
  .leaflet-popup-content-wrapper { background: ${t.surface}; color: ${t.textPrimary}; border-radius: 12px;
         border: 1px solid ${t.border}; box-shadow: 0 6px 20px rgba(0,0,0,0.18); }
  .leaflet-popup-tip { background: ${t.surface}; }
  .leaflet-popup-content { margin: 12px 14px; min-width: 180px; font-size: 13px; line-height: 18px; }
  .pp-name { font-weight: 700; font-size: 15px; margin-bottom: 2px; }
  .pp-site { color: ${t.textSecondary}; font-size: 12px; margin-bottom: 8px; }
  .pp-row { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; }
  .pp-row .k { color: ${t.textSecondary}; text-transform: capitalize; }
  .pp-row .v { font-variant-numeric: tabular-nums; font-weight: 600; }
  .pp-status { display: flex; align-items: center; gap: 6px; margin-top: 8px; color: ${t.textSecondary}; font-size: 12px; }
  .pp-dot { width: 8px; height: 8px; border-radius: 4px; display: inline-block; }
  .pp-open { display: block; width: 100%; margin-top: 10px; padding: 9px 0; border: 0; border-radius: 8px;
         background: ${t.accent}; color: ${t.onAccent}; font-weight: 700; font-size: 13px; }
  .leaflet-control-attribution { font-size: 9px; background: rgba(255,255,255,0.7); }
  .leaflet-bar a { background: ${t.surface}; color: ${t.textPrimary}; border-color: ${t.border}; }
</style>
</head><body>
<div id="map"></div>
<script>
(function () {
  var map = null, tiles = null, tilesUrl = null, layer = null, fitted = false, byName = {};
  var post = function (msg) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  };
  function ensureMap() {
    if (map) return map;
    map = L.map('map', { zoomControl: true, attributionControl: true, tap: false });
    map.setView([0, 20], 2);
    return map;
  }
  function setTiles(next) {
    if (!next || next.url === tilesUrl) return;
    if (tiles) tiles.remove();
    tilesUrl = next.url;
    tiles = L.tileLayer(next.url, {
      attribution: next.attribution, maxZoom: next.maxZoom,
      tileSize: next.tileSize, zoomOffset: next.zoomOffset
    }).addTo(ensureMap());
  }
  // Built with createElement + textContent only: the strings are the server's.
  function popupFor(s) {
    var root = document.createElement('div');
    var name = document.createElement('div'); name.className = 'pp-name'; name.textContent = s.label; root.appendChild(name);
    if (s.site) { var site = document.createElement('div'); site.className = 'pp-site'; site.textContent = s.site; root.appendChild(site); }
    (s.rows || []).forEach(function (r) {
      var row = document.createElement('div'); row.className = 'pp-row';
      var k = document.createElement('span'); k.className = 'k'; k.textContent = r.k;
      var v = document.createElement('span'); v.className = 'v'; v.textContent = r.v;
      row.appendChild(k); row.appendChild(v); root.appendChild(row);
    });
    var st = document.createElement('div'); st.className = 'pp-status';
    var dot = document.createElement('span'); dot.className = 'pp-dot'; dot.style.background = s.color;
    var txt = document.createElement('span'); txt.textContent = s.statusText;
    st.appendChild(dot); st.appendChild(txt); root.appendChild(st);
    var btn = document.createElement('button'); btn.className = 'pp-open'; btn.type = 'button'; btn.textContent = 'Open';
    btn.addEventListener('click', function () { post({ type: 'open', name: s.name }); });
    root.appendChild(btn);
    return root;
  }
  window.setSensors = function (payload) {
    var m = ensureMap();
    setTiles(payload.tiles);
    if (layer) layer.remove();
    layer = L.layerGroup().addTo(m);
    byName = {};
    var bounds = [];
    (payload.sensors || []).forEach(function (s) {
      var at = [s.lat, s.lng];
      bounds.push(at);
      if (s.accuracy > 0) {
        L.circle(at, { radius: s.accuracy, color: s.color, weight: 1, opacity: 0.5, fillColor: s.color, fillOpacity: 0.08, interactive: false }).addTo(layer);
      }
      var marker = L.circleMarker(at, { radius: 8, color: '#ffffff', weight: 2, fillColor: s.color, fillOpacity: 1 }).addTo(layer);
      marker.bindTooltip(s.label, { permanent: true, direction: 'top', offset: [0, -9], className: 'lbl', opacity: 1 });
      marker.bindPopup(popupFor(s), { closeButton: false, maxWidth: 260 });
      byName[s.name] = marker;
    });
    if (payload.fit || !fitted) {
      if (bounds.length > 1) m.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
      else if (bounds.length === 1) m.setView(bounds[0], 17);
      else if (payload.center) m.setView([payload.center.lat, payload.center.lng], 14);
      fitted = true;
    }
    if (payload.focus && byName[payload.focus]) {
      var mk = byName[payload.focus];
      m.setView(mk.getLatLng(), Math.max(m.getZoom(), 17));
      mk.openPopup();
    }
  };
  ensureMap();
  post({ type: 'ready' });
})();
</script>
</body></html>`;
}

/**
 * JSON that is safe to drop inside a JavaScript source string. `JSON.stringify`
 * is already valid JS, except for the two line terminators JSON allows and JS
 * does not; a `</script>` is harmless here because this never goes into HTML.
 */
function asJsLiteral(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/* ── Pieces ──────────────────────────────────────────────────────────────── */

function LegendChip({ colour, label, count }) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: radius.pill,
        backgroundColor: t.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.border,
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colour }} />
      <Text style={[type.caption, { color: t.textPrimary, fontFamily: font('600'), fontVariant: ['tabular-nums'] }]}>
        {count}
      </Text>
      <Text style={[type.caption, { color: t.textSecondary }]}>{label}</Text>
    </View>
  );
}

/**
 * online / offline / none for a row: the third is a sensor that has never
 * reported inside the lookback window, which is grey — a different problem
 * from one that went quiet, which is red.
 */
function statusOf(s) {
  if (!s.last_reading) return 'none';
  return s.online ? 'online' : 'offline';
}

/** Value text for one measure: "24.7 °C", "—" when null. */
function valueText(v) {
  const n = Number(v?.value);
  if (!Number.isFinite(n)) return '—';
  const shown = Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2);
  return v?.unit ? `${shown} ${v.unit}` : shown;
}

/* ── Screen ──────────────────────────────────────────────────────────────── */

export function SensorMapScreen({ route }) {
  const t = useTheme();
  const focused = useIsFocused();
  const { site, sitePending, sitesLoading, appSettings } = useDashboard();
  const canSet = Boolean(appSettings?.can_set_location);
  const focusName = route?.params?.focus || null;

  const ready = !sitePending && !sitesLoading;
  const query = useQuery(
    ready ? cacheKey('sensor_map', { site: site || '' }) : null,
    () => getSensorMap({ site }),
    // Polls only while this is the screen on top: a hidden tab stays mounted
    // after a visit, and a map nobody is looking at should not spend data.
    { ttl: TTL_LIVE, pollMs: focused ? POLL_MS : 0 },
  );

  /**
   * Streets or satellite. Per-session only (not persisted): the choice is
   * about what you are looking at right now — verifying a pin sits on the
   * actual greenhouse roof, say — not a standing preference, and the last
   * thing a map screen should do is silently remember a mode from a previous
   * visit that nobody meant to leave it in.
   */
  const [satellite, setSatellite] = useState(false);

  const sensors = useMemo(
    () => (Array.isArray(query.data?.sensors) ? query.data.sensors : EMPTY_SENSORS).filter(hasCoordinates),
    [query.data],
  );
  const counts = useMemo(() => {
    const out = { online: 0, offline: 0, none: 0 };
    sensors.forEach((s) => {
      out[statusOf(s)] += 1;
    });
    return out;
  }, [sensors]);

  const colours = useMemo(
    () => ({ online: t.status.good, offline: t.status.critical, none: t.textMuted }),
    [t],
  );

  /**
   * What the page draws — every display string decided here, in RN, so the
   * page only ever places text. Relative times are computed at build time and
   * refreshed with each poll, which is often enough for "12m ago".
   */
  const payload = useMemo(() => {
    const token = String(query.data?.map?.mapbox_token || '').trim();
    const center = query.data?.center;
    return {
      tiles: tilesFor(token, satellite),
      center:
        center && Number.isFinite(Number(center.latitude)) && Number.isFinite(Number(center.longitude))
          ? { lat: Number(center.latitude), lng: Number(center.longitude) }
          : null,
      sensors: sensors.map((s) => {
        const status = statusOf(s);
        const rows = Object.keys(s.values || {})
          .sort()
          .map((k) => ({ k: k || 'value', v: valueText(s.values[k]) }));
        const age = s.last_reading ? relativeTime(s.last_reading) : null;
        const acc = formatMetres(s.location_accuracy_m);
        return {
          name: s.sensor_name,
          label: s.sensor_name,
          site: s.sensor_site || site || '',
          lat: Number(s.latitude),
          lng: Number(s.longitude),
          accuracy: Number(s.location_accuracy_m) || 0,
          color: colours[status],
          rows,
          statusText:
            status === 'none'
              ? `No reading${acc ? ` · ${acc}` : ''}`
              : `${status === 'online' ? 'Online' : 'Offline'} · ${age || s.last_reading}${acc ? ` · ${acc}` : ''}`,
        };
      }),
    };
  }, [query.data, sensors, colours, site, satellite]);

  /* ── WebView plumbing ── */

  const webRef = useRef(null);
  const pageReady = useRef(false);
  const fittedFor = useRef(null);
  // The focus param is consumed once per arrival, not on every poll: a popup
  // that reopened itself every minute would fight the reader.
  const focusPending = useRef(null);
  useEffect(() => {
    focusPending.current = focusName;
  }, [focusName, route?.params]);

  const push = useCallback(() => {
    if (!pageReady.current || !webRef.current) return;
    const refit = fittedFor.current !== (site || '');
    fittedFor.current = site || '';
    const body = { ...payload, fit: refit, focus: focusPending.current };
    focusPending.current = null;
    webRef.current.injectJavaScript(`window.setSensors(${asJsLiteral(body)}); true;`);
  }, [payload, site]);

  useEffect(() => {
    if (query.data) push();
  }, [push, query.data]);

  const onMessage = useCallback(
    (event) => {
      let msg = null;
      try {
        msg = JSON.parse(event?.nativeEvent?.data || 'null');
      } catch {
        return;
      }
      if (msg?.type === 'ready') {
        pageReady.current = true;
        if (query.data) push();
      } else if (msg?.type === 'open' && msg.name) {
        const hit = sensors.find((s) => s.sensor_name === msg.name);
        if (!hit) return;
        goToSensorDetail({
          site: hit.sensor_site || site,
          sensorName: hit.sensor_name,
          sensorType: hit.sensor_type || null,
        });
      }
    },
    [query.data, push, sensors, site],
  );

  // The header button's request, answered by whichever map is mounted.
  useEffect(() => {
    const handle = async () => {
      setMapBusy(true);
      try {
        await query.refresh();
      } finally {
        setMapBusy(false);
      }
    };
    refreshRequests.add(handle);
    return () => refreshRequests.delete(handle);
  }, [query]);

  // Theme colours are baked into the page, so the page follows the theme.
  const html = useMemo(() => buildHtml(t), [t]);
  useEffect(() => {
    pageReady.current = false;
  }, [html]);

  /* ── Render ── */

  const unsupported = Boolean(query.error?.isMissingEndpoint);

  return (
    <View style={{ flex: 1, backgroundColor: t.background }}>
      {/* Legend: the three colours with their counts, as words beside dots —
          the colour never carries the meaning on its own. */}
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: spacing.sm,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
          alignItems: 'center',
        }}
      >
        {query.loading && !query.data ? (
          <>
            <Skeleton width={84} height={24} radius={radius.pill} />
            <Skeleton width={84} height={24} radius={radius.pill} />
            <Skeleton width={96} height={24} radius={radius.pill} />
          </>
        ) : (
          <>
            <LegendChip colour={colours.online} label="online" count={counts.online} />
            <LegendChip colour={colours.offline} label="offline" count={counts.offline} />
            <LegendChip colour={colours.none} label="no reading" count={counts.none} />
            {query.refreshing ? <ActivityIndicator size="small" color={t.accent} /> : null}
          </>
        )}
      </View>

      {query.error && !unsupported ? <ErrorView error={query.error} onRetry={query.refresh} /> : null}

      {unsupported ? (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <EmptyState
            title="The sensor list needs a newer server"
            message="This site's upande_sensors does not have the sensor_map endpoint yet. Deploy the app update or the Server Scripts under server/ and the list appears here."
            // Coordinate capture is a SEPARATE endpoint from the map/list read,
            // and the two are deployed independently — a site missing
            // `sensor_map` can still have `set_sensor_location`. Offering the
            // button here, not just once the map has data, is the difference
            // between "nothing to do until IT gets deployed" and "go place a
            // sensor while you wait".
            action={canSet ? <Button label="Set coordinates" onPress={() => goToSensorLocation()} /> : null}
          />
        </View>
      ) : query.data && !sensors.length ? (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <EmptyState
            title="No sensor has coordinates yet"
            message={
              site
                ? `None of the sensors at ${site} has a position. ${
                    canSet
                      ? 'Stand beside one with the phone and set it.'
                      : 'An installer can set them from the phone.'
                  }`
                : 'No sensor at any of your sites has a position.'
            }
            action={canSet ? <Button label="Set coordinates" onPress={() => goToSensorLocation()} /> : null}
          />
        </View>
      ) : (
        <View style={{ flex: 1, overflow: 'hidden' }}>
          {/* The page stays mounted through polls and site changes: only the
              data is re-injected, so the viewport survives a refresh. */}
          <WebView
            ref={webRef}
            originWhitelist={['*']}
            source={{ html }}
            onMessage={onMessage}
            onLoadEnd={() => {
              // `ready` normally arrives from the page itself; this covers a
              // page that loaded before the bridge was listening.
              if (!pageReady.current) {
                pageReady.current = true;
                if (query.data) push();
              }
            }}
            javaScriptEnabled
            domStorageEnabled
            setSupportMultipleWindows={false}
            overScrollMode="never"
            style={{ flex: 1, backgroundColor: t.background }}
            renderLoading={() => null}
          />

          {/* Streets / satellite, floating over the top-right corner of the
              map itself — a map-view control, not a page action, so it sits
              on the map the way the zoom buttons and the attribution line do,
              rather than crowding the header next to the site filter. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={satellite ? 'Switch to streets view' : 'Switch to satellite view'}
            accessibilityState={{ selected: satellite }}
            onPress={() => setSatellite((v) => !v)}
            style={({ pressed }) => ({
              position: 'absolute',
              top: spacing.sm,
              right: spacing.sm,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingVertical: 6,
              paddingHorizontal: 10,
              borderRadius: radius.pill,
              backgroundColor: t.surface,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: t.border,
              opacity: pressed ? 0.75 : 1,
              elevation: 3,
              shadowColor: '#000',
              shadowOpacity: 0.15,
              shadowRadius: 4,
              shadowOffset: { width: 0, height: 1 },
            })}
          >
            <Ionicons
              name={satellite ? 'map-outline' : 'globe-outline'}
              size={15}
              color={t.textPrimary}
            />
            <Text style={{ fontSize: 12, fontWeight: '600', color: t.textPrimary }}>
              {satellite ? 'Streets' : 'Satellite'}
            </Text>
          </Pressable>

          {query.loading && !query.data ? (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: 0,
                bottom: 0,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: t.background,
              }}
            >
              <ActivityIndicator size="large" color={t.accent} />
            </View>
          ) : null}
        </View>
      )}
    </View>
  );
}
