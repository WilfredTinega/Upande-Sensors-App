/**
 * Typed-ish wrappers over the API this app is served by.
 *
 * Every method name in `M` mirrors a real `api_method` on a Server Script kept
 * under `server/scripts/` in this repo, so a broken call can be traced back to
 * the Python that serves it without guessing — see `server/README.md`.
 *
 * Why the app has its own endpoints rather than calling the `upande_sensors`
 * app's whitelisted methods and Frappe's generic client API directly:
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
 * `LEGACY` holds the call each of these replaced. An instance that has not had
 * the scripts deployed answers "Failed to get method for command …", which the
 * client reports as `isMissingEndpoint` — the loaders below fall back to the old
 * path on exactly that error, so the app keeps working against a site where the
 * scripts are absent or older than the client. A permission error is NOT a
 * fallback trigger: it is the server's real answer.
 */

import { TTL_LIVE, TTL_REFERENCE, cacheKey, cached } from './cache';
import { client, FrappeError } from './client';

export { FrappeError };

const M = {
  whoami: 'upande_sensors_app.whoami',
  config: 'upande_sensors_app.config',
  sensorNames: 'upande_sensors_app.sensor_names',
  live: 'upande_sensors_app.live',
  chartSeries: 'upande_sensors_app.chart_series',
  readings: 'upande_sensors_app.readings',
  activity: 'upande_sensors_app.activity',
  logRoutes: 'upande_sensors_app.log_routes',
  reportsList: 'upande_sensors_app.reports_list',
  reportSubmit: 'upande_sensors_app.report_submit',
  assignableUsers: 'upande_sensors_app.assignable_users',
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
 * Run `primary`; if the endpoint simply isn't on this instance, run `fallback`.
 *
 * Scoped deliberately narrowly. `isMissingEndpoint` matches Frappe's "Failed to
 * get method for command" — the one error that means "this site does not have
 * that method". Anything else, a permission refusal above all, is the server
 * answering the question and is passed straight through: silently retrying a
 * 403 against an older endpoint would turn a clear "you don't have access" into
 * whatever the legacy path happened to return.
 */
async function orLegacy(primary, fallback) {
  try {
    return await primary();
  } catch (err) {
    if (err instanceof FrappeError && err.isMissingEndpoint && fallback) return fallback();
    throw err;
  }
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
      orLegacy(
        () => client.call(M.whoami, {}, { signal }),
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
      ),
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
 */
export function getAppConfig(signal, { force = false } = {}) {
  return cached(
    'app_config',
    () =>
      orLegacy(
        () => client.call(M.config, {}, { signal }),
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
      ),
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
  return orLegacy(
    () => client.call(M.sensorNames, { site }, { signal }),
    () => client.call(LEGACY.sensorNames, { site }, { signal }),
  );
}

/** Sensor names that have readings for this site + type (+ tab tag). */
export function getChartSensorNames({ site, sensorType, tabTag }, signal) {
  return orLegacy(
    () =>
      client.call(M.sensorNames, { site, sensor_type: sensorType, tab_tag: tabTag }, { signal }),
    () =>
      client.call(
        LEGACY.chartSensorNames,
        { site_name: site, sensor_type: sensorType, tab_tag: tabTag },
        { signal },
      ),
  );
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
  return client.call(
    M.chartSeries,
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
  return orLegacy(
    () => client.call(M.live, { site }, { signal }),
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
  );
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
  { site, dateFrom, dateTo, sensorType, sensorName, start = 0, pageLength = 50, order, withTotal = 1 },
  signal,
) {
  return orLegacy(
    () =>
      client.call(
        M.readings,
        {
          site,
          date_from: dateFrom,
          date_to: dateTo,
          sensor_type: sensorType,
          sensor_name: sensorName,
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
  );
}

/**
 * Filters for the legacy list call. List form rather than a dict because the
 * timestamp bounds need comparison operators, which the dict form can't express.
 */
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
  return client
    .call(
      M.activity,
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
    )
    .then((res) => {
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
 */
export function logRoutes(rows, signal) {
  return client.call(
    M.logRoutes,
    { routes: JSON.stringify(rows || []) },
    { write: true, signal },
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
  return client.call(
    M.reportSubmit,
    {
      subject: String(subject || '').trim(),
      description: String(description || '').trim(),
      kind,
      assign_to: assignee || undefined,
      screenshot_base64: screenshot || undefined,
      screenshot_name: screenshot ? 'screenshot.jpg' : undefined,
    },
    { write: true, signal },
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
  const res = await client.call(
    M.reportsList,
    { kind, page_length: pageLength, start, mine },
    { signal },
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
  try {
    const rows = await client.call(
      M.assignableUsers,
      { txt: String(txt || '').trim(), page_length: 100 },
      { signal },
    );
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    if (!(err instanceof FrappeError) || !err.isMissingEndpoint) return [];
    try {
      const rows = await client.call(
        'frappe.desk.search.search_link',
        {
          doctype: 'User',
          txt: String(txt || '').trim(),
          filters: JSON.stringify({ enabled: 1, user_type: 'System User' }),
          page_length: 100,
        },
        { signal },
      );
      return (Array.isArray(rows) ? rows : [])
        .map((r) => ({ value: r.value, label: r.value }))
        .filter((r) => String(r.value || '').toLowerCase().endsWith('@upande.com'));
    } catch {
      return [];
    }
  }
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
