# Server Script — script_type: API · api_method: upande_sensors_app.readings · allow_guest: 0
#
# A page of raw Sensor Reading rows plus the total, in one request.
#
# The app read these through frappe.client.get_list, which enforces doctype
# permissions — and Sensor Reading grants read to System Manager and Water
# Operator ONLY. Every other account got a permission error where the rest of
# the app worked, because the dashboards go through whitelisted methods that do
# their own site scoping. This endpoint applies that same site scoping
# (Sensor Site User Permissions) instead, so the history screen is available to
# exactly the accounts that can already see the site's live values.
#
# It also folds in the count the screen used to fetch separately, so paging is
# one request rather than two.
#
# Params: site, date_from, date_to, sensor_type, sensor_name, tab_tag,
#         start, page_length (max 500), order (desc|asc), with_total (0|1)
#
# `tab_tag` scopes the table to the dashboard the reader is standing on, the
# same way the charts are scoped — accepted either as the slug the app sends
# ("cold-chain-monitoring") or as the website's short tag ("cold_chain"), and
# resolved through Sensor.monitoring by the shared tab gate below. A tab that
# resolves to a monitoring type no sensor at this site carries lists NOTHING;
# the table must not answer a cold chain question with the whole site.

SESSION_USER = frappe.session.user
UNRESTRICTED = SESSION_USER == "Administrator"

MAX_PAGE_LENGTH = 500


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
date_from = arg("date_from")
date_to = arg("date_to")
sensor_type = arg("sensor_type")
sensor_name = arg("sensor_name")
tab_tag = arg("tab_tag")
start = frappe.utils.cint(arg("start", "0"))
page_length = frappe.utils.cint(arg("page_length", "50")) or 50
order = "ASC" if arg("order", "desc").lower() == "asc" else "DESC"
with_total = frappe.utils.cint(arg("with_total", "1"))

if start < 0:
	start = 0
if page_length > MAX_PAGE_LENGTH:
	page_length = MAX_PAGE_LENGTH

allowed = scoped_sites()
if site and allowed is not None and site not in allowed:
	frappe.throw("You do not have access to site " + site, frappe.PermissionError)

params = {"start": start, "page_length": page_length}
where = []

if site:
	params["site"] = site
	where.append("site_name = %(site)s")
elif allowed is not None:
	keys = []
	for idx, name in enumerate(allowed):
		key = "site" + str(idx)
		params[key] = name
		keys.append("%(" + key + ")s")
	where.append("site_name IN (" + ", ".join(keys) + ")")

# The tab's sensors, narrowed by this account's own Sensor grants. A gate that
# resolved to a monitoring type and found nothing becomes an explicit "1 = 0",
# so the page is empty and the total is 0 rather than the whole site's table —
# `IN ()` is a syntax error, which is why mobile.py's _in_clause spells the same
# case out the same way.
gated = gated_sensor_names(tab_tag)
if gated is not None and not gated:
	where.append("1 = 0")
elif gated:
	keys = []
	for idx, name in enumerate(gated):
		key = "tag" + str(idx)
		params[key] = name
		keys.append("%(" + key + ")s")
	where.append("sensor_name IN (" + ", ".join(keys) + ")")

if date_from:
	params["from_ts"] = date_from + " 00:00:00"
	where.append("timestamp >= %(from_ts)s")
if date_to:
	params["to_ts"] = date_to + " 23:59:59"
	where.append("timestamp <= %(to_ts)s")
if sensor_type:
	# Stored lowercase; the app sends the Sensor Type Setting label verbatim.
	params["sensor_type"] = sensor_type.lower()
	where.append("sensor_type = %(sensor_type)s")
if sensor_name:
	params["sensor_name"] = sensor_name
	where.append("sensor_name = %(sensor_name)s")

clause = " AND ".join(where) if where else "1 = 1"

rows = frappe.db.sql(
	"SELECT name, timestamp, sensor_name, COALESCE(sensor_type, '') AS sensor_type, "
	"value, site_name, deveui, battery, rssi "
	"FROM `tabSensor Reading` WHERE "
	+ clause
	+ " ORDER BY timestamp "
	+ order
	+ ", name "
	+ order
	+ " LIMIT %(page_length)s OFFSET %(start)s",
	params,
	as_dict=True,
)

out = []
for row in rows:
	out.append(
		{
			"name": row.get("name"),
			"timestamp": frappe.utils.cstr(row.get("timestamp") or ""),
			"sensor_name": row.get("sensor_name") or "",
			"sensor_type": row.get("sensor_type") or "",
			"value": row.get("value"),
			"site_name": row.get("site_name") or "",
			"deveui": row.get("deveui") or "",
			"battery": row.get("battery"),
			"rssi": row.get("rssi"),
		}
	)

total = None
if with_total:
	# Counted with the same clause so the "x-y of N" footer and the last-page
	# bound can never disagree with the rows above them.
	counted = frappe.db.sql(
		"SELECT COUNT(*) AS total FROM `tabSensor Reading` WHERE " + clause, params, as_dict=True
	)
	total = frappe.utils.cint(counted[0].get("total")) if counted else 0

frappe.response["message"] = {
	"rows": out,
	"total": total,
	"start": start,
	"page_length": page_length,
	"order": order.lower(),
}
