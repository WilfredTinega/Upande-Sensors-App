# Server Script — script_type: API · api_method: upande_sensors_app.sensor_names · allow_guest: 0
#
# Sensor names for a site, for the dashboard and chart filters.
#
# Replaces both upande_sensors.api.get_sensor_names (registry + reporting, all
# types) and upande_sensors.api.sensor_charts.get_sensor_names (reporting only,
# one type) — pass `sensor_type` to get the second behaviour.
#
# Params: site, sensor_type (optional), tab_tag (optional), since_days (optional)

SESSION_USER = frappe.session.user
UNRESTRICTED = SESSION_USER == "Administrator"

# tab_tag as sent by the app -> the Sensor checkbox that tags a sensor for that
# tab. These MUST be real Sensor fieldnames: a bare "cold_room" only ever existed
# as an orphan column on one dev site, and asking for it elsewhere raises
# "Unknown column" — a 500 that reaches the app as an empty chart.
TAB_TAG_FIELDS = {
	"cold_room": "track_in_cold_room",
	"cold_chain": "track_in_cold_chain",
	"greenhouse": "track_greenhouse",
	"pumps_energy": "track_in_pumps_energy",
	"vehicle": "track_vehicle",
}


def arg(key, default=""):
	val = frappe.form_dict.get(key)
	if val is None:
		return default
	val = frappe.utils.cstr(val).strip()
	return val or default


def scoped_sites():
	"""Sites this account is limited to, or None when unlimited.

	An account with no Sensor Site User Permission sees every site — only a
	non-empty permission set restricts.
	"""
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


def tab_sensor_names(tab_tag):
	"""Sensors belonging to a tagged tab. None = ungated, [] = gated but empty.

	Deliberately not scoped by site: a reading's site_name and the registry's
	sensor_site can disagree (Kaptumbo Cold Room reads under Karen Roses but is
	registered at Lokitela Orchards), and a site-scoped lookup drops those
	sensors out of their own tab. The tag belongs to the sensor; the site filter
	still applies to the readings.
	"""
	field = TAB_TAG_FIELDS.get(tab_tag)
	if not field:
		return None
	# Asking for a track_* column the Sensor doctype does not carry on this
	# instance would be a 500. Treat a missing column as "tab not gated here".
	if not frappe.get_meta("Sensor").has_field(field):
		return None
	rows = frappe.get_all("Sensor", filters={field: 1}, fields=["sensor_name"], limit_page_length=0)
	return sorted(set([r.get("sensor_name") for r in rows if r.get("sensor_name")]))


site = arg("site")
sensor_type = arg("sensor_type")
tab_tag = arg("tab_tag")
since_days = frappe.utils.cint(arg("since_days", "0"))

allowed = scoped_sites()
if site and allowed is not None and site not in allowed:
	frappe.throw("You do not have access to site " + site, frappe.PermissionError)

gated = tab_sensor_names(tab_tag)
if gated is not None and not gated:
	frappe.response["message"] = []
else:
	params = {}
	where = ["sensor_name IS NOT NULL", "sensor_name <> ''"]

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

	if gated:
		keys = []
		for idx, name in enumerate(gated):
			key = "tag" + str(idx)
			params[key] = name
			keys.append("%(" + key + ")s")
		where.append("sensor_name IN (" + ", ".join(keys) + ")")

	if sensor_type:
		# Sensor Reading stores the type lowercase (see ingest and climate.py)
		# while the app passes the Sensor Type Setting label verbatim
		# ("Temperature", "EC", "pH"). Normalise, or a case-sensitive collation
		# matches nothing and the filter renders empty.
		params["sensor_type"] = sensor_type.lower()
		where.append("sensor_type = %(sensor_type)s")

	if since_days > 0:
		params["since"] = frappe.utils.add_days(frappe.utils.today(), -since_days) + " 00:00:00"
		where.append("timestamp >= %(since)s")

	# GROUP BY, not DISTINCT on a select that also carries `name`: the PK defeats
	# DISTINCT and returns one row per reading — tens of thousands — which hung
	# the app. Grouping on sensor_name uses the sensor_type/timestamp index.
	reporting = frappe.db.sql(
		"SELECT sensor_name FROM `tabSensor Reading` WHERE "
		+ " AND ".join(where)
		+ " GROUP BY sensor_name ORDER BY sensor_name",
		params,
		as_dict=True,
	)
	names = [r.get("sensor_name") for r in reporting if r.get("sensor_name")]

	# With no type asked for, union in the deployed-sensor registry so a
	# freshly-commissioned site lists its sensors before any reading arrives.
	# Filtering by type is readings-only on purpose: the registry records one
	# type per node, so a node reporting three measures would be offered under
	# only one of them.
	if not sensor_type:
		reg_filters = {}
		if site:
			reg_filters["sensor_site"] = site
		elif allowed is not None:
			reg_filters["sensor_site"] = ["in", allowed]
		if frappe.get_meta("Sensor").has_field("sensor_site"):
			for row in frappe.get_all(
				"Sensor",
				filters=reg_filters,
				fields=["sensor_name"],
				order_by="sensor_name asc",
				limit_page_length=0,
			):
				nm = row.get("sensor_name")
				if nm and (gated is None or nm in gated):
					names.append(nm)

	seen = {}
	for nm in names:
		seen[nm.lower()] = nm
	frappe.response["message"] = [seen[k] for k in sorted(seen.keys())]
