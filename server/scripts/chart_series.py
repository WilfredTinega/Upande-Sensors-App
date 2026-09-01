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
	field = TAB_TAG_FIELDS.get(tab_tag)
	if not field:
		return None
	if not frappe.get_meta("Sensor").has_field(field):
		return None
	rows = frappe.get_all("Sensor", filters={field: 1}, fields=["sensor_name"], limit_page_length=0)
	return sorted(set([r.get("sensor_name") for r in rows if r.get("sensor_name")]))


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

gated = tab_sensor_names(tab_tag)
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
