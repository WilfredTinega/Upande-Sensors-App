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
# Params: site, since_days (optional, default 3), max_since_days (optional)

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


site = arg("site")
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


answer = latest_in_window(since_days)
widened = False
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

live_parents = [
	r.get("name")
	for r in frappe.get_all("Live Sensor Data", filters=live_filters, fields=["name"], limit_page_length=200)
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
if frappe.get_meta("Sensor").has_field("sensor_site"):
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
