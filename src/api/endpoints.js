/**
 * Typed-ish wrappers over the `upande_sensors` whitelisted API.
 *
 * Every method name here mirrors a real dotted path in
 * apps/upande_sensors/upande_sensors/api/, so a broken call can be traced back
 * to the Python that serves it without guessing.
 */

import { client, FrappeError } from './client';

export { FrappeError };

const M = {
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

/* ── Identity ────────────────────────────────────────────────────────────── */

/**
 * Roles held by `user`, read from the Has Role child table.
 *
 * Frappe's own `frappe.get_roles` is not whitelisted, so this goes through the
 * generic client API. Any failure — including a permission error — resolves to
 * an empty list rather than throwing: this gates a privileged control, and the
 * safe answer when we cannot establish a role is "you don't have it".
 */
export async function getUserRoles(user, signal) {
  if (!user) return [];
  try {
    const rows = await client.call(
      'frappe.client.get_list',
      {
        doctype: 'Has Role',
        parent: 'User',
        filters: { parent: user, parenttype: 'User' },
        fields: ['role'],
        limit_page_length: 0,
      },
      { signal },
    );
    return (Array.isArray(rows) ? rows : []).map((r) => r.role).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Versions of every app installed on the connected site — frappe, erpnext,
 * upande_sensors and the rest. Whitelisted for any signed-in user.
 */
export async function getServerVersions(signal) {
  try {
    return await client.call('frappe.utils.change_log.get_versions', {}, { signal });
  } catch {
    return null;
  }
}

/**
 * The site's configured timezone, e.g. "Africa/Nairobi".
 *
 * System Settings is readable by System Managers only, so this returns null for
 * most accounts — the caller falls back to the device zone rather than treating
 * a refusal as an error.
 */
export async function getServerTimezone(signal) {
  try {
    const row = await client.call(
      'frappe.client.get_value',
      { doctype: 'System Settings', fieldname: 'time_zone' },
      { signal },
    );
    return row?.time_zone || null;
  } catch {
    return null;
  }
}

/**
 * Recent screen visits across every user.
 *
 * `Route History` grants read to System Manager only, so this throws for anyone
 * else — the caller gates the section on the role rather than showing an empty
 * list that would imply nobody has used the app.
 */
export function getRouteHistory(
  { dateFrom, dateTo, user, start = 0, pageLength = 50 } = {},
  signal,
) {
  const filters = [];
  if (dateFrom) filters.push(['creation', '>=', `${dateFrom} 00:00:00`]);
  if (dateTo) filters.push(['creation', '<=', `${dateTo} 23:59:59`]);
  // Without this, one heavy browser fills every page and the other users'
  // visits are simply further down than anyone scrolls.
  if (user) filters.push(['user', '=', user]);

  return client.call(
    'frappe.client.get_list',
    {
      doctype: 'Route History',
      filters,
      fields: ['name', 'user', 'route', 'creation'],
      order_by: 'creation desc',
      limit_start: start,
      limit_page_length: pageLength,
    },
    { signal },
  );
}

/** Total Route History rows in a window, for the pagination counter. */
export function getRouteHistoryCount({ dateFrom, dateTo, user } = {}, signal) {
  const filters = [];
  if (dateFrom) filters.push(['creation', '>=', `${dateFrom} 00:00:00`]);
  if (dateTo) filters.push(['creation', '<=', `${dateTo} 23:59:59`]);
  if (user) filters.push(['user', '=', user]);
  return client.call('frappe.client.get_count', { doctype: 'Route History', filters }, { signal });
}

/**
 * Sign-in and sign-out events in a window, newest first.
 *
 * Frappe writes these to `Activity Log` itself on every `/api/method/login`, so
 * the app's own sign-ins already appear there without the client logging
 * anything. Read is System Manager only, same as Route History.
 *
 * Rows are returned rather than a server-side GROUP BY: the generic client API
 * rejects aggregate field expressions, so the per-day counts are computed in
 * the app — hence `pageLength`, and the caller reporting when it is hit.
 */
export function getAuthActivity({ dateFrom, dateTo, pageLength = 1000 } = {}, signal) {
  const filters = [
    // Both directions: Frappe writes Login on session creation (hooks.py) and
    // Logout when the session is cleared (sessions.py), so the in/out trail is
    // already there — it only ever read the Login half.
    ['operation', 'in', ['Login', 'Logout']],
  ];
  if (dateFrom) filters.push(['creation', '>=', `${dateFrom} 00:00:00`]);
  if (dateTo) filters.push(['creation', '<=', `${dateTo} 23:59:59`]);

  return client.call(
    'frappe.client.get_list',
    {
      doctype: 'Activity Log',
      filters,
      // `status` distinguishes a failed sign-in attempt from a successful one;
      // `subject` carries the logout reason.
      fields: ['name', 'user', 'operation', 'status', 'subject', 'creation'],
      order_by: 'creation desc',
      limit_page_length: pageLength,
    },
    { signal },
  );
}

/**
 * Force Frappe to drain its deferred-insert queue now.
 *
 * `deferred_insert` (used to record route history) pushes to Redis; the rows
 * only reach the doctype when `frappe.deferred_insert.save_to_db` runs, which
 * is scheduled every 15 minutes. `execute_event` enqueues that job immediately.
 *
 * Restricted to System Manager by `frappe.only_for` on the server — the same
 * role that can read Route History at all, so the people who look at this data
 * are exactly the ones who can refresh it. Everyone else gets the 15-minute
 * cadence, and this call simply fails for them.
 *
 * Returns true when the job was enqueued. The worker still runs it
 * asynchronously, so rows appear a moment later, not instantly.
 */
export async function flushDeferredInserts(signal) {
  try {
    const name = await client.call(
      'frappe.client.get_value',
      {
        doctype: 'Scheduled Job Type',
        filters: { method: 'frappe.deferred_insert.save_to_db' },
        fieldname: 'name',
      },
      { signal },
    );
    const jobName = name?.name;
    if (!jobName) return false;

    await client.call(
      'frappe.core.doctype.scheduled_job_type.scheduled_job_type.execute_event',
      { doc: JSON.stringify({ name: jobName }) },
      { write: true, signal },
    );
    return true;
  } catch {
    // Not permitted, or the job row is absent on this site. Either way the
    // scheduled run still covers it — this is an accelerator, not the mechanism.
    return false;
  }
}

/* ── Issues and feature requests ─────────────────────────────────────────── */

/**
 * Reports are stored as **Issue**, so they land in the same queue the desk
 * already works from rather than in a parallel list.
 *
 * This depends on a server-side permission: `Issue` ships with create and read
 * granted to `Support Team` only, and the app cannot widen that. It is granted
 * on this instance; if reports start failing with a permission error on another
 * one, that row in the Role Permissions Manager is the reason.
 */

/** The two kinds of report, distinguished by a prefix on the subject. */
export const ISSUE_KINDS = [
  { value: 'issue', label: 'Problem', prefix: 'app-' },
  { value: 'feature', label: 'Feature request', prefix: 'app-feature-' },
];

/**
 * Subject filters per kind. Both prefixes begin `app-`, so "problem" must
 * exclude the feature form explicitly or it would match every request too.
 */
function subjectFilters(kind) {
  if (kind === 'feature') return [['subject', 'like', 'app-feature-%']];
  if (kind === 'issue') {
    return [
      ['subject', 'like', 'app-%'],
      ['subject', 'not like', 'app-feature-%'],
    ];
  }
  return [['subject', 'like', 'app-%']];
}

/** File a report. Assignment is a separate step — see `assignIssue`. */
export function createIssue({ subject, description, kind = 'issue', user }, signal) {
  const prefix = ISSUE_KINDS.find((k) => k.value === kind)?.prefix || '';

  // `raised_by` is an Email field. Frappe user ids are usually emails but not
  // always — "Administrator" is the obvious one — and a non-address fails
  // validation, which blocked those accounts from reporting at all. The doc's
  // `owner` records who filed it regardless.
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(user || ''));

  return client.call(
    'frappe.client.insert',
    {
      doc: JSON.stringify({
        doctype: 'Issue',
        // No space after the prefix: the subject reads as one token in the desk
        // list, e.g. "app-the dashboard is not showing data".
        subject: `${prefix}${String(subject || '').trim()}`,
        description: String(description || '').trim(),
        ...(isEmail ? { raised_by: user } : {}),
      }),
    },
    { write: true, signal },
  );
}

/** Reports raised from the app, newest first. */
export function getIssues({ kind, pageLength = 50 } = {}, signal) {
  return client.call(
    'frappe.client.get_list',
    {
      doctype: 'Issue',
      fields: [
        'name',
        'subject',
        'status',
        'priority',
        'raised_by',
        'owner',
        '_assign',
        'creation',
      ],
      filters: subjectFilters(kind),
      order_by: 'creation desc',
      limit_page_length: pageLength,
    },
    { signal },
  );
}

/**
 * Assign a report to someone.
 *
 * This has to be its own call. `_assign` passed to `frappe.client.insert` is
 * discarded — the field is maintained by the assignment API rather than by the
 * document save, so a report created that way arrives with an empty Assign
 * panel in the desk. `assign_to.add` writes the field *and* creates the ToDo
 * that puts the report in the assignee's queue and notifies them.
 */
export function assignIssue({ issueName, user, description }, signal) {
  return client.call(
    'frappe.desk.form.assign_to.add',
    {
      doctype: 'Issue',
      name: issueName,
      assign_to: JSON.stringify([user]),
      description: description || '',
    },
    { write: true, signal },
  );
}

/** First assignee on a row, for display. `_assign` is a JSON array string. */
export function firstAssignee(row) {
  try {
    const list = JSON.parse(row?._assign || '[]');
    return Array.isArray(list) && list.length ? list[0] : null;
  } catch {
    return null;
  }
}

/** Attach a screenshot to a report. */
export function attachScreenshot({ issueName, base64, filename = 'screenshot.jpg' }, signal) {
  return client.call(
    'frappe.client.attach_file',
    {
      filename,
      filedata: base64,
      doctype: 'Issue',
      docname: issueName,
      decode_base64: 1,
      is_private: 1,
    },
    { write: true, signal },
  );
}

/** Only staff accounts are assignable. A Frappe User's name is their email. */
const ASSIGNABLE_DOMAIN = '@upande.com';

/**
 * Users matching a search term, for the assignment picker.
 *
 * Two routes, in order:
 *
 *  1. `frappe.client.get_list` on User. Predictable: plain filters, plain
 *     fields, no query rewriting.
 *  2. `frappe.desk.search.search_link`, the desk's link-field endpoint.
 *
 * The link search is the fallback rather than the primary because `User` has a
 * standard query override (`frappe.core.doctype.user.user.user_query`) that
 * rewrites filters, and an unexpected filter there yields an empty list rather
 * than an error — which reads as "there are no users".
 *
 * Both routes are filtered to the staff domain on the results, so whichever
 * answers cannot offer a customer account.
 */
export async function searchUsers(txt = '', signal) {
  const term = String(txt || '').trim();
  const keep = (rows) =>
    rows.filter((r) =>
      String(r.value || '')
        .toLowerCase()
        .endsWith(ASSIGNABLE_DOMAIN),
    );

  try {
    const params = {
      doctype: 'User',
      fields: ['name', 'full_name'],
      filters: [
        ['enabled', '=', 1],
        ['name', 'like', `%${ASSIGNABLE_DOMAIN}`],
      ],
      order_by: 'full_name asc',
      limit_page_length: 100,
    };
    if (term) {
      params.or_filters = [
        ['name', 'like', `%${term}%`],
        ['full_name', 'like', `%${term}%`],
      ];
    }

    const rows = await client.call('frappe.client.get_list', params, { signal });
    const mapped = keep(
      (Array.isArray(rows) ? rows : []).map((r) => ({
        value: r.name,
        label: r.full_name ? `${r.full_name} · ${r.name}` : r.name,
      })),
    );
    if (mapped.length) return mapped;
  } catch {
    // Falls through to the link search below.
  }

  try {
    const rows = await client.call(
      'frappe.desk.search.search_link',
      {
        doctype: 'User',
        txt: term,
        filters: JSON.stringify({ enabled: 1, user_type: 'System User' }),
        page_length: 100,
      },
      { signal },
    );
    return keep((Array.isArray(rows) ? rows : []).map((r) => ({ value: r.value, label: r.value })));
  } catch {
    return [];
  }
}

/**
 * Full names for a set of accounts, as `{ [name]: full_name }`.
 *
 * The activity lists carry only the account id, which is an email address —
 * readable but not recognisable, especially where the local part is initials.
 * One lookup covers a whole page of rows.
 *
 * Resolves to an empty map on failure: a name is an improvement on the id, not
 * a replacement for it, so nothing here is allowed to cost anyone the list.
 */
export async function getUserFullNames(users = [], signal) {
  const wanted = [...new Set(users.filter(Boolean))];
  if (!wanted.length) return {};
  try {
    const rows = await client.call(
      'frappe.client.get_list',
      {
        doctype: 'User',
        fields: ['name', 'full_name'],
        filters: [['name', 'in', wanted]],
        limit_page_length: wanted.length,
      },
      { signal },
    );
    const out = {};
    (Array.isArray(rows) ? rows : []).forEach((r) => {
      if (r?.name && r.full_name) out[r.name] = r.full_name;
    });
    return out;
  } catch {
    return {};
  }
}

/**
 * The signed-in user's display name and avatar.
 *
 * A user may always read their own User record, so this works for every
 * account. Resolves to null on failure — an avatar is decoration, and its
 * absence must never interfere with signing in.
 */
export async function getUserProfile(user, signal) {
  if (!user) return null;
  try {
    const row = await client.call(
      'frappe.client.get_value',
      { doctype: 'User', filters: { name: user }, fieldname: ['full_name', 'user_image'] },
      { signal },
    );
    return row ? { fullName: row.full_name || null, image: row.user_image || null } : null;
  } catch {
    return null;
  }
}

/* ── Dashboard / filters ─────────────────────────────────────────────────── */

export function getDashboardConfig(signal) {
  return client.call(M.dashboardConfig, {}, { signal });
}

export function getUserSites(signal) {
  return client.call(M.userSites, {}, { signal });
}

export function getSensorTypeOptions(signal) {
  return client.call(M.sensorTypeOptions, {}, { signal });
}

export function getSensorNames(site, signal) {
  return client.call(M.sensorNames, { site }, { signal });
}

/* ── Charts ──────────────────────────────────────────────────────────────── */

/** Sensor names that actually have readings for this site + type. */
export function getChartSensorNames({ site, sensorType, tabTag }, signal) {
  return client.call(
    M.chartSensorNames,
    { site_name: site, sensor_type: sensorType, tab_tag: tabTag },
    { signal },
  );
}

/**
 * Time series for one sensor type. Returns
 * `{ labels, values, unit, min_value, max_value }`.
 *
 * `dateFrom`/`dateTo` are plain `YYYY-MM-DD` and the window is inclusive of
 * both ends — the server widens `dateTo` to 23:59:59 itself.
 */
export function getChartSeries(
  { sensorType, site, sensorName, dateFrom, dateTo, interval = 'daily', tabTag },
  signal,
) {
  return client.call(
    M.chartSeries,
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

/* ── Readings ────────────────────────────────────────────────────────────── */

/**
 * Per-sensor rollup for a window: `{ summary, sensors, trend, sites, ... }`.
 * Passing `sensorName` switches the server into single-sensor mode, which
 * returns `summary` + `trend` but no `sensors` list.
 */
export function getSensorDashboard(
  { dateFrom, dateTo, site, sensorName, bucketMins = 30 },
  signal,
) {
  return client.call(
    M.sensorDashboard,
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

/* ── Raw readings (paginated history) ────────────────────────────────────── */

const READING_DOCTYPE = 'Sensor Reading';
const READING_FIELDS = ['name', 'timestamp', 'sensor_name', 'sensor_type', 'value'];

/**
 * Build the filter list shared by the row and count queries.
 *
 * List form rather than a dict because the timestamp bounds need comparison
 * operators, which the dict form can't express.
 */
function readingFilters({ site, dateFrom, dateTo, sensorType, sensorName }) {
  const filters = [];
  if (site) filters.push(['site_name', '=', site]);
  if (dateFrom) filters.push(['timestamp', '>=', `${dateFrom} 00:00:00`]);
  if (dateTo) filters.push(['timestamp', '<=', `${dateTo} 23:59:59`]);
  if (sensorType) filters.push(['sensor_type', '=', String(sensorType).toLowerCase()]);
  if (sensorName) filters.push(['sensor_name', '=', sensorName]);
  return filters;
}

/**
 * A page of raw readings, newest first.
 *
 * Goes through the generic client API because `upande_sensors` exposes no
 * paginated raw-reading endpoint. That carries a real constraint: the
 * `Sensor Reading` doctype grants read to **System Manager and Water Operator
 * only**, so any other account gets a permission error here — which the screen
 * reports plainly rather than showing as an empty table.
 */
export function getSensorReadings(
  { site, dateFrom, dateTo, sensorType, sensorName, start = 0, pageLength = 50 },
  signal,
) {
  return client.call(
    'frappe.client.get_list',
    {
      doctype: READING_DOCTYPE,
      filters: readingFilters({ site, dateFrom, dateTo, sensorType, sensorName }),
      fields: READING_FIELDS,
      order_by: 'timestamp desc',
      limit_start: start,
      limit_page_length: pageLength,
    },
    { signal },
  );
}

/** Total matching rows, for the "x–y of N" counter and the last-page bound. */
export function getSensorReadingCount({ site, dateFrom, dateTo, sensorType, sensorName }, signal) {
  return client.call(
    'frappe.client.get_count',
    {
      doctype: READING_DOCTYPE,
      filters: readingFilters({ site, dateFrom, dateTo, sensorType, sensorName }),
    },
    { signal },
  );
}

/* ── Live values ─────────────────────────────────────────────────────────── */

export function getSiteSensors(site, signal) {
  return client.call(M.siteSensors, { site }, { signal });
}

/**
 * Latest value per sensor. One physical node can report several parameters, so
 * each entry carries a `params` list keyed by sensor type — the top-level
 * `value`/`uom` just mirror the first one.
 */
export function getLiveReadings(site, sensorNames, signal) {
  if (!sensorNames?.length) return Promise.resolve({});
  return client.call(
    M.liveReadings,
    { site, sensor_names_json: JSON.stringify(sensorNames) },
    { signal },
  );
}
