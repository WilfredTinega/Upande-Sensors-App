# Server Script — script_type: API · api_method: upande_sensors_app.live · allow_guest: 0
#
# A site's sensors and their latest value per measure, in ONE request.
#
# Replaces the pair get_site_sensors + get_live_readings, which the app had to
# call in sequence (the second needs the names from the first) — two round trips
# of about a second each before the Live screen could paint.
#
# It also replaces get_live_readings' query plan. That ran one DISTINCT query per
# sensor plus one ORDER BY ... LIMIT 1 per (sensor, measure): about 40 queries
# for a 12-sensor site, and measured 25.7s against sensor.upande.com. Here it is
# one grouped scan.
#
# ── Why the window is short ───────────────────────────────────────────────────
#
# `tabSensor Reading` is indexed on `timestamp`, on `site_name`, and on the
# composites (sensor_type, timestamp) and (site_name, sensor_type, sensor_name).
# There is NO index leading with sensor_name or with (site_name, timestamp), so
# how this query performs is decided entirely by how many rows the window lets
# through: a narrow window is served from the timestamp index, a wide one
# degrades into a site-wide scan of ~216k rows.
#
# Measured on sensor.upande.com, Red Lands Roses:
#
#     since_days=3     0.65s      16 sensors
#     since_days=30    1.43s      17 sensors
#     since_days=180   2.21s      19 sensors
#
# The default was 180 days, and the three extra sensors it bought for that 1.5s
# were `GH 11 and 12` and `GH 13 and 14` — renamed long ago to `GH 12` and
# `GH 14`, so they are the same hardware listed twice — plus `GH Fox`, silent
# for months. A Live screen is worse for showing those, not better.
#
# So the window is short by default. Sensors that are commissioned but quiet
# belong in the `Sensor` registry, which is read separately and unbounded; a
# site with an empty registry (as Red Lands Roses has) gets exactly the sensors
# that are actually reporting.
#
# Params: site, since_days (optional, default 3), max_since_days (optional),
#         tab_tag (optional)
#
# `tab_tag` narrows the answer to one dashboard tab's sensors, by the rule every
# other endpoint here uses (Sensor.monitoring, resolved from the tab slug the
# app sends or the website's short tag). Without it the answer is the whole
# site, which is what the Dashboard screen asks for. A tab that resolves to a
# monitoring type no sensor at this site carries lists NOTHING.

SESSION_USER = frappe.session.user
UNRESTRICTED = SESSION_USER == "Administrator"

DEFAULT_SINCE_DAYS = 3

# Used only when the short window finds nothing at all — a site whose gateway
# has been down for a week should still list its sensors rather than reading as
# though it had none. It costs the wide scan, but only in the case where the
# screen would otherwise be blank.
FALLBACK_SINCE_DAYS = 400


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
tab_tag = arg("tab_tag")
since_days = frappe.utils.cint(arg("since_days", str(DEFAULT_SINCE_DAYS))) or DEFAULT_SINCE_DAYS
max_since_days = (
	frappe.utils.cint(arg("max_since_days", str(FALLBACK_SINCE_DAYS))) or FALLBACK_SINCE_DAYS
)

allowed = scoped_sites()
if site and allowed is not None and site not in allowed:
	frappe.throw("You do not have access to site " + site, frappe.PermissionError)

# A handful of rows carry implausible future timestamps (one reads 2080).
# Without this cap they win every "latest value" and the screen reports a
# reading that has not happened.
now_str = frappe.utils.now()

site_where = ["sensor_name IS NOT NULL", "sensor_name <> ''"]
site_params = {}
if site:
	site_params["site"] = site
	site_where.append("site_name = %(site)s")
elif allowed is not None:
	keys = []
	for idx, name in enumerate(allowed):
		key = "site" + str(idx)
		site_params[key] = name
		keys.append("%(" + key + ")s")
	site_where.append("site_name IN (" + ", ".join(keys) + ")")

# The tab's sensors, narrowed by this account's own Sensor grants. `blocked` is
# the gated-but-empty case: the tab owns no sensor here, so the screen lists
# none — running the query would answer with the whole site instead.
gated = gated_sensor_names(tab_tag)
blocked = gated is not None and not gated
if gated:
	keys = []
	for idx, name in enumerate(gated):
		key = "tag" + str(idx)
		site_params[key] = name
		keys.append("%(" + key + ")s")
	site_where.append("sensor_name IN (" + ", ".join(keys) + ")")


def latest_in_window(days):
	"""Newest value per (sensor, measure) inside the last `days` days.

	SUBSTRING_INDEX(GROUP_CONCAT(... ORDER BY timestamp DESC), ',', 1) picks the
	newest value inside each group without a correlated subquery.
	GROUP_CONCAT truncates at group_concat_max_len, but only ever at the tail —
	the newest value is the first element, so a long group is harmless.
	"""
	qparams = {}
	qparams.update(site_params)
	qparams["since"] = frappe.utils.add_days(frappe.utils.today(), -days) + " 00:00:00"
	qparams["until"] = now_str
	found = frappe.db.sql(
		"""
		SELECT sensor_name,
		       COALESCE(sensor_type, '') AS sensor_type,
		       MAX(timestamp) AS ts,
		       MAX(site_name) AS site_name,
		       SUBSTRING_INDEX(GROUP_CONCAT(value ORDER BY timestamp DESC), ',', 1) AS latest_value
		FROM `tabSensor Reading`
		WHERE """
		+ " AND ".join(site_where + ["timestamp >= %(since)s", "timestamp <= %(until)s"])
		+ """
		GROUP BY sensor_name, COALESCE(sensor_type, '')
		ORDER BY sensor_name
		""",
		qparams,
		as_dict=True,
	)
	# Returned as a dict, not a tuple: RestrictedPython provides
	# `_iter_unpack_sequence_` for `for` loops but no `_unpack_sequence_`, so
	# `rows, since = latest_in_window(...)` is a NameError at run time.
	return {"rows": found, "since": qparams.get("since")}


answer = {"rows": [], "since": None}
widened = False
if not blocked:
	answer = latest_in_window(since_days)
	if not answer.get("rows") and max_since_days > since_days:
		answer = latest_in_window(max_since_days)
		widened = True

rows = answer.get("rows") or []
window_since = answer.get("since")

# Live Sensor Data is the preferred source where it exists: it carries the unit
# and the alarm thresholds, which Sensor Reading does not. Its rows have no
# sensor_type, so each one is its own unnamed measure.
live_filters = {}
if site:
	live_filters["name"] = site
elif allowed is not None:
	live_filters["name"] = ["in", allowed]

live_parents = []
if not blocked:
	live_parents = [
		r.get("name")
		for r in frappe.get_all(
			"Live Sensor Data", filters=live_filters, fields=["name"], limit_page_length=200
		)
	]

live_items = []
if live_parents:
	keys = []
	lparams = {}
	for idx, name in enumerate(live_parents):
		key = "parent" + str(idx)
		lparams[key] = name
		keys.append("%(" + key + ")s")
	live_items = frappe.db.sql(
		"SELECT sensor_name, current_reading, uom, submission_timestamp, utr, ltr "
		"FROM `tabLive Sensor Data Item` WHERE parent IN (" + ", ".join(keys) + ")",
		lparams,
		as_dict=True,
	)

uom_by_name = {}
values = {}

for item in live_items:
	nm = item.get("sensor_name")
	if not nm:
		continue
	# Live Sensor Data is keyed by site, not by tab, so the gate applies here too.
	if gated is not None and nm not in gated:
		continue
	if item.get("uom"):
		uom_by_name[nm] = item.get("uom")
	if nm not in values:
		values[nm] = {}
	# Keyed by "" — a live row names no measure, so it is the sensor's primary.
	values[nm][""] = {
		"type": "",
		"value": item.get("current_reading"),
		"uom": item.get("uom") or "",
		"ts": frappe.utils.cstr(item.get("submission_timestamp") or ""),
		"utr": item.get("utr"),
		"ltr": item.get("ltr"),
	}

sensors = {}
for row in rows:
	nm = row.get("sensor_name")
	if not nm:
		continue
	measure = row.get("sensor_type") or ""
	if nm not in sensors:
		sensors[nm] = {
			"sensor_name": nm,
			"sensor_type": measure,
			"site_name": row.get("site_name") or "",
			"uom": uom_by_name.get(nm, ""),
		}
	if nm not in values:
		values[nm] = {}
	# Only fall back to a raw reading for a sensor Live Sensor Data did not
	# already answer for — a live row is fresher and carries thresholds.
	if "" in values[nm]:
		continue
	values[nm][measure] = {
		"type": measure,
		"value": frappe.utils.flt(row.get("latest_value")) if row.get("latest_value") is not None else None,
		"uom": uom_by_name.get(nm, ""),
		"ts": frappe.utils.cstr(row.get("ts") or ""),
		"utr": None,
		"ltr": None,
	}

# Registered-but-not-yet-reporting sensors, so a commissioned site lists its
# hardware before the first reading arrives.
reg_filters = {}
if site:
	reg_filters["sensor_site"] = site
elif allowed is not None:
	reg_filters["sensor_site"] = ["in", allowed]
if not blocked and frappe.get_meta("Sensor").has_field("sensor_site"):
	for row in frappe.get_all(
		"Sensor",
		filters=reg_filters,
		fields=["sensor_name", "sensor_type", "sensor_site"],
		order_by="sensor_name asc",
		limit_page_length=0,
	):
		nm = row.get("sensor_name")
		if not nm or nm in sensors:
			continue
		if gated is not None and nm not in gated:
			continue
		sensors[nm] = {
			"sensor_name": nm,
			"sensor_type": frappe.utils.cstr(row.get("sensor_type") or "").lower(),
			"site_name": row.get("sensor_site") or "",
			"uom": uom_by_name.get(nm, ""),
		}

out_values = {}
for nm in sensors:
	measures = [m for m in (values.get(nm) or {}).values()]
	if not measures:
		out_values[nm] = None
		continue
	primary = measures[0]
	out_values[nm] = {
		# The top-level fields mirror the first measure, which is what the
		# existing screens read when a sensor reports a single parameter.
		"value": primary.get("value"),
		"uom": primary.get("uom"),
		"ts": primary.get("ts"),
		"utr": primary.get("utr"),
		"ltr": primary.get("ltr"),
		"params": measures,
	}

ordered = [sensors[k] for k in sorted(sensors.keys(), key=lambda s: s.lower())]

frappe.response["message"] = {
	"site": site,
	"sensors": ordered,
	"values": out_values,
	# Reported so a caller can tell "this sensor is silent" from "this sensor is
	# outside the window I was asked about".
	"since": window_since,
	"since_days": max_since_days if widened else since_days,
	"widened": widened,
	"server_time": now_str,
}
