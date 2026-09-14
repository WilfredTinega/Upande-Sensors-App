# Server Script — script_type: API · api_method: upande_sensors_app.sensors_for_location · allow_guest: 0
#
# The sensors a phone may set coordinates on, with what each one already has.
#
# Feeds the "Set coordinates" picker: one row per Sensor at the selected site,
# saying whether it has a position, how sharp the last fix was and when it was
# taken — so the picker can read "set · ±4m · 2026-09-12" beside a sensor that
# is done and nothing beside one that is not, and an installer walking a site
# can see what is left without opening each one.
#
# Same response shape as `upande_sensors.api.mobile.sensors_for_location`:
#
#   {rows: [{name, sensor_name, sensor_site, sensor_type, monitoring,
#            latitude, longitude, location_accuracy_m, location_samples,
#            location_updated_on, location_updated_by, physical_location,
#            has_location}],
#    total}
#
# `has_location` is false for 0,0 as well as for NULL: 0,0 is the Gulf of
# Guinea, and it is what an untouched Float pair reads as, so it is treated as
# "never set" everywhere rather than drawn as a sensor at sea.
#
# The location_* columns and the Sensor Location History doctype are NEW
# in upande_sensors; a site whose app predates them lacks them. Every read is
# guarded by `has_field`, so on that site the row carries nulls for them rather
# than the request dying with a 500 over a column that is not there.
#
# Params: site (optional), search (optional)

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


allowed_sites = None if UNRESTRICTED else (scoped("Sensor Site") or None)

site = arg("site")
if site and allowed_sites is not None and site not in allowed_sites:
	frappe.throw("You do not have access to site " + site, frappe.PermissionError)

search = arg("search")

filters = sensor_scope_filters(site, allowed_sites)
or_filters = None
if search:
	# Bound through get_all, never spliced into SQL: a literal `%` in a query
	# string collides with the driver's own placeholders.
	or_filters = [
		["sensor_name", "like", "%" + search + "%"],
		# A partial DevEUI, not the whole one: the app method matches the
		# docname with LIKE too, and an installer types the last few characters
		# off the sticker rather than all sixteen.
		["name", "like", "%" + search + "%"],
	]

found = frappe.get_all(
	"Sensor",
	filters=filters,
	or_filters=or_filters,
	fields=sensor_fields(),
	order_by="sensor_name asc, name asc",
	limit_page_length=0,
)

rows = []
for row in found:
	if not row.get("sensor_name"):
		continue
	if not type_allowed(row):
		continue
	rows.append(location_row(row))

frappe.response["message"] = {"rows": rows, "total": len(rows)}
