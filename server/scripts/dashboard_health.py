# Server Script — script_type: API · api_method: upande_sensors_app.dashboard_health · allow_guest: 0
#
# Per-dashboard sensor counts for the app's Home screen tiles.
#
# One "<active> active · <stale> stale · <total>" line under each dashboard
# card, so the grid answers "where is something wrong" before anything is
# tapped. Every tab is counted in this one request: a call per tab against the
# cloud instance would be a second each, and there are a dozen tabs.
#
# ── Why this script exists at all ─────────────────────────────────────────────
#
# The feature was written as an app method only (upande_sensors.api.mobile.
# dashboard_health) and that method is not deployed to sensor.upande.com, so the
# client saw "Failed to get method for command", read it as isMissingEndpoint,
# and hid the counts — which is what the tiles look like today: no counts at
# all. This is the same endpoint as a Server Script, which the deploy script in
# this repo can push to the live site today, and it keeps the identical shape so
# the client cannot tell which of the two answered.
#
# ── How a tab's sensors are identified ────────────────────────────────────────
#
# Exactly as the dashboards do it, and in this order:
#
#  1. `Sensor.monitoring` — the Sensor Monitoring Type link, resolved by the
#     shared tab gate below (the same block sensor_names, live, chart_series and
#     readings carry, so a tile and the chart under it count the same sensors).
#     Cold room, cold chain and greenhouse sensors are DIFFERENT physical
#     devices, each declared once in the Sensor registry with its purpose, which
#     is what stops a cold chain probe being counted on the greenhouse tile.
#     Vehicle, Pump and Energy resolve the same way. The lookup is deliberately
#     NOT site-scoped: a reading's site_name and the registry's site can
#     disagree, and the purpose belongs to the sensor while the site filter
#     belongs to the readings. A monitoring tab that owns no sensor at this site
#     counts ZERO — "no cold chain here" is an answer, not a reason to fall
#     through to something wider.
#  2. The floor plan tab — its sensors are whatever has been placed on a Flow
#     Plan for the site, read from Flow Plan Sensor.
#  3. The tab's own enabled Sensor Type Setting rows, matched on sensor_type.
#
# A tab that matches none of the three reports ZEROS with scope "none". It must
# never fall back to the site-wide total: a Pump Control tab showing the whole
# site's 17 sensors is not a smaller truth, it is a different and wrong claim,
# and it is indistinguishable on the tile from a correct count.
#
# Params: site (optional), stale_minutes (optional)
# Returns: {stale_minutes, tabs: {<Sensor Setting row name>: {total, active,
#           stale, last_reading, scope}}, site: {total, active, stale,
#           last_reading}}
#
# The tabs map is keyed by the Sensor Setting CHILD ROW NAME, which is the same
# `name` the `config` endpoint gives each tab — the client looks its tile up by
# that and by nothing else.

SESSION_USER = frappe.session.user
UNRESTRICTED = SESSION_USER == "Administrator"

# Sensor Settings → Stale After, when the field is empty. Matches the client's
# own default, so a site that never configured it still agrees with the phone.
DEFAULT_STALE_AFTER_MINUTES = 120

# The tab the web renders as a blueprint instead of a chart.
FLOOR_PLAN_KEY = "floor-plan"


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


def named_params(prefix, values):
	"""{"keys": ["%(p0)s", ...], "params": {...}} for an IN clause.

	Named placeholders rather than a `%s` list built with the `%` operator: a
	literal `%` in the SQL collides with the driver's own parameter syntax and
	the statement dies before it runs. Returned as a dict because
	RestrictedPython has no `_unpack_sequence_` — `keys, params = ...` is a
	NameError at run time even though it compiles.
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


# ── Scope: sites, and the sensors this account may see ───────────────────────

allowed_sites = None if UNRESTRICTED else (scoped("Sensor Site") or None)

site = arg("site")
if site and allowed_sites is not None and site not in allowed_sites:
	frappe.throw("You do not have access to site " + site, frappe.PermissionError)

# A user granted particular Sensors (Sensor Settings → Grant Access) sees those
# and nothing else, whatever a tab would otherwise contain. No rows at all means
# no restriction — the same convention the dashboards use.
allowed_sensors = granted_sensor_names()

# The site clause every count shares, built once.
site_where = ["sensor_name IS NOT NULL", "sensor_name <> ''"]
site_params = {}
if site:
	site_params["site"] = site
	site_where.append("site_name = %(site)s")
elif allowed_sites is not None:
	picked = named_params("site", allowed_sites)
	site_params.update(picked["params"])
	site_where.append("site_name IN (" + ", ".join(picked["keys"]) + ")")

minutes = frappe.utils.cint(arg("stale_minutes")) or 0
if not minutes:
	settings = frappe.get_cached_doc("Sensor Settings")
	minutes = frappe.utils.cint(settings.get("app_stale_after_minutes")) or DEFAULT_STALE_AFTER_MINUTES

cutoff = frappe.utils.add_to_date(frappe.utils.now(), minutes=-minutes)
cutoff_str = frappe.utils.cstr(cutoff)[:19]

EMPTY = {"total": 0, "active": 0, "stale": 0, "last_reading": None}


def health(sensor_names, sensor_types):
	"""{total, active, stale, last_reading} for one scope.

	`sensor_names` None means no name restriction; an EMPTY list means the scope
	owns no sensors and counts zero — never the site's total. `sensor_types` is
	the same, by measure.

	One GROUP BY over the readings: a sensor is counted once, and it is active
	when its newest reading is inside the stale window. A sensor that has never
	reported is not counted at all — the scope comes from Sensor Reading, so
	there is nothing to call fresh or stale.
	"""
	if sensor_names is not None and not sensor_names:
		return EMPTY.copy()
	if sensor_types is not None and not sensor_types:
		return EMPTY.copy()

	where = []
	where.extend(site_where)
	params = {}
	params.update(site_params)

	if sensor_names is not None:
		picked = named_params("sn", sensor_names)
		params.update(picked["params"])
		where.append("sensor_name IN (" + ", ".join(picked["keys"]) + ")")
	if sensor_types is not None:
		picked = named_params("st", sensor_types)
		params.update(picked["params"])
		where.append("LOWER(sensor_type) IN (" + ", ".join(picked["keys"]) + ")")

	rows = frappe.db.sql(
		"SELECT sensor_name, MAX(timestamp) AS last_reading FROM `tabSensor Reading` "
		"WHERE " + " AND ".join(where) + " GROUP BY sensor_name",
		params,
		as_dict=True,
	)

	active = 0
	latest = None
	for row in rows:
		stamp = frappe.utils.cstr(row.get("last_reading") or "")[:19]
		if not stamp:
			continue
		if stamp >= cutoff_str:
			active = active + 1
		if latest is None or stamp > latest:
			latest = stamp

	return {
		"total": len(rows),
		"active": active,
		"stale": len(rows) - active,
		"last_reading": latest,
	}


# ── The sensors behind each kind of tab ──────────────────────────────────────

names_by_tab = {}


def gate_names_for(key, label):
	"""tab_sensor_names() from the shared gate, memoised for this request.

	Every tab asks the registry the same question, and a dozen tabs asking it a
	dozen times is a dozen scans. None still means "nothing identifies this
	tab"; the caller turns that into zeros rather than a site-wide count.
	"""
	cache_key = frappe.utils.cstr(key) + "|" + frappe.utils.cstr(label)
	if cache_key not in names_by_tab:
		names_by_tab[cache_key] = tab_sensor_names(key, label)
	return names_by_tab[cache_key]


floor_plan_names = None


def sensors_on_floor_plans():
	"""Sensor names placed on a Flow Plan for this site.

	The floor plan tab has no monitoring type and usually no configured sensor
	types — what it is about is whatever somebody pinned to the drawing, so that
	is what is counted. Site-less plans apply everywhere, as they do on the web.
	"""
	plan_filters = {}
	if site:
		plan_filters["sensor_site"] = ["in", [site, "", None]]
	elif allowed_sites is not None:
		wanted = []
		wanted.extend(allowed_sites)
		wanted.append("")
		plan_filters["sensor_site"] = ["in", wanted]
	plans = [
		r.get("name")
		for r in frappe.get_all("Flow Plan", filters=plan_filters, fields=["name"], limit_page_length=0)
	]
	if not plans:
		return []
	rows = frappe.get_all(
		"Flow Plan Sensor",
		filters={"parent": ["in", plans]},
		fields=["sensor_name"],
		limit_page_length=0,
	)
	return sorted(set([r.get("sensor_name") for r in rows if r.get("sensor_name")]))


def narrowed(names):
	"""Apply the account's own Sensor grants on top of a tab's sensor list."""
	if allowed_sensors is None:
		return names
	if names is None:
		return allowed_sensors
	mine = set(allowed_sensors)
	return [n for n in names if n in mine]


# ── Per tab ──────────────────────────────────────────────────────────────────

settings = frappe.get_cached_doc("Sensor Settings")

# Enabled sensor types grouped by the tab they are configured under.
# `parent_tab` is a comma-separated list, so one row can surface under several
# tabs (Temperature sits under Greenhouse, Cold Room and Cold Chain).
types_by_parent = {}
for tr in settings.get("sensor_types") or []:
	if not tr.get("enable"):
		continue
	label = frappe.utils.cstr(tr.get("sensor_type") or "").strip()
	if not label:
		continue
	for parent in frappe.utils.cstr(tr.get("parent_tab") or "").split(","):
		parent = parent.strip()
		if not parent:
			continue
		if parent not in types_by_parent:
			types_by_parent[parent] = []
		types_by_parent[parent].append(label.lower())

allowed_tabs = None
if not UNRESTRICTED:
	allowed_tabs = scoped("Sensor Setting") or None

tabs = {}
for row in settings.get("table_jpeo") or []:
	if not row.get("enable"):
		continue
	label = frappe.utils.cstr(row.get("tab") or "").strip()
	if not label:
		continue
	if allowed_tabs is not None and row.get("name") not in allowed_tabs:
		continue

	key = frappe.utils.cstr(row.get("key") or "").strip() or gate_slug(label) or "tab"
	tab_types = types_by_parent.get(row.get("name")) or types_by_parent.get(label) or []

	names = None
	scope = "none"
	if monitoring_for_tab(key, label):
		names = gate_names_for(key, label)
		# None = a monitoring tab on a site that can answer neither
		# Sensor.monitoring nor the retired track_* checkbox, so its sensors
		# cannot be identified here; it falls through to the branches below.
		# An EMPTY list is a different thing entirely — the tab is real and owns
		# no sensor at this site — and it counts zero, which is the answer a
		# site with no cold chain should get for its Cold Chain tile.
		if names is not None:
			scope = "monitoring"
	if scope == "none" and (key == FLOOR_PLAN_KEY or gate_slug(label) == FLOOR_PLAN_KEY):
		if floor_plan_names is None:
			floor_plan_names = sensors_on_floor_plans()
		names = floor_plan_names
		scope = "floor-plan"
	elif scope == "none" and tab_types:
		scope = "types"

	if scope == "none":
		# Nothing identifies this tab's sensors. Zeros, and the scope says why —
		# the alternative, the site-wide total, is a confident wrong answer.
		counts = EMPTY.copy()
	else:
		# Both gates where both apply: a cold room tab is its monitoring-tagged
		# sensors AND the measures it was configured for.
		counts = health(narrowed(names), tab_types or None)

	counts["scope"] = scope
	tabs[row.get("name")] = counts

site_counts = health(narrowed(None), None)

frappe.response["message"] = {
	"stale_minutes": minutes,
	"tabs": tabs,
	"site": site_counts,
}
