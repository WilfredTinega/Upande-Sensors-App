# Server-side API

The API this app is served by now lives **in the `upande_sensors` Frappe app**,
as whitelisted methods in `upande_sensors/api/mobile.py`
(`upande_sensors.api.mobile.<name>`). It is versioned with the app, installed by
`bench migrate`, and no longer needs Server Scripts to be enabled for the site.

The **Server Script** documents kept under `scripts/` here are the same
endpoints' first home, as `upande_sensors_app.<name>`. They stay deployed **only
as the fallback** for a site whose `upande_sensors` is older than the client,
and they must keep the same params and response shapes as the app methods —
that agreement is what lets the client fall from one to the other invisibly.
`manifest.json` maps files to methods; `npm run server:deploy` pushes them.

The client tries **app method → Server Script → legacy call** (where a legacy
call exists), moving on *only* when the endpoint is missing — see "Client side".

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

Primary (in the app) first, the Server Script fallback second, then what both
replaced. Params and response shapes are identical across the first two columns.

| app method `upande_sensors.api.mobile.…` | Server Script `upande_sensors_app.…` | HTTP | Replaces |
| --- | --- | --- | --- |
| `whoami` | `whoami` | GET | `get_logged_user`, `Has Role`, `User`, `System Settings.time_zone`, `change_log.get_versions` |
| `config` | `config` | GET | `get_dashboard_config`, `get_user_sites`, `get_sensor_type_options` |
| `sensor_names` | `sensor_names` | GET | `get_sensor_names`, `sensor_charts.get_sensor_names` |
| `live` | `live` | GET | `flow_plan.get_site_sensors`, `flow_plan.get_live_readings` |
| `chart_series` | `chart_series` | GET | `sensor_charts.get_chart_series`, `sensor_dashboard.sensor_dashboard` |
| `readings` | `readings` | GET | `get_list` + `get_count` on Sensor Reading |
| `activity` | `activity` | GET | `get_list` + `get_count` on Route History, `get_list` on Activity Log, `get_list` on User |
| `log_routes` | `log_routes` | **POST** | `insert_many` on Route History, `route_history.deferred_insert` |
| `reports_list` | `reports_list` | GET | `get_list` on Issue |
| `report_submit` | `report_submit` | **POST** | `client.insert`, `assign_to.add`, `client.attach_file` |
| `assignable_users` | `assignable_users` | GET | `desk.search.search_link`, `get_list` on User |
| `dashboard_health` | `dashboard_health` | GET | new: `site, stale_minutes` → `{stale_minutes, tabs: {<Sensor Setting row name>: {total, active, stale, last_reading, scope}}, site}` |
| `floor_plans` | `floor_plans` | GET | `flow_plan.list_flow_plans`, `get_flow_plan`, `get_live_readings`, `get_door_stats` |
| `sensors_for_location` | `sensors_for_location` | GET | new: `site, search` → `{rows: [{name, sensor_name, sensor_site, sensor_type, monitoring, latitude, longitude, location_accuracy_m, location_samples, location_updated_on, location_updated_by, has_location}], total}` |
| `set_sensor_location` | `set_sensor_location` | **POST** | new: `sensor, latitude, longitude, accuracy_m, samples, device` → the updated row + `history_name`, `previous` |
| `sensor_location_history` | `sensor_location_history` | GET | new: `sensor, start, page_length` → `{rows: [{latitude, longitude, accuracy_m, samples, source, device, user, recorded_at, previous_latitude, previous_longitude}], total, supported}` |
| `sensor_map` | `sensor_map` | GET | new: `site, stale_minutes` → `{stale_minutes, sensors: [{…, latitude, longitude, location_accuracy_m, last_reading, online, values: {<type>: {value, unit, ts}}}], center, map: {mapbox_token}}` |
| `register_push_token` | — | **POST** | new: `token, platform, device, app_version` → Expo push registration |
| `unregister_push_token` | — | **POST** | new: `token` |
| `alerts` | — | GET | new: `site, since_days=7, start, page_length` → `{ rows, total }` of limit breaches |

`config` additionally returns `app: { welcome_message, support_contact,
stale_after_minutes }` from Sensor Settings **on the app method only**; the
script predates those fields and the client treats their absence as "use the
defaults" (stale default 120 minutes).

`log_routes` is sent `source: 'app'`, and the server refuses Administrator rows
carrying it — the client never records the Administrator either (see
`RootNavigator`), so the two sides agree.

The three push/alert methods are **app-only**: they arrived after the Server
Script era, there is no script to fall back to, and the client treats a missing
endpoint as "this server has no alerts" (the Home card is hidden, the Account
row says so).

### Tab gating

`sensor_names`, `live`, `chart_series`, `readings` and `dashboard_health` all
take a **`tab_tag`** and resolve it the same way — one block of code, copied
byte-identically into the five files, because Server Scripts are standalone
documents and cannot import one another. `floor_plans` is the deliberate
exception: the floor plan tab's sensors are whatever is pinned to a Flow Plan,
not a monitoring type, which is how `upande_sensors.api.mobile` scopes it too.

`tab_tag` is accepted in **either form** — the dashboard slug the app sends
(`cold-chain-monitoring`, from `activeTab.slug`) or the website's short tag
(`cold_chain`) — and resolves to one or more **Sensor Monitoring Types**
(`Sensor.monitoring`), matching
`upande_sensors.api.sensor_charts.monitoring_types_for_tab` /
`sensor_names_for_monitoring` and `mobile._apply_gate`. Three outcomes:

| resolution | the gate |
| --- | --- |
| no monitoring type (`floor-plan`, `pump-control`, an unknown tag) | no sensor filter — the whole site, as before |
| a type, and sensors carry it | only those sensors |
| a type, and **no** sensor carries it | **nothing** — empty series, empty list, `total: 0` |

The third row is the fix. Until 2026-09-13 these scripts keyed their map on the
short tags only and gated on the retired `Sensor.track_in_cold_chain` /
`track_in_cold_room` / `track_greenhouse` / `track_in_pumps_energy` /
`track_vehicle` checkboxes. An unknown key means "ungated", so a slug from the
app never matched and the gate never fired at all: **every tab drew every sensor
at the site.** That is the MKA report — a site with no cold chain and no cold
room whose Cold Chain and Cold Room tabs were full of greenhouse data. Measured
on the local `sensors` site, MKA, 2026-07-01..20: Cold Chain and Cold Room each
served 4 sensors, 10,049 readings and two full 20-point series before; both now
serve 0 sensors, 0 readings and no series, and the site's other tabs are
untouched.

"No cold chain here" and "this tab does not gate" must not produce the same
answer, which is exactly what they used to do.

The retired checkboxes are still read, but **only** on a site whose `Sensor`
doctype has no `monitoring` field (`frappe.get_meta("Sensor").has_field`), so an
older site keeps working. Every column read is guarded by `has_field` first:
asking for a column a site does not have is a 500, and a 500 reaches the app as
an empty chart. Where neither the field nor the checkbox exists, the tab is left
ungated rather than silently emptied — the behaviour these scripts always had.

A user granted particular Sensors (Sensor Settings → Grant Access) is narrowed
to those on top of the tab gate, the same rule `mobile._sensor_gate` applies;
an account with no Sensor grant at all is unrestricted, as before.

`dashboard_health` and `floor_plans` were app-only too, and that is why the Home
tiles showed no sensor counts and the Floor Plan tab said "needs a newer
server": `upande_sensors/api/mobile.py` is not deployed to sensor.upande.com, so
both answered "Failed to get method for command" and the client — correctly —
hid a feature it could not get an honest answer for. The scripts here are the
same two endpoints on a path that exists today. `dashboard_health` scopes each
tab the way the dashboards do: `Sensor.monitoring` for the monitoring-tagged
tabs (cold room, cold chain, greenhouse, vehicle, pump/energy), the Flow Plan
placements for the floor plan tab, the tab's configured Sensor Types otherwise —
and **zeros with `scope: "none"`** for a tab whose sensors cannot be identified,
never the site-wide total, which on a tile is indistinguishable from a real
count. `floor_plans` is read-only by construction: it has no write path, and
the app calls none of the plan-editing endpoints.

Also in the app, not a data endpoint: `upande_sensors.api.ota.manifest` (GET)
proxies the Expo Updates manifest from GitHub Pages and adds the
`expo-protocol-version: 1` header the client requires — see `docs/OTA.md`.

`activity` is System Manager only — that gate is deliberate, and is now
enforced once with a sentence explaining it rather than arriving as an
ambiguous 403.

### Sensor coordinates and map

`sensors_for_location`, `set_sensor_location`, `sensor_location_history` and
`sensor_map` serve the app's **Set coordinates** and **Sensor list** screens.
They share one block of code — between `# ── Location block` and `# ── end of
the shared location block` — copied byte-identically into the four files for
the same reason the tab gate is: a Server Script cannot import another. Change
one, change all four.

What the block decides:

- **Who may write.** `can_set_location()` is true for the Administrator or a
  System Manager — nothing else — read from `Has Role` directly
  (`frappe.get_roles` is not in the sandbox). It is the same rule as
  `config().app.can_set_location`, which hides the button on the phone;
  `set_sensor_location` refuses everyone else with a `PermissionError`, so
  hiding the button is enough. Reading is scoped like
  every other script here — Sensor Site User Permissions, narrowed by Sensor
  grants.
- **What "has a location" means.** `has_coords` is false for NULL *and* for
  0,0: an untouched Float pair reads as 0,0, and 0,0 is a point in the Gulf of
  Guinea. `set_sensor_location` refuses 0,0 outright, and latitudes outside
  ±90 / longitudes outside ±180.
- **Which columns exist.** The five `location_*` columns on Sensor
  (`location_accuracy_m`, `location_samples`, `location_updated_on`,
  `location_updated_by`, `location_source`) and the **Sensor Location History**
  doctype are new in `upande_sensors`. Every read and write is guarded by
  `frappe.get_meta("Sensor").has_field(...)` / `frappe.db.exists("DocType",
  ...)`: an older site gets its coordinates written and nulls for the rest,
  never a 500 over a column it does not have. A `location_*` value of 0 is
  reported as null too — the columns default to 0, and "±0 m from 0 fixes" is
  a precision claim nobody made.
- **The site link** is `Sensor.sensor_location` on current sites and
  `sensor_site` on some older ones; the response always says `sensor_site`.

`set_sensor_location` writes with `frappe.db.set_value`, not a document save:
the Sensor controller's validation is about commissioning (DevEUI, application
key), and a save would refuse a legacy row that fails a rule added since it was
created — leaving the installer unable to place it. Each save inserts a Sensor
Location History row carrying the position it replaced, where the doctype
exists.

`sensor_map` returns only sensors WITH coordinates, and `online` is the Home
tiles' rule — newest reading inside `stale_minutes`, else Sensor Settings →
Stale After, else 120 — so the dot on the map and the count on Home agree. The
latest value per measure is the `live` query by `sensor_name` only (a
reading's `site_name` and the registry's site can disagree), over 30 days and
widened once to 400 when the window is empty. `map.mapbox_token` is Sensor
Settings → Mapbox Access Token read through `doc.get_password(...,
raise_exception=False)` — a Password field; the sandbox has no
`frappe.utils.password`. Empty means the phone draws OpenStreetMap tiles.

Tested on the local `sensors` site the way the section below describes: all
four `_compile_code` and `safe_exec` as Administrator (reads with and without
`site` and `search`; the POST by docname, by `sensor_name`, and as an
overwrite returning `previous`), the refusals (GET, 0,0, latitude 95, and an
`IoT User` account), and the value lookup with a Sensor inserted for a
reporting `sensor_name` inside a rolled-back transaction.

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
- **`frappe.db.has_column` is not in the sandbox** — the whitelist is
  `get_list`, `get_all`, `get_value`, `get_single_value`, `get_default`,
  `exists`, `count`, `escape`, `sql`. Ask the doctype instead:
  `frappe.get_meta("Sensor").has_field(...)`, which is what the tab gate does
  before it reads `monitoring` or any `track_*` column.
- **The tab gate is duplicated on purpose.** The block between
  `# ── Tab gate` and `# ── end of the shared tab gate` is byte-identical in
  `sensor_names.py`, `live.py`, `chart_series.py`, `readings.py` and
  `dashboard_health.py` — a script cannot import another script, so a `diff`
  between any two of those blocks being empty is the only guarantee the five
  endpoints answer the same question. Change one, change all five.
- **The location block is duplicated the same way**, across
  `sensors_for_location.py`, `set_sensor_location.py`,
  `sensor_location_history.py` and `sensor_map.py` — see "Sensor coordinates
  and map" above. Change one, change all four.

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

For the tab gate specifically, no `Sensor` on the local site carries a
`monitoring` value, so the *empty* half of the gate is what you get for free:
ask for `tab_tag="cold-chain-monitoring"` on MKA and every endpoint must answer
with nothing. Prove the other half inside the same transaction — insert a
`Sensor` row with `monitoring: "Cold Chain"` and a `sensor_name` that has
readings, re-run, and the gate should let exactly that one through — then
`frappe.db.rollback()`. The legacy path is testable the same way: delete the
`monitoring` DocField row, insert a `track_in_cold_chain` one, `frappe.clear_cache(doctype="Sensor")`,
and roll back.

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

`src/api/endpoints.js` calls these through `viaChain([...])`: the app method,
then the Server Script, then the legacy call where one exists. The chain moves
to the next link **only** when the endpoint is absent — Frappe answers "Failed
to get method for command …", which the client reports as `isMissingEndpoint` —
so an APK in the field keeps working against a site that has not been updated
yet, whichever generation of the API it carries. A **permission error is not a
fallback trigger**: it is the server answering the question, and retrying it
against an older endpoint would replace a clear refusal with whatever that one
happened to return. `tests/endpointsChain.test.js` pins both halves of that
rule. When every link is missing, the last missing-endpoint error is rethrown
as-is, so callers such as `trend.js` can still tell "older server" from
"broken".

`config` also returns a `units` map (lowercased sensor type -> display unit)
that nothing reads yet; it is there so a chart axis can be labelled without a
second request for the tab config.
