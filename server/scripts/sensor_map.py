# Server Script — script_type: API · api_method: upande_sensors_app.sensor_map · allow_guest: 0
#
# Everything the app's Sensor Map draws, in ONE request: every positioned
# sensor the account may see, whether each is reporting, its latest value per
# measure, where to centre the map when there is nothing to fit, and the
# basemap key.
#
# `online` is the same rule the Home tiles and the Live header use — the newest
# reading is inside the stale window (`stale_minutes`, else Sensor Settings →
# Stale After, else 120) — so a green dot on the map and a green count on Home
# agree about the same sensor. A sensor with no reading in the window is
# offline with `last_reading` null, which the phone draws grey rather than red:
# "never heard from" and "went quiet" are different problems.
#
# Only sensors WITH coordinates are returned. 0,0 does not count (see the
# shared block); the phone shows an empty state with a way to the coordinate
# capture when the list comes back empty.
#
# `map.mapbox_token` is Sensor Settings → Mapbox Access Token, the same key the
# website's maps use, so a phone shows the same basemap as the desk when the
# site has one and OpenStreetMap when it has not. It is a Password field:
# `get_password` decrypts it, and an unset or undecryptable one is "".
#
# Same response shape as `upande_sensors.api.mobile.sensor_map`:
#
#   {stale_minutes,
#    sensors: [{name, sensor_name, sensor_site, sensor_type, monitoring,
#               latitude, longitude, location_accuracy_m, last_reading, online,
#               values: {<type>: {value, unit, ts}}}],
#    center: {latitude, longitude} | null,
#    map: {mapbox_token}}
#
# Params: site (optional), stale_minutes (optional)

SESSION_USER = frappe.session.user
UNRESTRICTED = SESSION_USER == "Administrator"

# ── Location block ───────────────────────────────────────────────────────────
#
# BYTE-IDENTICAL COPY. The same block is in sensors_for_location.py,
# set_sensor_location.py, sensor_location_history.py and sensor_map.py — a
# Server Script cannot import another, so the four share it by duplication.
# Change one, change all four, and keep `diff` between any two of them empty.

# Who may WRITE coordinates: the Administrator, or a System Manager — nothing
# else. Read through `Has Role` directly: the sandbox has no `frappe.get_roles`.
# Matches `config().app.can_set_location`, which is what hides the button on
# the phone; this is the check that makes hiding it enough.
WRITE_ROLE = "System Manager"

# The Sensor columns the coordinate capture writes besides latitude/longitude.
# Optional on purpose: an older upande_sensors has none of them, and a script
# that assumed them would 500 for the one site most likely to still be running
# it. Read and written only where `has_field` says they exist.
LOCATION_FIELDS = [
	"location_accuracy_m",
	"location_samples",
	"location_updated_on",
	"location_updated_by",
	"location_source",
]
HISTORY_DOCTYPE = "Sensor Location History"

SENSOR_META = frappe.get_meta("Sensor")

# The link from a Sensor to its Sensor Site has been called both of these. The
# response always says `sensor_site`, whichever column answers.
SITE_FIELD = None
for candidate in ["sensor_location", "sensor_site"]:
	if SITE_FIELD is None and SENSOR_META.has_field(candidate):
		SITE_FIELD = candidate


def arg(key, default=""):
	val = frappe.form_dict.get(key)
	if val is None:
		return default
	val = frappe.utils.cstr(val).strip()
	return val or default


def scoped(allow):
	"""User Permission values for this account, or [] when there are none."""
	rows = frappe.get_all(
		"User Permission",
		filters={"user": SESSION_USER, "allow": allow},
		fields=["for_value"],
		limit_page_length=0,
	)
	return sorted(set([r.get("for_value") for r in rows if r.get("for_value")]))


def can_set_location():
	if UNRESTRICTED:
		return True
	rows = frappe.get_all(
		"Has Role",
		filters={"parent": SESSION_USER, "parenttype": "User", "role": WRITE_ROLE},
		fields=["role"],
		limit_page_length=1,
	)
	return bool(rows)


def has_coords(lat, lng):
	"""Set, and not the 0,0 an untouched Float pair reads as."""
	if lat is None or lng is None:
		return False
	return not (frappe.utils.flt(lat) == 0 and frappe.utils.flt(lng) == 0)


def sensor_fields():
	"""The Sensor columns to read — only the ones this site has."""
	fields = ["name", "sensor_name", "sensor_type", "latitude", "longitude"]
	if SITE_FIELD:
		fields.append(SITE_FIELD)
	if SENSOR_META.has_field("monitoring"):
		fields.append("monitoring")
	for field in LOCATION_FIELDS:
		if SENSOR_META.has_field(field):
			fields.append(field)
	return fields


def optional_float(row, field):
	"""A location_* number, or None when the site lacks the column OR it is 0.

	The columns default to 0, not NULL, so a sensor placed before they existed
	— or by hand on the desk — reads "±0 m from 0 fixes", which is a precision
	claim nobody made. Zero is "unknown" for both, and unknown is null.
	"""
	if not SENSOR_META.has_field(field) or not row.get(field):
		return None
	return frappe.utils.flt(row.get(field))


def optional_int(row, field):
	if not SENSOR_META.has_field(field) or not row.get(field):
		return None
	return frappe.utils.cint(row.get(field))


def optional_str(row, field):
	if not SENSOR_META.has_field(field):
		return None
	return frappe.utils.cstr(row.get(field) or "")[:19] or None


def location_row(row):
	"""One Sensor as the app's location row. `row` is a get_all dict."""
	lat = row.get("latitude")
	lng = row.get("longitude")
	ok = has_coords(lat, lng)
	return {
		"name": row.get("name"),
		"sensor_name": row.get("sensor_name") or row.get("name"),
		"sensor_site": (row.get(SITE_FIELD) if SITE_FIELD else "") or "",
		"sensor_type": row.get("sensor_type") or "",
		"monitoring": row.get("monitoring") or "",
		"latitude": frappe.utils.flt(lat) if ok else None,
		"longitude": frappe.utils.flt(lng) if ok else None,
		"location_accuracy_m": optional_float(row, "location_accuracy_m"),
		"location_samples": optional_int(row, "location_samples"),
		"location_updated_on": optional_str(row, "location_updated_on"),
		"location_updated_by": (row.get("location_updated_by") or None)
		if SENSOR_META.has_field("location_updated_by")
		else None,
		"has_location": ok,
	}


def sensor_scope_filters(site, allowed_sites):
	"""get_all filters narrowing Sensor to the site and this account's grants.

	A site is asked for by name; without one, a restricted account gets its
	permitted sites and an unrestricted one gets everything. A Sensor grant
	(Sensor Settings → Grant Access) narrows further, to those documents — the
	same convention every other script here follows: only a non-empty grant
	restricts.
	"""
	filters = []
	if SITE_FIELD:
		if site:
			filters.append([SITE_FIELD, "=", site])
		elif allowed_sites is not None:
			filters.append([SITE_FIELD, "in", allowed_sites])
	if not UNRESTRICTED:
		granted = scoped("Sensor")
		if granted:
			filters.append(["name", "in", granted])
	return filters


# ── end of the shared location block ─────────────────────────────────────────

# Sensor Settings → Stale After, when the field is empty. Matches the client's
# own default, so a site that never configured it still agrees with the phone.
DEFAULT_STALE_AFTER_MINUTES = 120

# How far back to look for a sensor's latest value. `tabSensor Reading` has no
# index leading with sensor_name, so the window decides the cost, and this
# screen re-polls every minute. A map with NOTHING in the window is widened
# once: a site whose gateway has been down for a month should show its sensors
# grey with old values, not as though none had ever reported.
READING_WINDOW_DAYS = 30
READING_FALLBACK_DAYS = 400

# Fallback display units per measure — the same table `config` carries, so a
# popup on the map and an axis on the chart label a value the same way.
DEFAULT_UNITS = {
	"temperature": "°C",
	"soil temperature": "°C",
	"humidity": "%",
	"soil moisture": "%",
	"precipitation": "mm",
	"pressure": "bar",
	"battery": "V",
	"level": "m",
	"flow": "m³/h",
	"energy": "kWh",
	"ec": "mS/cm",
}


def named_params(prefix, values):
	"""{"keys": ["%(p0)s", ...], "params": {...}} for an IN clause.

	Named placeholders rather than a `%s` list built with the `%` operator: a
	literal `%` in the SQL collides with the driver's own parameter syntax and
	the statement dies before it runs. A dict because RestrictedPython has no
	`_unpack_sequence_` — `keys, params = ...` is a NameError at run time.
	"""
	keys = []
	params = {}
	idx = 0
	for value in values:
		key = prefix + str(idx)
		params[key] = value
		keys.append("%(" + key + ")s")
		idx = idx + 1
	return {"keys": keys, "params": params}


# ── Scope ────────────────────────────────────────────────────────────────────

allowed_sites = None if UNRESTRICTED else (scoped("Sensor Site") or None)

site = arg("site")
if site and allowed_sites is not None and site not in allowed_sites:
	frappe.throw("You do not have access to site " + site, frappe.PermissionError)

settings = frappe.get_cached_doc("Sensor Settings")

minutes = frappe.utils.cint(arg("stale_minutes")) or 0
if not minutes:
	minutes = frappe.utils.cint(settings.get("app_stale_after_minutes")) or DEFAULT_STALE_AFTER_MINUTES

now_str = frappe.utils.now()
cutoff_str = frappe.utils.cstr(frappe.utils.add_to_date(now_str, minutes=-minutes))[:19]

# Configured units by lowercased type, over the defaults.
units = {}
units.update(DEFAULT_UNITS)
for tr in settings.get("sensor_types") or []:
	label = frappe.utils.cstr(tr.get("sensor_type") or "").strip().lower()
	unit = frappe.utils.cstr(tr.get("unit") or "").strip()
	if label and unit:
		units[label] = unit

# ── The positioned sensors ───────────────────────────────────────────────────

found = frappe.get_all(
	"Sensor",
	filters=sensor_scope_filters(site, allowed_sites),
	fields=sensor_fields(),
	order_by="sensor_name asc",
	limit_page_length=0,
)

sensors = []
names = []
for row in found:
	if not row.get("sensor_name"):
		continue
	if not has_coords(row.get("latitude"), row.get("longitude")):
		continue
	base = location_row(row)
	sensors.append(
		{
			"name": base["name"],
			"sensor_name": base["sensor_name"],
			"sensor_site": base["sensor_site"],
			"sensor_type": base["sensor_type"],
			"monitoring": base["monitoring"],
			"latitude": base["latitude"],
			"longitude": base["longitude"],
			"location_accuracy_m": base["location_accuracy_m"],
			"last_reading": None,
			"online": False,
			"values": {},
		}
	)
	if base["sensor_name"] not in names:
		names.append(base["sensor_name"])

# ── Latest value per (sensor, measure) ───────────────────────────────────────


def latest_in_window(days):
	"""Newest value per (sensor, measure) for the positioned sensors.

	By sensor_name only, not by site: a reading's site_name and the registry's
	site can disagree (the tab gate documents the Kaptumbo case), and the
	sensors are already scoped above. SUBSTRING_INDEX(GROUP_CONCAT(... ORDER BY
	timestamp DESC), ',', 1) takes the newest value of each group without a
	correlated subquery; the cap at now() keeps the handful of rows with
	implausible future timestamps from winning.
	"""
	picked = named_params("n", names)
	params = {}
	params.update(picked["params"])
	params["since"] = frappe.utils.add_days(frappe.utils.today(), -days) + " 00:00:00"
	params["until"] = now_str
	return frappe.db.sql(
		"SELECT sensor_name, LOWER(COALESCE(sensor_type, '')) AS sensor_type, "
		"MAX(timestamp) AS ts, "
		"SUBSTRING_INDEX(GROUP_CONCAT(value ORDER BY timestamp DESC), ',', 1) AS latest_value "
		"FROM `tabSensor Reading` WHERE sensor_name IN ("
		+ ", ".join(picked["keys"])
		+ ") AND timestamp >= %(since)s AND timestamp <= %(until)s "
		"GROUP BY sensor_name, LOWER(COALESCE(sensor_type, ''))",
		params,
		as_dict=True,
	)


raw = []
if names:
	raw = latest_in_window(READING_WINDOW_DAYS)
	if not raw:
		raw = latest_in_window(READING_FALLBACK_DAYS)

by_sensor = {}
for row in raw:
	nm = row.get("sensor_name")
	if not nm:
		continue
	if nm not in by_sensor:
		by_sensor[nm] = {}
	measure = row.get("sensor_type") or ""
	ts = frappe.utils.cstr(row.get("ts") or "")[:19]
	by_sensor[nm][measure] = {
		"value": frappe.utils.flt(row.get("latest_value"))
		if row.get("latest_value") is not None
		else None,
		"unit": units.get(measure, ""),
		"ts": ts or None,
	}

for entry in sensors:
	measures = by_sensor.get(entry["sensor_name"]) or {}
	entry["values"] = measures
	latest = None
	for measure in measures:
		ts = measures[measure].get("ts")
		if ts and (latest is None or ts > latest):
			latest = ts
	entry["last_reading"] = latest
	entry["online"] = bool(latest and latest >= cutoff_str)

# ── Centre, for a map with nothing to fit to ─────────────────────────────────

center = None
if sensors:
	lat_sum = 0.0
	lng_sum = 0.0
	for entry in sensors:
		lat_sum = lat_sum + entry["latitude"]
		lng_sum = lng_sum + entry["longitude"]
	center = {
		"latitude": frappe.utils.flt(lat_sum / len(sensors), 6),
		"longitude": frappe.utils.flt(lng_sum / len(sensors), 6),
	}

# Decrypted from the Password field. `raise_exception=False` turns an unset
# token, or one encrypted under a key this site no longer has, into None.
mapbox_token = ""
if frappe.get_meta("Sensor Settings").has_field("mapbox_access_token"):
	mapbox_token = (
		frappe.get_doc("Sensor Settings").get_password("mapbox_access_token", raise_exception=False)
		or ""
	)

frappe.response["message"] = {
	"stale_minutes": minutes,
	"sensors": sensors,
	"center": center,
	"map": {"mapbox_token": frappe.utils.cstr(mapbox_token).strip()},
}
