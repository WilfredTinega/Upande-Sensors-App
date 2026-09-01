# Server-side API

The API this app is served by, as **Server Script** documents of type `API`.
Each file in `scripts/` is one endpoint, reachable at
`/api/method/<api_method>`; `manifest.json` maps files to methods.

Target site: `https://sensor.upande.com`.

## Why the app has its own endpoints

The app used to call the `upande_sensors` app's whitelisted methods plus
Frappe's generic client API (`frappe.client.get_list`, `frappe.client.insert`).
Three things were wrong with that.

**Permissions.** The generic API enforces doctype permissions, and the doctypes
this app reads are locked down:

| Doctype | Ships granted to | What broke |
| --- | --- | --- |
| `Sensor Reading` | read: System Manager, Water Operator | the whole history screen, for everyone else |
| `Route History` | read: System Manager · create: *no role* | recording visits, and the activity screen |
| `Activity Log` | read: System Manager | the sign-in trail |
| `Issue` | create + read: Support Team | filing a report at all |
| `System Settings` | read: System Manager | resolving the site's timezone |

So screens failed for exactly the accounts that could see everything else,
because the dashboards go through whitelisted methods that do their own
site scoping. These scripts apply that same scoping — Sensor Site User
Permissions — so a screen is available to precisely the accounts that can
already see the site's live values.

`frappe.utils.change_log.get_versions` is worse than restricted: it is not
whitelisted at all, so no account could ask the server what it was running.

**Round trips.** One call against the cloud instance costs about a second
before any query runs, so what makes the app slow is the *number* of requests:

| Screen | Before | After |
| --- | --- | --- |
| sign-in identity | 5 calls | 1 (`whoami`) |
| dashboard config | 3 calls | 1 (`config`) |
| Live screen | 2 sequential | 1 (`live`) |
| a chart | 4 parallel | 1 (`chart_series`) |
| a page of history | 2 calls | 1 (`readings`) |
| filing a report | 3 sequential | 1 (`report_submit`) |

`live` also replaced the old query plan: `get_live_readings` ran one DISTINCT
query per sensor plus one `ORDER BY … LIMIT 1` per (sensor, measure) — about
40 queries for a 12-sensor site — where this is one grouped scan.

**A silent wrong answer.** `sensor_dashboard` served any window of two days or
more from `__sensor_reading_hourly`, a rollup maintained by an hourly scheduled
job. Where that job has never run the table is empty, so the query succeeded,
returned nothing, and the chart said "no readings in this range" over readings
that were sitting right there. That is what the 7, 30 and 60 day ranges did.
`chart_series` reads raw readings at every width, so there is no silent-empty
case.

## Endpoints

| `api_method` | HTTP | Replaces |
| --- | --- | --- |
| `upande_sensors_app.whoami` | GET | `get_logged_user`, `Has Role`, `User`, `System Settings.time_zone`, `change_log.get_versions` |
| `upande_sensors_app.config` | GET | `get_dashboard_config`, `get_user_sites`, `get_sensor_type_options` |
| `upande_sensors_app.sensor_names` | GET | `get_sensor_names`, `sensor_charts.get_sensor_names` |
| `upande_sensors_app.live` | GET | `flow_plan.get_site_sensors`, `flow_plan.get_live_readings` |
| `upande_sensors_app.chart_series` | GET | `sensor_charts.get_chart_series`, `sensor_dashboard.sensor_dashboard` |
| `upande_sensors_app.readings` | GET | `get_list` + `get_count` on Sensor Reading |
| `upande_sensors_app.activity` | GET | `get_list` + `get_count` on Route History, `get_list` on Activity Log, `get_list` on User |
| `upande_sensors_app.log_routes` | **POST** | `insert_many` on Route History, `route_history.deferred_insert` |
| `upande_sensors_app.reports_list` | GET | `get_list` on Issue |
| `upande_sensors_app.report_submit` | **POST** | `client.insert`, `assign_to.add`, `client.attach_file` |
| `upande_sensors_app.assignable_users` | GET | `desk.search.search_link`, `get_list` on User |

`activity` is System Manager only — that gate is deliberate, and is now
enforced once with a sentence explaining it rather than arriving as an
ambiguous 403.

## Deploying

The credentials are read from the environment and are never written to a file
in this repo:

```sh
export SENSORS_BASE_URL=https://sensor.upande.com     # the default
export SENSORS_API_TOKEN='<api_key>:<api_secret>'     # or the pair below
# export SENSORS_API_KEY=...
# export SENSORS_API_SECRET=...

npm run server:deploy:dry     # show what would change
npm run server:deploy         # create or update every script
npm run server:verify         # deploy, then call each GET endpoint
node server/deploy.mjs --only live,readings
```

The deploying account needs the **Script Manager** role: `ServerScript.validate`
calls `frappe.only_for("Script Manager", True)`, so any other account is refused
on save regardless of what else it can do. Server Scripts must also be enabled
for the site — `server_script_enabled` in `common_site_config.json`, which on
Frappe Cloud is a toggle in the site's settings, not something a script can
switch on for itself.

Deployment is idempotent: a script is matched by its `api_method`, so a second
run updates the same document. Two Server Scripts sharing one `api_method` is
the failure mode to avoid — `get_server_script_map` builds a single
`api_method -> name` dict, so whichever the cache saw first wins and a stale
copy can keep serving silently.

## Writing one of these

The scripts run under RestrictedPython (`frappe.utils.safe_exec`), which is not
Python. What actually bites:

- **No name may start with an underscore** — not a variable, not a dict key read
  by subscript. `_fd = 1` is a *compile-time* failure, so every call to the
  endpoint 500s and `py_compile` will not warn you. This is why `reports_list`
  reads `_assign` as `SELECT \`_assign\` AS assigned`.
- **No `import`.** No `datetime`, no `re`, no `math`, no `base64`. Use
  `frappe.utils` (`getdate`, `add_days`, `now`, `cint`, `flt`, `cstr`,
  `parse_json`, `strip_html`) and let SQL do the date formatting. `config.py`
  hand-rolls its slugify for want of `re`; `report_submit.py` hands base64
  straight to the File controller, which decodes it, because it cannot.
- **`round()` and `.format()` are unavailable** — `format` is on the unsafe
  attribute list. Use `frappe.utils.flt(value, 2)` and `%` or f-strings.
- **`frappe.db.sql` is SELECT-only** (`read_sql` refuses anything else), but
  `frappe.get_doc(...).insert()`, `frappe.db.set_value` and `frappe.get_all`
  are the real functions and bypass permissions — which is the point.
- **`frappe.get_roles` does not exist here.** Read `Has Role` directly, as
  `activity.py` does.
- **A write over GET is rolled back**, reporting success while changing
  nothing. The two POST scripts refuse a GET outright rather than lie about it.
- **Tuple unpacking on assignment does not work.** RestrictedPython supplies
  `_iter_unpack_sequence_` for `for` loops but no `_unpack_sequence_`, so
  `rows, since = my_helper()` raises `NameError: _unpack_sequence_` at *run*
  time — `_compile_code` passes it. Return a dict, as `latest_in_window` in
  `live.py` does.
- **A literal `%` in SQL collides with the driver's `%(name)s` placeholders**
  and the query dies before it runs. Bind LIKE patterns as parameters.

### Testing before deploying

Run them against a local bench site with real data — this is how every script
here was checked:

```python
# from sites/, with the bench's python
import frappe
from frappe.utils.safe_exec import safe_exec, _compile_code

frappe.init(site="sensors"); frappe.connect()
frappe.set_user("Administrator")

script = open("../Android/upande-sensors-app/server/scripts/live.py").read()
_compile_code(script, filename="live")        # catches the underscore trap

frappe.local.form_dict = frappe._dict({"site": "Red Lands Roses"})
frappe.local.response = frappe._dict({"docs": []})
frappe.local.request = frappe._dict({"method": "GET"})
safe_exec(script, script_filename="live")
print(frappe.local.response["message"])

frappe.db.rollback()                          # for the POST scripts
```

Worth covering: an Administrator, an account scoped to one Sensor Site by User
Permission, and an account with none at all — the last sees *every* site, which
is the app's rule and not an oversight.

## Performance

`tabSensor Reading` (~301k rows) is indexed on `timestamp`, `site_name`,
`(sensor_type, timestamp)` and `(site_name, sensor_type, sensor_name)`. There is
**no index leading with `sensor_name`, and none on `(site_name, timestamp)`**, so
a site-scoped query's cost is decided by how many rows its time window lets
through: narrow windows are served from the `timestamp` index, wide ones degrade
into a ~216k-row scan of one site.

That is why `live` defaults to a 3-day window rather than 180 days, and why
`chart_series` costs what it costs. Measured against sensor.upande.com,
Red Lands Roses, with a 0.50s bare `/api/method/ping` round trip as the floor:

| | wall | server work |
| --- | --- | --- |
| `reports_list` | 0.51s | 0.01s |
| `config`, `whoami` | 0.55s | 0.05s |
| `chart_series` 1 day, 30-min buckets | 0.56s | 0.06s |
| `chart_series` 7 days | 0.60s | 0.10s |
| `readings` page of 50 + total | 0.66s | 0.16s |
| `live` | 0.68s | 0.18s |
| `sensor_names` | 0.76s | 0.26s |
| `activity` (50 routes, 200 auth) | 0.89s | 0.39s |
| `chart_series` 60 days | 1.12s | 0.62s |

`chart_series` also returns `sensor_names` for the window, so the caller's sensor
picker costs no extra request. It had to be a *sequential* one — the picker is
scoped to what is on the chart, so it could not be issued until the chart had
arrived.

Numbers above are `curl`, which pays a fresh TLS handshake per call. The app
reuses its connection, and a device log against the same site measured `live` at
350ms and `log_routes` at ~400ms — so **request count, not latency, is what the
app feels.** `src/api/client.js` prints one `[api N] 350ms 8KB 200 <method>` line
per request under `__DEV__`; read that off the Metro console before optimising
anything.

For comparison, the calls these replaced, same site: `get_site_sensors` +
`get_live_readings` = **26.7s** sequential, and the desk's own `sensorDashboard`
script is 1.6s for a day and 3.9s for a month.

**If more speed is needed**, the structural fix is an index, not a script
change: add `("sensor_name_type_timestamp_idx", ["sensor_name", "sensor_type",
"timestamp"])` to `COMPOSITE_INDEXES` in `upande_sensors/install.py` — that file
already applies its indexes idempotently on every migrate — and the 60-day
`chart_series` and any per-sensor lookup become index seeks. It is an
`ALTER TABLE` on a 301k-row production table, so it wants a maintenance window
and a deliberate decision.

## Client side

`src/api/endpoints.js` calls these. Each loader falls back to the call it
replaced when the endpoint is absent — Frappe answers "Failed to get method for
command …", which the client reports as `isMissingEndpoint` — so an APK in the
field keeps working against a site that has not been updated yet. A **permission
error is not a fallback trigger**: it is the server answering the question, and
retrying it against an older endpoint would replace a clear refusal with
whatever that one happened to return.

`config` also returns a `units` map (lowercased sensor type -> display unit)
that nothing reads yet; it is there so a chart axis can be labelled without a
second request for the tab config.
