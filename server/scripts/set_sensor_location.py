# Server Script — script_type: API · api_method: upande_sensors_app.set_sensor_location · allow_guest: 0
#
# MUST be called with POST — a Server Script that writes over GET reports
# success and changes nothing, because Frappe rolls back the GET transaction.
#
# Writes a sensor's coordinates from a phone standing next to it.
#
# The phone has watched the GPS for up to thirty seconds, averaged the fixes
# (each weighted by 1/accuracy², so a sharp fix counts for more than a vague
# one) and sends the result: the averaged position, the weighted accuracy in
# metres and how many fixes went into it. This records all of that — not the
# position alone — because a coordinate without its accuracy is a claim with
# no error bar, and the map draws the error bar.
#
# Refused outright, with a sentence: 0,0 (the untouched-Float value, and a
# point in the Gulf of Guinea), a latitude outside ±90, a longitude outside
# ±180, and an account that is not a System Manager. The client is expected to
# hide the button from that account; this is the check that makes hiding it
# enough.
#
# Every previous position is kept in Sensor Location History where that
# doctype exists, with the position it replaced — so a sensor moved by mistake
# can be put back, and the desk can see who set what and from which phone. On
# a site without the doctype the coordinates are still written and
# `history_name` is null; the five optional location_* columns follow the same
# rule (see the shared block).
#
# Same response shape as `upande_sensors.api.mobile.set_sensor_location`: the
# updated `sensors_for_location` row, plus `history_name` and `previous`.
#
# Params: sensor (Sensor docname; a sensor_name is accepted), latitude,
#         longitude, accuracy_m (optional), samples (optional), device (optional)

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

if frappe.request and frappe.request.method != "POST":
	frappe.throw("Coordinates must be set with POST; a GET is rolled back.", frappe.PermissionError)

if not can_set_location():
	frappe.throw(
		"Setting sensor coordinates needs the System Manager role.",
		frappe.PermissionError,
	)

sensor = arg("sensor")
if not sensor:
	frappe.throw("Say which sensor the coordinates are for.")

# A docname first; failing that, the sensor_name the rest of the app deals in.
docname = sensor if frappe.db.exists("Sensor", sensor) else None
if not docname:
	matches = frappe.get_all(
		"Sensor", filters={"sensor_name": sensor}, fields=["name"], limit_page_length=2
	)
	if len(matches) == 1:
		docname = matches[0].get("name")
	elif len(matches) > 1:
		frappe.throw("More than one sensor is called " + sensor + "; pass the document name.")
if not docname:
	frappe.throw("No sensor called " + sensor + ".")

raw_lat = arg("latitude")
raw_lng = arg("longitude")
if not raw_lat or not raw_lng:
	frappe.throw("Both latitude and longitude are needed.")
latitude = frappe.utils.flt(raw_lat)
longitude = frappe.utils.flt(raw_lng)
if latitude == 0 and longitude == 0:
	frappe.throw("0, 0 is not a sensor position; the GPS gave no fix.")
if latitude < -90 or latitude > 90:
	frappe.throw("Latitude must be between -90 and 90.")
if longitude < -180 or longitude > 180:
	frappe.throw("Longitude must be between -180 and 180.")

accuracy_m = None
if arg("accuracy_m"):
	accuracy_m = frappe.utils.flt(arg("accuracy_m"))
	if accuracy_m < 0:
		frappe.throw("Accuracy cannot be negative.")
samples = frappe.utils.cint(arg("samples")) or None
device = arg("device")[:140]

# ── Scope ────────────────────────────────────────────────────────────────────

allowed_sites = None if UNRESTRICTED else (scoped("Sensor Site") or None)

before = frappe.get_all(
	"Sensor", filters={"name": docname}, fields=sensor_fields(), limit_page_length=1
)
if not before:
	frappe.throw("No sensor called " + sensor + ".")
before = before[0]

sensor_site = (before.get(SITE_FIELD) if SITE_FIELD else "") or ""
if allowed_sites is not None and sensor_site and sensor_site not in allowed_sites:
	frappe.throw("You do not have access to site " + sensor_site, frappe.PermissionError)
if not UNRESTRICTED:
	granted = scoped("Sensor")
	if granted and docname not in granted:
		frappe.throw("You do not have access to sensor " + sensor, frappe.PermissionError)

previous = None
if has_coords(before.get("latitude"), before.get("longitude")):
	previous = {
		"latitude": frappe.utils.flt(before.get("latitude")),
		"longitude": frappe.utils.flt(before.get("longitude")),
	}

# ── Write ────────────────────────────────────────────────────────────────────

now_str = frappe.utils.now()

values = {"latitude": latitude, "longitude": longitude}
# Only the columns this site has: writing to one it lacks is a 500, and the
# coordinates themselves matter more than their provenance.
if SENSOR_META.has_field("location_accuracy_m"):
	values["location_accuracy_m"] = accuracy_m
if SENSOR_META.has_field("location_samples"):
	values["location_samples"] = samples
if SENSOR_META.has_field("location_updated_on"):
	values["location_updated_on"] = now_str
if SENSOR_META.has_field("location_updated_by"):
	values["location_updated_by"] = SESSION_USER
if SENSOR_META.has_field("location_source"):
	values["location_source"] = "Mobile GPS"

# db.set_value rather than a document save: the Sensor controller's own
# validation is about commissioning (dev EUI, application key), none of which
# a coordinate changes, and a save would refuse a legacy row that fails a rule
# added since it was created — leaving the installer unable to place it.
frappe.db.set_value("Sensor", docname, values, update_modified=True)

history_name = None
if frappe.db.exists("DocType", HISTORY_DOCTYPE):
	hmeta = frappe.get_meta(HISTORY_DOCTYPE)
	wanted = {
		"sensor": docname,
		"sensor_name": before.get("sensor_name") or docname,
		"sensor_site": sensor_site,
		"latitude": latitude,
		"longitude": longitude,
		"accuracy_m": accuracy_m,
		"samples": samples,
		"source": "Mobile GPS",
		"device": device or None,
		"user": SESSION_USER,
		"recorded_at": now_str,
		"previous_latitude": previous["latitude"] if previous else None,
		"previous_longitude": previous["longitude"] if previous else None,
	}
	entry = {"doctype": HISTORY_DOCTYPE}
	for key in wanted:
		if hmeta.has_field(key):
			entry[key] = wanted[key]
	# The link to the sensor is the one field the row is useless without.
	if hmeta.has_field("sensor"):
		history = frappe.get_doc(entry)
		history.insert(ignore_permissions=True)
		history_name = history.name

after = frappe.get_all(
	"Sensor", filters={"name": docname}, fields=sensor_fields(), limit_page_length=1
)[0]

out = location_row(after)
out["history_name"] = history_name
out["previous"] = previous
frappe.response["message"] = out
