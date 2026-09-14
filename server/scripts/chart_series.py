# Server Script — script_type: API · api_method: upande_sensors_app.chart_series · allow_guest: 0
#
# Every measure's time series for a window, in ONE request, always from raw
# readings.
#
# Replaces two endpoints and fixes what each of them got wrong for the app:
#
#  * get_chart_series was one request PER measure — four parallel requests for a
#    single chart. It also returned display labels ("09-08 14:00", "09-Aug")
#    with no year, so the app had to regenerate the bucket grid locally and zip
#    the values back on by index. Here every point carries its own ISO bucket,
#    so a measure that reports at a different cadence can no longer be silently
#    shifted onto the wrong instant.
#
#  * sensor_dashboard answered all measures in one request but switched to the
#    pre-computed hourly rollup (__sensor_reading_hourly) for any window of two
#    days or more. Where the hourly job has never run that table is empty, so
#    the query succeeded, returned nothing, and the chart said "no readings in
#    this range" while the raw readings sat there untouched — which is exactly
#    what the 7, 30 and 60 day ranges did. This reads raw readings at every
#    width, so there is no silent-empty case.
#
# Params: site, sensor_name, tab_tag, sensor_types (JSON array or CSV),
#         date_from, date_to (YYYY-MM-DD, both inclusive),
#         interval (hourly|daily|weekly|monthly|yearly) or bucket_mins (int)
#
# `tab_tag` is accepted in either form — the dashboard slug the app sends
# ("cold-chain-monitoring") or the website's short tag ("cold_chain") — and is
# resolved through Sensor.monitoring by the shared tab gate below. A tab that
# resolves to a monitoring type no sensor at this site carries charts NOTHING,
# which is what a cold chain tab on a site without one has to say.

SESSION_USER = frappe.session.user
UNRESTRICTED = SESSION_USER == "Administrator"

# SUM rather than AVG: these are counters, not states, so a bucket's value is
# what accumulated during it.
CUMULATIVE = ["energy", "flow", "precipitation", "rainfall"]

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

# ISO-shaped keys only, so the app can build its axis from the key itself.
INTERVAL_FORMATS = {
	"hourly": "%Y-%m-%d %H:00:00",
	"daily": "%Y-%m-%d",
	"monthly": "%Y-%m",
	"yearly": "%Y",
}

def arg(key, default=""):
	val = frappe.form_dict.get(key)
	if val is None:
		return default
	val = frappe.utils.cstr(val).strip()
	return val or default


def scoped_sites():
	if UNRESTRICTED:
		return None
	rows = frappe.get_all(
		"User Permission",
		filters={"user": SESSION_USER, "allow": "Sensor Site"},
		fields=["for_value"],
		limit_page_length=0,
	)
	names = sorted(set([r.get("for_value") for r in rows if r.get("for_value")]))
	return names or None


def wanted_types(raw):
	"""Accept a JSON array or a comma-separated list; keep the app's labels."""
	text = frappe.utils.cstr(raw or "").strip()
	if not text:
		return []
	items = []
	if text.startswith("["):
		parsed = frappe.utils.parse_json(text)
		if isinstance(parsed, list):
			items = parsed
	else:
		items = text.split(",")
	out = []
	for item in items:
		label = frappe.utils.cstr(item or "").strip()
		if label and label not in out:
			out.append(label)
	return out


def in_clause(column, names, params, prefix):
	keys = []
	for idx, name in enumerate(names):
		key = prefix + str(idx)
		params[key] = name
		keys.append("%(" + key + ")s")
	return column + " IN (" + ", ".join(keys) + ")"


# ── Tab gate ─────────────────────────────────────────────────────────────────
#
# BYTE-IDENTICAL COPY. The same block, character for character, is in
# sensor_names.py, live.py, chart_series.py, readings.py and
# dashboard_health.py. Server Scripts are standalone documents and cannot
# import one another, so duplication is the only way to share it: change one,
# change all five, and keep `diff` between any two of these blocks empty.
# It depends on nothing but `frappe` and the SESSION_USER / UNRESTRICTED pair
# every one of those scripts defines at the top.
#
# What it replaced, and why. The app sends `tab_tag` as the dashboard's SLUG
# ("cold-chain-monitoring"); these scripts used to key a map on the website's
# short tags ("cold_chain") and gate on the Sensor `track_in_cold_chain`
# checkbox. An unknown key means "ungated", so the gate never fired for the app
# at all: every tab drew every sensor at the site. That is the MKA report — a
# site with no cold chain and no cold room whose Cold Chain and Cold Room tabs
# were full of other sensors' data.
#
# Both forms are accepted now (slug and short tag normalise to the same thing),
# and a tab resolves to one or more Sensor Monitoring Types — where a sensor's
# purpose has lived since upande_sensors replaced the track_* checkboxes
# (install.SENSOR_MONITORING_TYPES / backfill_sensor_monitoring). The rule
# matches upande_sensors.api.sensor_charts.monitoring_types_for_tab +
# sensor_names_for_monitoring and upande_sensors.api.mobile._apply_gate.
#
# Three outcomes, and the middle one is the whole fix:
#
#   None  the tab resolves to no monitoring type   -> no sensor filter
#   []    it resolves, and NO sensor carries the type -> show nothing
#   list  the sensors carrying it                  -> filter to those
#
# "This site has no cold chain" and "this tab does not gate" must not produce
# the same answer, which is precisely what they used to do.

# Tab -> Sensor Monitoring Type(s). Keyed by the normalised form of both
# identities a tab has: the SPA's short tab_tag (cold_room) and the tab
# key/slug the app reads out of `config` (cold-room-monitoring). A tab whose
# slug simply IS a monitoring type's slug is resolved generically below, so a
# type added later needs no edit here; this map is for the names that do not
# match their type ("Pumps and Energy" covers two, "Vehicle Tracking" one).
TAB_MONITORING = {
	"cold-room": ["Cold Room"],
	"cold-room-monitoring": ["Cold Room"],
	"cold-chain": ["Cold Chain"],
	"cold-chain-monitoring": ["Cold Chain"],
	"greenhouse": ["Greenhouse"],
	"greenhouse-monitoring": ["Greenhouse"],
	"vehicle": ["Vehicle"],
	"vehicle-tracking": ["Vehicle"],
	"pumps-energy": ["Pump", "Energy"],
	"pumps-and-energy": ["Pump", "Energy"],
}

# The retired checkbox that answers for each monitoring type on a site whose
# upande_sensors predates the `monitoring` link. Pump and Energy shared one
# checkbox, which is why one tab covers both types today.
LEGACY_MONITORING_FIELDS = {
	"Cold Chain": "track_in_cold_chain",
	"Cold Room": "track_in_cold_room",
	"Greenhouse": "track_greenhouse",
	"Pump": "track_in_pumps_energy",
	"Energy": "track_in_pumps_energy",
	"Vehicle": "track_vehicle",
}


def gate_slug(label):
	"""Lowercase, every run of non-alphanumerics collapsed to one dash.

	Hand-rolled: the sandbox has no `re`. Dashes, underscores and spaces all
	collapse to the same separator, so "cold_room", "Cold Room" and
	"cold-room" are one key — which is how both forms of tab_tag are accepted
	without a second map. Matches the slugs `config` reports, minus its "tab"
	fallback for an empty label, which a gate has no use for.
	"""
	out = []
	dashed = False
	for ch in frappe.utils.cstr(label or "").strip().lower():
		if ("a" <= ch <= "z") or ("0" <= ch <= "9"):
			out.append(ch)
			dashed = False
		elif not dashed:
			out.append("-")
			dashed = True
	return "".join(out).strip("-")


def monitoring_types_by_slug():
	"""{slug: Sensor Monitoring Type name} for the types this site actually has."""
	found = {}
	if not frappe.db.exists("DocType", "Sensor Monitoring Type"):
		return found
	for row in frappe.get_all("Sensor Monitoring Type", fields=["name"], limit_page_length=0):
		nm = row.get("name")
		if nm:
			found[gate_slug(nm)] = nm
	return found


def monitoring_for_tab(tab_tag, label=None):
	"""The Sensor Monitoring Types whose sensors belong on a tab, or [].

	Order: the explicit map (the only thing that can know "Pumps and Energy" is
	two types), then a tab whose slug IS the slug of a monitoring type this site
	has, then the same with a trailing "-monitoring" trimmed. The generic steps
	are what stop a tab added later from falling back to counting the whole site.
	"""
	candidates = []
	for raw in [tab_tag, label]:
		slug = gate_slug(raw)
		if slug and slug not in candidates:
			candidates.append(slug)
	for slug in candidates:
		if slug in TAB_MONITORING:
			return TAB_MONITORING[slug]
	known = monitoring_types_by_slug()
	for slug in candidates:
		if slug in known:
			return [known[slug]]
	for slug in candidates:
		if slug.endswith("-monitoring"):
			trimmed = slug[: -len("-monitoring")]
			if trimmed in known:
				return [known[trimmed]]
	return []


def sensors_for_monitoring(types):
	"""Registry sensor_names carrying any of these monitoring types.

	Deliberately NOT site-scoped: a reading's site_name and the registry's site
	can disagree (Kaptumbo Cold Room reads under Karen Roses but is registered
	at Lokitela Orchards), and a site-scoped lookup dropped those sensors out of
	their own tab. The purpose belongs to the sensor; the site filter still
	applies to the readings.

	`Sensor.monitoring` is the current answer. Only where that field does not
	exist do the retired track_* checkboxes answer instead — and every column
	read is guarded by has_field first, because asking for a column this site
	does not have is a 500 that reaches the app as an empty chart. Returns None
	when neither can be read at all: nothing identifies the tab there, so it is
	left ungated rather than silently emptied.
	"""
	if not types:
		return None
	meta = frappe.get_meta("Sensor")
	if meta.has_field("monitoring"):
		keys = []
		params = {}
		idx = 0
		for value in types:
			key = "mt" + str(idx)
			params[key] = value
			keys.append("%(" + key + ")s")
			idx = idx + 1
		rows = frappe.db.sql(
			"SELECT DISTINCT sensor_name FROM `tabSensor` WHERE monitoring IN ("
			+ ", ".join(keys)
			+ ") AND sensor_name IS NOT NULL AND sensor_name <> ''",
			params,
			as_dict=True,
		)
		return sorted(set([r.get("sensor_name") for r in rows if r.get("sensor_name")]))
	fields = []
	for value in types:
		field = LEGACY_MONITORING_FIELDS.get(value)
		if field and field not in fields and meta.has_field(field):
			fields.append(field)
	if not fields:
		return None
	names = []
	for field in fields:
		for row in frappe.get_all(
			"Sensor", filters={field: 1}, fields=["sensor_name"], limit_page_length=0
		):
			nm = row.get("sensor_name")
			if nm:
				names.append(nm)
	return sorted(set(names))


def tab_sensor_names(tab_tag, label=None):
	"""The sensors a tab owns. None = ungated, [] = gated and owns nothing."""
	return sensors_for_monitoring(monitoring_for_tab(tab_tag, label))


def granted_sensor_names():
	"""sensor_names this account is limited to by Sensor User Permissions.

	None = no restriction: Administrator, or an account with no Sensor row at
	all. The same convention the dashboards use — only a non-empty grant
	restricts.
	"""
	if UNRESTRICTED:
		return None
	docnames = [
		r.get("for_value")
		for r in frappe.get_all(
			"User Permission",
			filters={"user": SESSION_USER, "allow": "Sensor"},
			fields=["for_value"],
			limit_page_length=0,
		)
		if r.get("for_value")
	]
	if not docnames:
		return None
	rows = frappe.get_all(
		"Sensor", filters={"name": ["in", docnames]}, fields=["sensor_name"], limit_page_length=0
	)
	return sorted(set([r.get("sensor_name") for r in rows if r.get("sensor_name")]))


def gated_sensor_names(tab_tag, label=None):
	"""The sensor names a tab AND this account's Sensor grants allow.

	None = no restriction, [] = restricted to nothing, else the list. Mirrors
	upande_sensors.api.mobile._sensor_gate.
	"""
	names = tab_sensor_names(tab_tag, label)
	mine = granted_sensor_names()
	if mine is None:
		return names
	if names is None:
		return mine
	allow = set(mine)
	return [n for n in names if n in allow]


# ── end of the shared tab gate ───────────────────────────────────────────────


site = arg("site")
sensor_name = arg("sensor_name")
tab_tag = arg("tab_tag")
date_from = arg("date_from") or frappe.utils.today()
date_to = arg("date_to") or frappe.utils.today()
interval = arg("interval", "daily").lower()
bucket_mins = frappe.utils.cint(arg("bucket_mins", "0"))
types = wanted_types(frappe.form_dict.get("sensor_types"))

allowed = scoped_sites()
if site and allowed is not None and site not in allowed:
	frappe.throw("You do not have access to site " + site, frappe.PermissionError)

# Scoping first: the measure-discovery query below needs the same window and the
# same site/sensor/tab restrictions as the aggregation itself, or it would offer
# measures that the real query cannot return a single point for.
params = {
	"start": date_from + " 00:00:00",
	# The whole of date_to is included. Compared against the column directly
	# rather than through DATE(timestamp), which is not sargable and would throw
	# away the timestamp index.
	"end": date_to + " 23:59:59",
}
where = ["timestamp >= %(start)s", "timestamp <= %(end)s", "value IS NOT NULL"]

if site:
	params["site"] = site
	where.append("site_name = %(site)s")
elif allowed is not None:
	where.append(in_clause("site_name", allowed, params, "site"))

gated = gated_sensor_names(tab_tag)
if gated:
	where.append(in_clause("sensor_name", gated, params, "tag"))

# Everything above scopes the *window*; the sensor filter is kept apart because
# the name list below must not be narrowed by it. Scoping the picker to the
# sensor already picked would leave no way to switch off it.
scope_where = [] + where

if sensor_name:
	params["sensor_name"] = sensor_name
	where.append("sensor_name = %(sensor_name)s")

# A gated tab with nothing tagged charts nothing — as distinct from an ungated
# tab, which charts everything.
blocked = gated is not None and not gated

# With no measures named, chart whatever the window actually contains. The
# Dashboard's single-day view relies on this: it asks for "everything this site
# reported", which is what the endpoint it replaced did.
if not blocked and not types:
	discovered = frappe.db.sql(
		"SELECT LOWER(sensor_type) AS measure FROM `tabSensor Reading` WHERE "
		+ " AND ".join(where + ["sensor_type IS NOT NULL", "sensor_type <> ''"])
		+ " GROUP BY measure ORDER BY measure",
		params,
		as_dict=True,
	)
	# Reported under the label Sensor Settings uses, so the app can look up a
	# unit for it and sort it into the canonical measure order. Title case is the
	# fallback for a type nobody has configured.
	configured = {}
	settings = frappe.get_cached_doc("Sensor Settings")
	for tr in settings.get("sensor_types") or []:
		label = frappe.utils.cstr(tr.get("sensor_type") or "").strip()
		if label:
			configured[label.lower()] = label
	for row in discovered:
		key = frappe.utils.cstr(row.get("measure") or "").strip()
		if not key:
			continue
		label = configured.get(key)
		if not label:
			label = " ".join([w.capitalize() for w in key.split(" ") if w])
		types.append(label)

if blocked or not types:
	frappe.response["message"] = {
		"interval": interval,
		"bucket_mins": bucket_mins,
		"date_from": date_from,
		"date_to": date_to,
		"series": [],
	}
else:
	# Sensor Reading stores the type lowercase; the app sends the Sensor Type
	# Setting label verbatim. Match on the lowered form and map back for output.
	label_by_key = {}
	lowered = []
	for label in types:
		key = label.lower()
		if key in label_by_key:
			continue
		label_by_key[key] = label
		lowered.append(key)
	where.append(in_clause("sensor_type", lowered, params, "type"))

	if bucket_mins > 0:
		params["bucket_secs"] = bucket_mins * 60
		bucket_expr = (
			"FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(timestamp) / %(bucket_secs)s) * %(bucket_secs)s)"
		)
	else:
		fmt = INTERVAL_FORMATS.get(interval)
		if not fmt:
			# weekly has no ISO-shaped DATE_FORMAT output, so it is served as
			# daily buckets and rolled up by the caller rather than returned
			# under a key the app cannot place on a time axis. The response says
			# which interval was actually used.
			interval = "daily"
			fmt = INTERVAL_FORMATS["daily"]
		params["fmt"] = fmt
		bucket_expr = "DATE_FORMAT(timestamp, %(fmt)s)"

	rows = frappe.db.sql(
		"SELECT "
		+ bucket_expr
		+ " AS bucket, LOWER(sensor_type) AS measure, "
		"AVG(value) AS avg_value, SUM(value) AS sum_value, COUNT(value) AS readings "
		"FROM `tabSensor Reading` WHERE "
		+ " AND ".join(where)
		+ " GROUP BY bucket, measure ORDER BY bucket ASC",
		params,
		as_dict=True,
	)

	by_measure = {}
	for row in rows:
		key = frappe.utils.cstr(row.get("measure") or "")
		if key not in by_measure:
			by_measure[key] = []
		agg = row.get("sum_value") if key in CUMULATIVE else row.get("avg_value")
		if agg is None:
			continue
		by_measure[key].append(
			[
				frappe.utils.cstr(row.get("bucket") or ""),
				frappe.utils.flt(agg, 2),
				frappe.utils.cint(row.get("readings")),
			]
		)

	series = []
	for key in lowered:
		points = by_measure.get(key) or []
		numbers = [p[1] for p in points]
		series.append(
			{
				"type": label_by_key.get(key, key),
				"key": key,
				"unit": DEFAULT_UNITS.get(key, ""),
				"cumulative": key in CUMULATIVE,
				# [bucket, value, reading_count] per point. Sparse: a bucket with
				# no reading is absent rather than zero, so the caller draws a
				# gap instead of a measured zero.
				"points": points,
				"min": min(numbers) if numbers else None,
				"max": max(numbers) if numbers else None,
			}
		)

	# The sensors that reported any of these measures in this window.
	#
	# Returned with the series so the caller's sensor picker costs nothing. It
	# could only be populated once the chart had loaded (the picker is scoped to
	# what is on the chart), which made it a second, *sequential* request — and a
	# round trip from a phone on mobile data costs far more than this GROUP BY.
	name_rows = frappe.db.sql(
		"SELECT sensor_name FROM `tabSensor Reading` WHERE "
		+ " AND ".join(scope_where + ["sensor_name IS NOT NULL", "sensor_name <> ''"])
		+ " GROUP BY sensor_name ORDER BY sensor_name",
		params,
		as_dict=True,
	)

	frappe.response["message"] = {
		"interval": interval,
		"bucket_mins": bucket_mins,
		"date_from": date_from,
		"date_to": date_to,
		"series": series,
		"sensor_names": [r.get("sensor_name") for r in name_rows if r.get("sensor_name")],
	}
