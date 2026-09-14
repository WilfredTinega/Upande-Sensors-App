# Server Script — script_type: API · api_method: upande_sensors_app.sensor_location_history · allow_guest: 0
#
# Every position one sensor has been given, newest first.
#
# `set_sensor_location` writes a Sensor Location History row for each save,
# carrying the position it replaced — so the phone can show "moved 12 m from
# the last fix" under the current coordinates, and a sensor placed wrongly can
# be put back by reading the row before.
#
# Same response shape as `upande_sensors.api.mobile.sensor_location_history`:
#
#   {sensor, sensor_name,
#    rows: [{name, latitude, longitude, accuracy_m, samples, source, device,
#            user, recorded_at, previous_latitude, previous_longitude}],
#    total, start, page_length, supported}
#
# `supported` is false on a site whose upande_sensors predates the doctype:
# there is no history there, and the rows are empty because none was ever
# written, not because the sensor was never placed. The client reads the flag
# and leaves the section out rather than saying "no history".
#
# Params: sensor (Sensor docname; a sensor_name is accepted), start (optional),
#         page_length (optional, default 50, max 200)

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
	# The reverse-geocoded place name. Read here so the app can show it; this
	# script cannot WRITE it the way the app method does (naming a place needs
	# upande_sensors.api.places, which the Server Script sandbox cannot import),
	# so on a site running the scripts it stays whatever the Desk form or the
	# migrate backfill last resolved.
	"physical_location",
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
		"physical_location": (row.get("physical_location") or None)
		if SENSOR_META.has_field("physical_location")
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


# Sensor Types this account is scoped to, lowercased; empty means unscoped.
# Only a non-empty grant restricts — the same convention as the Sensor grants
# above, and the same one `upande_sensors.api.permitted_types` follows.
ALLOWED_TYPES = []
if not UNRESTRICTED:
	for granted_type in scoped("Sensor Type"):
		ALLOWED_TYPES.append(frappe.utils.cstr(granted_type).strip().lower())


def type_allowed(row):
	"""May this account see the sensor's registered type?

	An account scoped to Temperature is shown Temperature everywhere in the
	app — every chart, list and map — so the coordinates picker and the map
	must not be the one place a Pressure sensor still appears. A sensor with
	no type at all is nobody's to hide and always passes.
	"""
	if not ALLOWED_TYPES:
		return True
	label = frappe.utils.cstr(row.get("sensor_type") or "").strip().lower()
	return not label or label in ALLOWED_TYPES


# ── end of the shared location block ─────────────────────────────────────────

sensor = arg("sensor")
if not sensor:
	frappe.throw("Say which sensor the history is for.")

docname = sensor if frappe.db.exists("Sensor", sensor) else None
if not docname:
	matches = frappe.get_all(
		"Sensor", filters={"sensor_name": sensor}, fields=["name"], limit_page_length=2
	)
	if len(matches) == 1:
		docname = matches[0].get("name")
if not docname:
	frappe.throw("No sensor called " + sensor + ".")

start = frappe.utils.cint(arg("start")) or 0
# The app method's DEFAULT_LOCATION_HISTORY_PAGE_LENGTH / MAX_…, so an
# unpaged call returns the same run of rows whichever layer answers it.
page_length = frappe.utils.cint(arg("page_length", "50")) or 50
if page_length > 200:
	page_length = 200

# ── Scope: the sensor's site, and this account's grants ──────────────────────

allowed_sites = None if UNRESTRICTED else (scoped("Sensor Site") or None)

current = frappe.get_all(
	"Sensor", filters={"name": docname}, fields=sensor_fields(), limit_page_length=1
)
if not current:
	frappe.throw("No sensor called " + sensor + ".")
current = current[0]

sensor_site = (current.get(SITE_FIELD) if SITE_FIELD else "") or ""
if allowed_sites is not None and sensor_site and sensor_site not in allowed_sites:
	frappe.throw("You do not have access to site " + sensor_site, frappe.PermissionError)
if not UNRESTRICTED:
	granted = scoped("Sensor")
	if granted and docname not in granted:
		frappe.throw("You do not have access to sensor " + sensor, frappe.PermissionError)

out = {
	"sensor": docname,
	"sensor_name": current.get("sensor_name") or docname,
	"rows": [],
	"total": 0,
	"start": start,
	"page_length": page_length,
	"supported": False,
}

if frappe.db.exists("DocType", HISTORY_DOCTYPE):
	hmeta = frappe.get_meta(HISTORY_DOCTYPE)
	if hmeta.has_field("sensor"):
		out["supported"] = True
		# Only the columns this site's doctype has; the response still carries
		# every key, as null, so the client reads one shape.
		wanted = [
			"latitude",
			"longitude",
			"accuracy_m",
			"samples",
			"source",
			"device",
			"user",
			"recorded_at",
			"previous_latitude",
			"previous_longitude",
		]
		fields = ["name", "owner", "creation"]
		for field in wanted:
			if hmeta.has_field(field):
				fields.append(field)
		order_by = "recorded_at desc, creation desc" if hmeta.has_field("recorded_at") else "creation desc"
		found = frappe.get_all(
			HISTORY_DOCTYPE,
			filters={"sensor": docname},
			fields=fields,
			order_by=order_by,
			limit_start=start,
			limit_page_length=page_length,
		)
		for row in found:
			# `user` falls back to the row's owner: the account that inserted
			# it IS who set the position, on a doctype without a user column.
			out["rows"].append(
				{
					"name": row.get("name"),
					"latitude": frappe.utils.flt(row.get("latitude"))
					if row.get("latitude") is not None
					else None,
					"longitude": frappe.utils.flt(row.get("longitude"))
					if row.get("longitude") is not None
					else None,
					"accuracy_m": frappe.utils.flt(row.get("accuracy_m"))
					if row.get("accuracy_m") is not None
					else None,
					"samples": frappe.utils.cint(row.get("samples"))
					if row.get("samples") is not None
					else None,
					"source": row.get("source") or "",
					"device": row.get("device") or "",
					"user": row.get("user") or row.get("owner") or "",
					"recorded_at": frappe.utils.cstr(row.get("recorded_at") or row.get("creation") or "")[:19]
					or None,
					"previous_latitude": frappe.utils.flt(row.get("previous_latitude"))
					if row.get("previous_latitude") is not None
					else None,
					"previous_longitude": frappe.utils.flt(row.get("previous_longitude"))
					if row.get("previous_longitude") is not None
					else None,
				}
			)
		out["total"] = frappe.db.count(HISTORY_DOCTYPE, {"sensor": docname})

frappe.response["message"] = out
