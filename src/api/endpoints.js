/**
 * Typed-ish wrappers over the API this app is served by.
 *
 * Every loader tries up to three addresses for the same answer, in this order:
 *
 *   1. `upande_sensors.api.mobile.<name>` — the whitelisted methods that ship
 *      inside the `upande_sensors` Frappe app (`upande_sensors/api/mobile.py`).
 *      This is where the API lives now: versioned with the app, installed by
 *      `bench migrate`, and no longer dependent on Server Scripts being enabled
 *      for the site.
 *   2. `upande_sensors_app.<name>` — the Server Scripts kept under
 *      `server/scripts/` in this repo. Same params, same response shapes: they
 *      were the first home of this API, and they stay deployed as the answer for
 *      a site whose `upande_sensors` is older than the client.
 *   3. `LEGACY` — the calls both of those replaced, where one exists.
 *
 * `APP` and `SCRIPT` name the same set of endpoints, so a broken call can be
 * traced to the Python that serves it without guessing — see `server/README.md`.
 *
 * Why the app has its own endpoints rather than calling the `upande_sensors`
 * app's older whitelisted methods and Frappe's generic client API directly:
 *
 *  1. Permissions. The generic API enforces doctype permissions, and the
 *     doctypes this app reads are locked down — `Sensor Reading` grants read to
 *     System Manager and Water Operator, `Route History` and `Activity Log` to
 *     System Manager, `Issue` create to Support Team, and `Route History`
 *     create to nobody at all. So the history screen, the activity screen and
 *     the report button each failed for the accounts that could see everything
 *     else. The Server Scripts scope by Sensor Site instead, which is the rule
 *     the rest of the app already follows.
 *
 *  2. Round trips. One call against the cloud instance costs about a second
 *     before any query runs, so what makes the app slow is the *number* of
 *     requests. Sign-in was five identity calls; the Live screen two sequential
 *     ones; a chart four parallel ones; a page of history two. Each of those is
 *     now one.
 *
 *  3. Reach. `frappe.utils.change_log.get_versions` is not whitelisted on any
 *     site, and `System Settings.time_zone` is System Manager only, so the app
 *     could not tell most accounts what the server was running or what timezone
 *     it kept.
 *
 * An instance that lacks an endpoint answers "Failed to get method for command
 * …", which the client reports as `isMissingEndpoint` — `viaChain` moves to the
 * next address on exactly that error, so the app keeps working against a site
 * where the app method is absent, the scripts are absent, or both are older
 * than the client. A permission error is NOT a fallback trigger: it is the
 * server's real answer.
 */

import { TTL_LIVE, TTL_REFERENCE, cacheKey, cached } from './cache';
import { client, FrappeError } from './client';

export { FrappeError };

/** The endpoint names, shared by the app methods and the Server Scripts. */
const NAMES = {
  whoami: 'whoami',
  config: 'config',
  sensorNames: 'sensor_names',
  live: 'live',
  chartSeries: 'chart_series',
  readings: 'readings',
  activity: 'activity',
  logRoutes: 'log_routes',
  reportsList: 'reports_list',
  reportSubmit: 'report_submit',
  assignableUsers: 'assignable_users',
  dashboardHealth: 'dashboard_health',
  floorPlans: 'floor_plans',
  sensorsForLocation: 'sensors_for_location',
  setSensorLocation: 'set_sensor_location',
  sensorLocationHistory: 'sensor_location_history',
  sensorMap: 'sensor_map',
};

/** Whitelisted methods inside the `upande_sensors` app. Tried first. */
const APP = Object.fromEntries(
  Object.entries(NAMES).map(([key, name]) => [key, `upande_sensors.api.mobile.${name}`]),
);

/** The Server Scripts under `server/scripts/`. Tried when the app method is missing. */
const SCRIPT = Object.fromEntries(
  Object.entries(NAMES).map(([key, name]) => [key, `upande_sensors_app.${name}`]),
);

/**
 * App-only methods — these arrived after the Server Script era, so there is no
 * script to fall back to and no legacy call either. A site without them simply
 * does not have the feature, and the callers say so rather than error.
 */
const APP_ONLY = {
  registerPushToken: 'upande_sensors.api.mobile.register_push_token',
  unregisterPushToken: 'upande_sensors.api.mobile.unregister_push_token',
  alerts: 'upande_sensors.api.mobile.alerts',
  alertsCount: 'upande_sensors.api.mobile.alerts_count',
  registerInstall: 'upande_sensors.api.mobile.register_install',
  installs: 'upande_sensors.api.mobile.installs',
  locationCoverage: 'upande_sensors.api.mobile.location_coverage',
};

const LEGACY = {
  dashboardConfig: 'upande_sensors.api.get_dashboard_config',
  userSites: 'upande_sensors.api.get_user_sites',
  sensorTypeOptions: 'upande_sensors.api.get_sensor_type_options',
  sensorNames: 'upande_sensors.api.get_sensor_names',
  chartSensorNames: 'upande_sensors.api.sensor_charts.get_sensor_names',
  chartSeries: 'upande_sensors.api.sensor_charts.get_chart_series',
  sensorDashboard: 'upande_sensors.api.sensor_dashboard.sensor_dashboard',
  siteSensors: 'upande_sensors.api.flow_plan.get_site_sensors',
  liveReadings: 'upande_sensors.api.flow_plan.get_live_readings',
};

/**
 * Run each attempt in turn, moving to the next ONLY when the endpoint simply
 * isn't on this instance.
 *
 * Scoped deliberately narrowly. `isMissingEndpoint` matches Frappe's "Failed to
 * get method for command" — the one error that means "this site does not have
 * that method". Anything else, a permission refusal above all, is the server
 * answering the question and is passed straight through: silently retrying a
 * 403 against an older endpoint would turn a clear "you don't have access" into
 * whatever the legacy path happened to return.
 *
 * When every attempt is missing, the LAST missing-endpoint error is rethrown
 * rather than a new one: callers such as `trend.js` and the pump control read
 * `isMissingEndpoint` off it to decide between "older server" and "broken".
 * Holes in the list (`null` where a loader has no legacy path) are skipped.
 */
export async function viaChain(attempts) {
  let missing = null;
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof FrappeError && err.isMissingEndpoint) {
        missing = err;
        continue;
      }
      throw err;
    }
  }
  throw missing || new FrappeError('No endpoint could answer this request.', { status: 0 });
}

/**
 * The first two links of every chain: the app method, then the Server Script,
 * called with identical params — the contract is that the two agree on both
 * params and response shape, which is what makes the fallback invisible.
 */
function appThenScript(key, params, opts) {
  return [
    () => client.call(APP[key], params, opts),
    () => client.call(SCRIPT[key], params, opts),
  ];
}

/* ── Identity ────────────────────────────────────────────────────────────── */

/**
 * Everything about the signed-in account, in one request.
 *
 * Cached at reference TTL and de-duplicated in flight, so the four callers below
 * — Account screen roles, Account screen versions, the timezone resolver and the
 * avatar — share a single call instead of making four.
 */
export function getSession(signal, { force = false } = {}) {
  return cached(
    'app_whoami',
    () =>
      viaChain([
        ...appThenScript('whoami', {}, { signal }),
        // Rebuilt from the old calls, each guarded on its own: on a stock site
        // the timezone and the versions are refused for most accounts, and
        // neither is worth costing anyone their session.
        async () => {
          const user = await client.call('frappe.auth.get_logged_user', {}, { signal });
          const [roleRows, profile, zone, versions] = await Promise.all([
            client
              .call(
                'frappe.client.get_list',
                {
                  doctype: 'Has Role',
                  parent: 'User',
                  filters: { parent: user, parenttype: 'User' },
                  fields: ['role'],
                  limit_page_length: 0,
                },
                { signal },
              )
              .catch(() => []),
            client
              .call(
                'frappe.client.get_value',
                { doctype: 'User', filters: { name: user }, fieldname: ['full_name', 'user_image'] },
                { signal },
              )
              .catch(() => null),
            client
              .call(
                'frappe.client.get_value',
                { doctype: 'System Settings', fieldname: 'time_zone' },
                { signal },
              )
              .catch(() => null),
            client.call('frappe.utils.change_log.get_versions', {}, { signal }).catch(() => null),
          ]);
          const roles = (Array.isArray(roleRows) ? roleRows : []).map((r) => r.role).filter(Boolean);
          return {
            user,
            full_name: profile?.full_name || user,
            user_image: profile?.user_image || null,
            roles,
            is_admin: user === 'Administrator',
            is_system_manager: user === 'Administrator' || roles.includes('System Manager'),
            time_zone: zone?.time_zone || null,
            server_time: null,
            versions: versions || {},
            scoped_sites: [],
          };
        },
      ]),
    { ttl: TTL_REFERENCE, force },
  );
}

/**
 * Roles held by the signed-in account.
 *
 * Resolves to an empty list on any failure, including a permission error: this
 * gates a privileged control, and the safe answer when a role cannot be
 * established is "you don't have it".
 *
 * `user` is accepted for call-site compatibility and ignored — the session
 * endpoint only ever reports on the account making the request, which is the
 * only account every caller ever asked about.
 */
export async function getUserRoles(user, signal) {
  if (!user) return [];
  try {
    return (await getSession(signal))?.roles || [];
  } catch {
    return [];
  }
}

/** Versions of every app installed on the connected site. */
export async function getServerVersions(signal) {
  try {
    return (await getSession(signal))?.versions || null;
  } catch {
    return null;
  }
}

/**
 * The site's configured timezone, e.g. "Africa/Nairobi".
 *
 * Now answered for every account rather than System Managers only. Still
 * resolves to null on failure — the caller falls back to the device zone rather
 * than treating a refusal as an error.
 */
export async function getServerTimezone(signal) {
  try {
    return (await getSession(signal))?.time_zone || null;
  } catch {
    return null;
  }
}

/**
 * The signed-in account's display name and avatar. Null on failure — an avatar
 * is decoration, and its absence must never interfere with signing in.
 */
export async function getUserProfile(user, signal) {
  if (!user) return null;
  try {
    const info = await getSession(signal);
    if (!info) return null;
    return { fullName: info.full_name || null, image: info.user_image || null };
  } catch {
    return null;
  }
}

/* ── Dashboard / filters ─────────────────────────────────────────────────── */

/**
 * Title, tabs, sites and units — one request behind three callers.
 *
 * The three old endpoints all read the same cached Sensor Settings document, so
 * asking separately paid for the same document three times.
 *
 * The app method additionally returns `app: { welcome_message, support_contact,
 * stale_after_minutes }` from Sensor Settings. The script and legacy paths
 * predate those fields and return nothing for them; `DashboardContext` treats a
 * missing block as "use the defaults", so nothing here has to fill it in.
 */
export function getAppConfig(signal, { force = false } = {}) {
  return cached(
    'app_config',
    () =>
      viaChain([
        ...appThenScript('config', {}, { signal }),
        async () => {
          const [config, sites, types] = await Promise.all([
            client.call(LEGACY.dashboardConfig, {}, { signal }),
            client.call(LEGACY.userSites, {}, { signal }).catch(() => null),
            client.call(LEGACY.sensorTypeOptions, {}, { signal }).catch(() => []),
          ]);
          return {
            ...(config || {}),
            sites: sites || config?.sites || [],
            sensor_types: types || [],
            units: {},
          };
        },
      ]),
    { ttl: TTL_REFERENCE, force },
  );
}

export function getDashboardConfig(signal) {
  return getAppConfig(signal);
}

export async function getUserSites(signal) {
  return (await getAppConfig(signal))?.sites || [];
}

export async function getSensorTypeOptions(signal) {
  return (await getAppConfig(signal))?.sensor_types || [];
}

/* ── Sensor names ────────────────────────────────────────────────────────── */

/**
 * Sensor names for a site.
 *
 * With no `sensorType` this is the registry unioned with everything actively
 * reporting, so a freshly-commissioned site lists its sensors before the first
 * reading arrives. With one, it is the sensors that actually report that
 * measure — asking the registry there would offer a three-measure node under
 * only one of them.
 */
export function getSensorNames(site, signal) {
  return viaChain([
    ...appThenScript('sensorNames', { site }, { signal }),
    () => client.call(LEGACY.sensorNames, { site }, { signal }),
  ]);
}

/** Sensor names that have readings for this site + type (+ tab tag). */
export function getChartSensorNames({ site, sensorType, tabTag }, signal) {
  return viaChain([
    ...appThenScript('sensorNames', { site, sensor_type: sensorType, tab_tag: tabTag }, { signal }),
    () =>
      client.call(
        LEGACY.chartSensorNames,
        { site_name: site, sensor_type: sensorType, tab_tag: tabTag },
        { signal },
      ),
  ]);
}

/* ── Charts ──────────────────────────────────────────────────────────────── */

/**
 * Every requested measure's series for a window, in one request.
 *
 * Returns `{ interval, bucket_mins, series: [{ type, key, unit, cumulative,
 * points, min, max }] }`, where each point is `[bucket, value, readingCount]`
 * and `bucket` is a full ISO timestamp.
 *
 * Sparse on purpose: a bucket with no reading is absent rather than zero, and
 * every point carries its own instant, so the caller places values on the axis
 * by timestamp instead of zipping two arrays together by index and hoping the
 * grids matched.
 *
 * Pass `bucketMins` for sub-daily buckets (the Dashboard's 30-minute view) or
 * `interval` for calendar buckets. Weekly is served as daily — there is no
 * ISO-shaped week key to put on a time axis — and the response says so in
 * `interval`.
 *
 * No legacy link here on purpose. The old endpoints answer in a different shape
 * (display labels, one measure per call), so the translation lives in
 * `trend.js`, which catches the missing-endpoint error this rethrows when both
 * the app method and the script are absent and rebuilds the chart from
 * `getLegacyChartSeries` / `getLegacySensorDashboard` below.
 */
export function getChartSeries(
  { site, sensorName, tabTag, sensorTypes, dateFrom, dateTo, interval = 'daily', bucketMins },
  signal,
) {
  const types = Array.isArray(sensorTypes) ? sensorTypes : [sensorTypes].filter(Boolean);
  // An empty list is NOT short-circuited: it means "chart whatever this window
  // contains", which only the server can work out. Returning early here made
  // the single-day view — the one path that relies on that discovery — come back
  // empty every time without ever issuing a request.
  return viaChain(
    appThenScript(
      'chartSeries',
      {
        site,
        sensor_name: sensorName,
        tab_tag: tabTag,
        sensor_types: JSON.stringify(types),
        date_from: dateFrom,
        date_to: dateTo,
        interval,
        bucket_mins: bucketMins || undefined,
      },
      { signal },
    ),
  );
}

/** One measure, the old per-type endpoint's shape. Used only as a fallback. */
export function getLegacyChartSeries(
  { sensorType, site, sensorName, dateFrom, dateTo, interval = 'daily', tabTag },
  signal,
) {
  return client.call(
    LEGACY.chartSeries,
    {
      sensor_type: sensorType,
      site,
      sensor_name: sensorName,
      date_from: dateFrom,
      date_to: dateTo,
      time_interval: interval,
      tab_tag: tabTag,
    },
    { signal },
  );
}

/** The old all-measures bucketed endpoint. Used only as a fallback. */
export function getLegacySensorDashboard(
  { dateFrom, dateTo, site, sensorName, bucketMins = 30 },
  signal,
) {
  return client.call(
    LEGACY.sensorDashboard,
    {
      from_date: dateFrom,
      to_date: dateTo,
      site,
      sensor_name: sensorName,
      bucket_mins: bucketMins,
    },
    { signal },
  );
}

/* ── Live values ─────────────────────────────────────────────────────────── */

/**
 * A site's sensors and their latest value per measure, in one request.
 *
 * The two old endpoints had to be called in sequence — the second needs the
 * names from the first — so the Live screen waited on two round trips before it
 * could paint anything.
 *
 * `values[name].params` lists one entry per measure: a single physical node
 * (a Honeywell "Zone2 Main") reports temperature, humidity and more as separate
 * readings sharing a sensor name. The top-level `value`/`uom`/`ts` mirror the
 * first measure, which is what the cards read for a single-parameter sensor.
 */
export function getLive(site, signal) {
  return viaChain([
    ...appThenScript('live', { site }, { signal }),
    async () => {
      const sensors = (await client.call(LEGACY.siteSensors, { site }, { signal })) || [];
      const names = sensors.map((s) => s.sensor_name).filter(Boolean);
      const values = names.length
        ? await client.call(
            LEGACY.liveReadings,
            { site, sensor_names_json: JSON.stringify(names) },
            { signal },
          )
        : {};
      return { site, sensors, values: values || {} };
    },
  ]);
}

/** The sensors half, from the shared cached `getLive` call. */
export async function getSiteSensors(site, signal) {
  return (await cachedLive(site, signal))?.sensors || [];
}

/** The values half, from the same cached call. `sensorNames` is not needed. */
export async function getLiveReadings(site, sensorNames, signal) {
  return (await cachedLive(site, signal))?.values || {};
}

function cachedLive(site, signal) {
  return cached(cacheKey('app_live', { site }), () => getLive(site, signal), { ttl: TTL_LIVE });
}

/* ── Raw readings (paginated history) ────────────────────────────────────── */

/**
 * A page of raw readings plus the total, in one request.
 *
 * `Sensor Reading` grants read to System Manager and Water Operator only, so
 * reading this through the generic client API failed for every other account —
 * on a screen sitting next to dashboards that worked, because those go through
 * methods that do their own site scoping. This endpoint applies that same
 * Sensor Site scoping, so the history is available to exactly the accounts that
 * can already see the site's live values.
 */
export function getReadingsPage(
  {
    site,
    dateFrom,
    dateTo,
    sensorType,
    sensorName,
    tabTag,
    start = 0,
    pageLength = 50,
    order,
    withTotal = 1,
  },
  signal,
) {
  return viaChain([
    ...appThenScript(
      'readings',
      {
        site,
        date_from: dateFrom,
        date_to: dateTo,
        sensor_type: sensorType,
        sensor_name: sensorName,
        // Scopes the table to the dashboard the reader is standing on, the same
        // way the charts are scoped. A server that predates the parameter
        // ignores it and answers site-wide, which is exactly what it did
        // before — so sending it can only ever improve the answer.
        tab_tag: tabTag,
        start,
        page_length: pageLength,
        order,
        with_total: withTotal,
      },
      { signal },
    ),
    async () => {
      const [rows, total] = await Promise.all([
        client.call(
          'frappe.client.get_list',
          {
            doctype: 'Sensor Reading',
            filters: legacyReadingFilters({ site, dateFrom, dateTo, sensorType, sensorName }),
            fields: ['name', 'timestamp', 'sensor_name', 'sensor_type', 'value'],
            order_by: `timestamp ${order === 'asc' ? 'asc' : 'desc'}`,
            limit_start: start,
            limit_page_length: pageLength,
          },
          { signal },
        ),
        withTotal
          ? client.call(
              'frappe.client.get_count',
              {
                doctype: 'Sensor Reading',
                filters: legacyReadingFilters({ site, dateFrom, dateTo, sensorType, sensorName }),
              },
              { signal },
            )
          : Promise.resolve(null),
      ]);
      return { rows: rows || [], total, start, page_length: pageLength };
    },
  ]);
}

/**
 * Filters for the legacy list call. List form rather than a dict because the
 * timestamp bounds need comparison operators, which the dict form can't express.
 */
// No tab tag here: this path is a plain `frappe.client.get_list` over Sensor
// Reading, and the monitoring gate lives on the Sensor master, not on the
// reading row — there is no join to express it with. The fallback is therefore
// site-wide, as it has always been.
function legacyReadingFilters({ site, dateFrom, dateTo, sensorType, sensorName }) {
  const filters = [];
  if (site) filters.push(['site_name', '=', site]);
  if (dateFrom) filters.push(['timestamp', '>=', `${dateFrom} 00:00:00`]);
  if (dateTo) filters.push(['timestamp', '<=', `${dateTo} 23:59:59`]);
  if (sensorType) filters.push(['sensor_type', '=', String(sensorType).toLowerCase()]);
  if (sensorName) filters.push(['sensor_name', '=', sensorName]);
  return filters;
}

/** Rows only, for the export walker which pages until it runs dry. */
export async function getSensorReadings(params, signal) {
  return (await getReadingsPage({ ...params, withTotal: 0 }, signal))?.rows || [];
}

/* ── Activity (admin) ────────────────────────────────────────────────────── */

/**
 * Screen visits, their total, and the sign-in/out trail — one request.
 *
 * System Manager only, which is the gate Route History and Activity Log already
 * carried; it is now enforced once, with a sentence saying so, rather than
 * arriving as an ambiguous 403 the client had to probe the session to read.
 *
 * `auth` is returned as rows rather than a server-side GROUP BY because the
 * screen draws per-day in/out counts, and `auth_truncated` says when the cap was
 * hit instead of quietly under-counting a busy window.
 */
export function getActivity(
  { dateFrom, dateTo, user, start = 0, pageLength = 50, include = 'routes,auth', authLimit = 1000 } = {},
  signal,
) {
  return viaChain(
    appThenScript(
      'activity',
      {
        date_from: dateFrom,
        date_to: dateTo,
        user,
        start,
        page_length: pageLength,
        include,
        auth_limit: authLimit,
      },
      { signal },
    ),
  ).then((res) => {
    rememberNames(res?.full_names);
    return res;
  });
}

/**
 * Recent screen visits across every account, newest first.
 *
 * Throws for anyone below System Manager — the caller gates the section on the
 * role rather than showing an empty list that would imply nobody has used the
 * app.
 */
export async function getRouteHistory(
  { dateFrom, dateTo, user, start = 0, pageLength = 50 } = {},
  signal,
) {
  const res = await getActivity(
    { dateFrom, dateTo, user, start, pageLength, include: 'routes' },
    signal,
  );
  return res?.routes?.rows || [];
}

/** Total Route History rows in a window, for the pagination counter. */
export async function getRouteHistoryCount({ dateFrom, dateTo, user } = {}, signal) {
  const res = await getActivity(
    { dateFrom, dateTo, user, pageLength: 1, include: 'routes' },
    signal,
  );
  return res?.routes?.total ?? 0;
}

/**
 * Sign-in and sign-out events in a window, newest first.
 *
 * Frappe writes these itself on every `/api/method/login` (hooks.py) and on
 * session teardown (sessions.py), so the app's own sign-ins are already there
 * without the client logging anything.
 */
export async function getAuthActivity({ dateFrom, dateTo, pageLength = 1000 } = {}, signal) {
  const res = await getActivity(
    { dateFrom, dateTo, authLimit: pageLength, include: 'auth' },
    signal,
  );
  return res?.auth || [];
}

/* ── Route history (writing) ─────────────────────────────────────────────── */

/**
 * Record a batch of screen visits. POST — a Server Script that writes over GET
 * reports success and changes nothing, because Frappe rolls the GET back.
 *
 * `create` on Route History ships granted to no role at all, so the old direct
 * insert was refused on a stock site; and the queued alternative only reaches
 * Redis, where nothing is recorded while the site's scheduler is stopped and the
 * app has no way to tell. Here the row exists when the request returns.
 *
 * Each visit keeps its own timestamp. `Document.insert()` stamps `creation` with
 * now() regardless of what was passed, so the server writes the real visit time
 * back afterwards.
 *
 * `source: 'app'` names where the rows came from. Route History is shared with
 * the desk, whose own recorder writes for every account; the app's rule is that
 * the Administrator is never tracked (see `RootNavigator`), and the server
 * enforces the same rule for rows tagged "app" — so a client that forgot to
 * check, or an old build, cannot write what this one refuses to. Both sides
 * agreeing is what makes the rule a rule rather than a preference.
 */
export function logRoutes(rows, signal) {
  return viaChain(
    appThenScript(
      'logRoutes',
      { routes: JSON.stringify(rows || []), source: 'app' },
      { write: true, signal },
    ),
  );
}

/** The queued route: Redis now, rows whenever the site's scheduler next runs. */
export function queueRouteHistory(rows, signal) {
  return client.call(
    'frappe.desk.doctype.route_history.route_history.deferred_insert',
    { routes: JSON.stringify(rows) },
    { write: true, signal },
  );
}

/* ── Issues and feature requests ─────────────────────────────────────────── */

/**
 * Reports are stored as **Issue**, so they land in the queue the desk already
 * works from rather than in a parallel list.
 *
 * `Issue` ships with create granted to Support Team only, so every account
 * outside that role could not report a problem with the app at all — the one
 * thing you most want someone to be able to do when something is broken. The
 * server script writes with ignore_permissions and records the reporter itself.
 */

/** The two kinds of report, distinguished by a prefix on the subject. */
export const ISSUE_KINDS = [
  { value: 'issue', label: 'Problem', prefix: 'app-' },
  { value: 'feature', label: 'Feature request', prefix: 'app-feature-' },
];

/**
 * File a report, assign it and attach a screenshot — one request.
 *
 * Assignment cannot be folded into a plain document save: `_assign` passed to an
 * insert is discarded, because the field is maintained by the assignment API
 * rather than by the save, so a report created that way arrives with an empty
 * Assign panel and no ToDo in anyone's queue. The server script inserts the
 * ToDo, which is what actually queues and notifies.
 *
 * The screenshot is sent as base64 and decoded by Frappe's File controller —
 * the script sandbox has no base64 module of its own.
 */
export function submitReport({ subject, description, kind = 'issue', assignee, screenshot }, signal) {
  return viaChain(
    appThenScript(
      'reportSubmit',
      {
        subject: String(subject || '').trim(),
        description: String(description || '').trim(),
        kind,
        assign_to: assignee || undefined,
        screenshot_base64: screenshot || undefined,
        screenshot_name: screenshot ? 'screenshot.jpg' : undefined,
      },
      { write: true, signal },
    ),
  );
}

/**
 * Reports raised from the app, newest first.
 *
 * `_assign` is set on each row from the resolved assignee list so `firstAssignee`
 * keeps working — the server reports it as a plain array, but the desk's own
 * shape is a JSON string and the screens were written against that.
 */
export async function getIssues({ kind, pageLength = 50, start = 0, mine = 0 } = {}, signal) {
  const res = await viaChain(
    appThenScript('reportsList', { kind, page_length: pageLength, start, mine }, { signal }),
  );
  rememberNames(res?.full_names);
  return (res?.rows || []).map((row) => ({
    ...row,
    _assign: JSON.stringify(row.assignees || []),
  }));
}

/** First assignee on a row, for display. `_assign` is a JSON array string. */
export function firstAssignee(row) {
  if (row?.assigned_to) return row.assigned_to;
  try {
    const list = JSON.parse(row?._assign || '[]');
    return Array.isArray(list) && list.length ? list[0] : null;
  } catch {
    return null;
  }
}

/**
 * Accounts a report can be assigned to.
 *
 * Only staff accounts, so the picker can never put a report in a customer's
 * queue. A plain query rather than the desk's link search, which goes through
 * `User`'s standard query override — that rewrites filters, and an unexpected
 * one yields an empty list rather than an error, which reads as "there are no
 * users".
 */
export async function searchUsers(txt = '', signal) {
  const query = String(txt || '').trim();
  try {
    const rows = await viaChain([
      ...appThenScript('assignableUsers', { txt: query, page_length: 100 }, { signal }),
      async () => {
        const found = await client.call(
          'frappe.desk.search.search_link',
          {
            doctype: 'User',
            txt: query,
            filters: JSON.stringify({ enabled: 1, user_type: 'System User' }),
            page_length: 100,
          },
          { signal },
        );
        return (Array.isArray(found) ? found : [])
          .map((r) => ({ value: r.value, label: r.value }))
          .filter((r) => String(r.value || '').toLowerCase().endsWith('@upande.com'));
      },
    ]);
    return Array.isArray(rows) ? rows : [];
  } catch {
    // Whatever went wrong, the picker shows nobody rather than an error: this
    // is an optional step on a form whose point is filing the report.
    return [];
  }
}

/* ── Push notifications and limit alerts ─────────────────────────────────── */

/**
 * Tell the server where to send this device's limit-breach pushes.
 *
 * App method only, POST. `provider` names the service the token belongs to:
 * `'expo'` for a token minted by Expo's push service (a build with an EAS
 * project id), `'fcm'` for the raw Firebase registration token a build carrying
 * `google-services.json` gets from the device — see `push.js` for how the app
 * decides. The server keeps one row per token and sends through whichever
 * service the row names, so a fleet can carry both kinds at once while builds
 * roll over. A site without the endpoint rejects with `isMissingEndpoint`,
 * which `push.js` reads as "this server has no alerts".
 */
export function registerPushToken({ token, platform, device, appVersion, provider }, signal) {
  return client.call(
    APP_ONLY.registerPushToken,
    {
      token,
      platform,
      device: device || undefined,
      app_version: appVersion || undefined,
      provider: provider || undefined,
    },
    { write: true, signal },
  );
}

/** Stop pushes to this device — called before a sign-out drops the session. */
export function unregisterPushToken(token, signal) {
  return client.call(APP_ONLY.unregisterPushToken, { token }, { write: true, signal });
}

/**
 * Limit breaches, newest first.
 *
 * `{ rows: [{ name, site, sensor_name, monitoring, measure, value, unit,
 * limit_min, limit_max, direction, reading_timestamp, creation, title, body }],
 * total }`. `title` and `body` are the exact text of the push the server sent
 * for the row, so the list on the phone reads as the notifications did.
 *
 * With no `site` the server answers across every site the account may see —
 * that is the Notifications screen's call, which is about the person, not the
 * selected site. `since` (server-naive `YYYY-MM-DD HH:MM:SS`) narrows to rows
 * created after that instant. Rethrows a missing endpoint untouched so the
 * callers can hide the feature on a server that predates alerts, rather than
 * show an empty list as an all-clear.
 */
export function getAlerts(
  { site = null, sinceDays = 30, start = 0, pageLength = 30, since = null } = {},
  signal,
) {
  return client.call(
    APP_ONLY.alerts,
    {
      site: site || undefined,
      since_days: sinceDays,
      start,
      page_length: pageLength,
      since: since || undefined,
    },
    { signal },
  );
}

/**
 * How many breaches the account may see that were created after `since` —
 * the number on the header bell's badge. Same scope as `getAlerts` with no
 * site. Resolves `{ count }`.
 */
export function getAlertsCount({ since = null } = {}, signal) {
  return client.call(APP_ONLY.alertsCount, { since: since || undefined }, { signal });
}

/* ── Device register ─────────────────────────────────────────────────────── */

/**
 * Record that this device has the app installed, and that it was opened.
 *
 * App method only for now, POST — a write over GET is rolled back by Frappe and
 * would report success having recorded nothing. There is no Server Script link
 * in the chain yet because `server/scripts/` is owned elsewhere and has not
 * been given one; both calls below still go through `viaChain` so adding that
 * second attempt later is one line rather than a rewrite, and so a site without
 * the method raises the same `isMissingEndpoint` every other loader does.
 *
 * The IP in the register is observed by the server from the request. The app
 * does not send one and must not start: see `api/install.js` for what the
 * payload is allowed to contain.
 */
export function registerInstall(
  {
    installId,
    reason,
    platform,
    device_brand: brand,
    device_model: model,
    device_name: name,
    os_version: osVersion,
    app_version: appVersion,
    runtime_version: runtimeVersion,
    is_physical_device: isPhysical,
  },
  signal,
) {
  return viaChain([
    () =>
      client.call(
        APP_ONLY.registerInstall,
        {
          install_id: installId,
          // 'login' or 'launch'. The server keeps one record per (device,
          // account) pair, so a sign-in is the event that creates the pairing
          // for whoever just signed in on a shared phone.
          reason: reason || undefined,
          platform,
          device_brand: brand || undefined,
          device_model: model || undefined,
          device_name: name || undefined,
          os_version: osVersion || undefined,
          app_version: appVersion || undefined,
          runtime_version: runtimeVersion || undefined,
          is_physical_device: isPhysical ? 1 : 0,
        },
        { write: true, signal },
      ),
  ]);
}

/**
 * The register itself, for the App activity screen. System Manager only.
 *
 * `{ rows: [{ install_id, user, full_name, platform, device_brand,
 * device_model, os_version, app_version, previous_app_version,
 * version_changed_at, upgrades, ip_address, first_seen, last_seen, launches }],
 * total, summary: { total_installs, devices, users, physical_devices,
 * active_7d, active_30d, by_user, by_model, by_app_version, by_platform } }`.
 *
 * A row is a (device, account) pair, not a device: a shared phone reports every
 * person who signs in on it. `summary.by_user` is those pairs as `{ user,
 * full_name, app_version, device_model, platform, last_seen, devices, logins }`
 * ordered by `last_seen` — which build each person is actually running, the
 * question the whole feature exists to answer.
 *
 * `summary.total_installs` is a cumulative counter the server keeps, so it
 * counts every install that has ever registered and does not fall when a device
 * row is deleted; `summary.devices` is how many rows exist now. The screen
 * labels the two apart — they answer different questions and are only equal on
 * a register nothing has ever been removed from.
 *
 * A missing endpoint is rethrown untouched so the caller can say "needs a newer
 * server" instead of showing a register with nothing in it, which would read as
 * "nobody has installed the app".
 */
export function getInstalls({ start = 0, pageLength = 50, sinceDays, search } = {}, signal) {
  return viaChain([
    () =>
      client.call(
        APP_ONLY.installs,
        {
          start,
          page_length: pageLength,
          since_days: sinceDays || undefined,
          search: search || undefined,
        },
        { signal },
      ),
  ]);
}

/* ── Dashboard health and floor plans ────────────────────────────────────── */

/**
 * Sensor tallies per dashboard tab, in one request.
 *
 * `{ stale_minutes, tabs: { [tab.name]: { total, active, stale, last_reading,
 * scope } }, site: { total, active, stale, last_reading } }`, keyed by the
 * Sensor Setting CHILD ROW NAME — the same `name` `config` gives each tab, and
 * the only key a tile is looked up by.
 *
 * Both of these were app-method-only, and `upande_sensors.api.mobile` is not
 * deployed to the live site — so every call answered `isMissingEndpoint`, the
 * Home tiles hid their counts and the Floor Plan tab said "needs a newer
 * server". They now go through the ordinary chain, with the Server Scripts in
 * `server/scripts/` as the second link, which is a path that exists today.
 * Still missing on a site with neither: the callers say so rather than showing
 * zeros, because a row of zeros claims every dashboard is empty.
 */
export function getDashboardHealth(site, signal) {
  return viaChain(appThenScript('dashboardHealth', { site }, { signal }));
}

/**
 * The site's floor plans, the selected plan with its placements and markers,
 * the live reading per placed sensor, and door states for linked doors.
 *
 * One request for everything the Floor Plan tab draws, so a poll is one round
 * trip. `plan` null means the server picks the first plan; `doorHours` is the
 * window the door totals are summed over. Read-only: the app never calls any of
 * the plan's write endpoints, so `can_edit` in the payload is ignored.
 */
export function getFloorPlans({ site, plan = null, doorHours = 24 } = {}, signal) {
  return viaChain(
    appThenScript('floorPlans', { site, plan: plan || undefined, door_hours: doorHours }, { signal }),
  );
}

/* ── Sensor coordinates and the map ──────────────────────────────────────── */

/**
 * The sensors a phone may set coordinates on, with what each already has.
 *
 * `{ rows: [{ name, sensor_name, sensor_site, sensor_type, monitoring,
 * latitude, longitude, location_accuracy_m, location_samples,
 * location_updated_on, location_updated_by, has_location }], total }`. `name`
 * is the Sensor DOCNAME, which is what `setSensorLocation` wants; `sensor_name`
 * is the label the rest of the app deals in. `has_location` is false for 0,0
 * as well as null — an untouched Float pair, not a sensor at sea.
 *
 * `search` narrows by sensor name on the server, for Sensor detail's lookup of
 * one row. The location_* fields are null on a site whose upande_sensors
 * predates them; the screens show "unknown" for those, not zeros.
 */
export function getSensorsForLocation({ site, search } = {}, signal) {
  return viaChain(
    appThenScript(
      'sensorsForLocation',
      { site: site || undefined, search: search || undefined },
      { signal },
    ),
  );
}

/**
 * Write a sensor's coordinates from the phone. POST — a write over GET is
 * rolled back by Frappe and would report success having changed nothing.
 *
 * Sends the averaged position, the weighted accuracy in metres, how many
 * fixes it came from and the phone model, so the row on the server carries
 * its own error bar and provenance. The server refuses 0,0 and out-of-range
 * values with a sentence, and refuses any account that is not a System
 * Manager with a permission error — `config().app.can_set_location` is what
 * hides the button; this is what makes hiding it enough. Resolves to the
 * updated `getSensorsForLocation` row plus `history_name` and `previous`.
 */
export function setSensorLocation(
  { sensor, latitude, longitude, accuracyM, samples, device },
  signal,
) {
  return viaChain(
    appThenScript(
      'setSensorLocation',
      {
        sensor,
        latitude,
        longitude,
        accuracy_m: Number.isFinite(Number(accuracyM)) ? accuracyM : undefined,
        samples: samples || undefined,
        device: device || undefined,
      },
      { write: true, signal },
    ),
  );
}

/**
 * Every position one sensor has been given, newest first: `{ rows: [{
 * latitude, longitude, accuracy_m, samples, source, device, user,
 * recorded_at, previous_latitude, previous_longitude }], total, supported }`.
 * `supported` is false on a server without the history doctype, and the
 * screen leaves the section out there rather than saying "no history".
 */
export function getSensorLocationHistory({ sensor, start = 0, pageLength = 20 }, signal) {
  return viaChain(
    appThenScript(
      'sensorLocationHistory',
      { sensor, start, page_length: pageLength },
      { signal },
    ),
  );
}

/**
 * Everything the Sensor Map draws, in one request: `{ stale_minutes, sensors:
 * [{ name, sensor_name, sensor_site, sensor_type, monitoring, latitude,
 * longitude, location_accuracy_m, last_reading, online, values: { <type>: {
 * value, unit, ts } } }], center: { latitude, longitude } | null, map: {
 * mapbox_token } }`.
 *
 * Only sensors WITH coordinates. `online` follows the same stale window the
 * Home tiles use, so the dot on the map and the count on Home agree; a sensor
 * with `last_reading` null has never reported in the lookback and is drawn
 * grey, not red. `mapbox_token` is Sensor Settings' key, so the phone shows the
 * website's basemap when the site has one and OpenStreetMap when it has not.
 * With no `site`, every site the account may see. A missing endpoint is
 * rethrown untouched so the screen can say "needs a newer server".
 */
export function getSensorMap({ site, staleMinutes } = {}, signal) {
  return viaChain(
    appThenScript(
      'sensorMap',
      { site: site || undefined, stale_minutes: staleMinutes || undefined },
      { signal },
    ),
  );
}

/**
 * How many of this account's sensors have coordinates: `{ total,
 * with_coordinates, without_coordinates }`. Registry-only (no readings), for
 * the Home screen's Sensor list tile.
 *
 * App method only — there is no Server Script link in the chain, so this
 * rethrows `isMissingEndpoint` untouched and the tile hides the coordinate
 * counts on a server that predates it, the same as `getDashboardHealth` did
 * before it grew a script fallback.
 */
export function getLocationCoverage(site, signal) {
  return client.call(APP_ONLY.locationCoverage, { site: site || undefined }, { signal });
}

/* ── Account names ───────────────────────────────────────────────────────── */

/**
 * Full names for a set of accounts, as `{ [name]: full_name }`.
 *
 * The activity and report lists carry only the account id, which is an email
 * address — readable but not recognisable, especially where the local part is
 * initials. Both of those endpoints already return the names for the rows they
 * returned, so this is usually answered from what has already arrived and costs
 * no request at all.
 *
 * Resolves to an empty map on failure: a name is an improvement on the id, not a
 * replacement for it, so nothing here is allowed to cost anyone the list.
 */
const knownNames = new Map();

function rememberNames(map) {
  if (!map || typeof map !== 'object') return;
  Object.keys(map).forEach((key) => {
    if (key && map[key]) knownNames.set(key, map[key]);
  });
}

export async function getUserFullNames(users = [], signal) {
  const wanted = [...new Set(users.filter(Boolean))];
  if (!wanted.length) return {};

  const out = {};
  const missing = [];
  wanted.forEach((name) => {
    if (knownNames.has(name)) out[name] = knownNames.get(name);
    else missing.push(name);
  });
  if (!missing.length) return out;

  try {
    const rows = await client.call(
      'frappe.client.get_list',
      {
        doctype: 'User',
        fields: ['name', 'full_name'],
        filters: [['name', 'in', missing]],
        limit_page_length: missing.length,
      },
      { signal },
    );
    (Array.isArray(rows) ? rows : []).forEach((r) => {
      if (r?.name && r.full_name) {
        out[r.name] = r.full_name;
        knownNames.set(r.name, r.full_name);
      }
    });
  } catch {
    // Whatever was already known still stands.
  }
  return out;
}
