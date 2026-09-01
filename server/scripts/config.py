# Server Script — script_type: API · api_method: upande_sensors_app.config · allow_guest: 0
#
# Dashboard shape for the app: title, tabs, the sensor types under each tab, the
# sites the account may see, and the display unit per type.
#
# Consolidates three calls (get_dashboard_config, get_user_sites,
# get_sensor_type_options) which all read the same cached Sensor Settings single
# doc, so asking separately paid for the same document three times.
#
# Reads Sensor Settings directly rather than through the upande_sensors app, so
# the app keeps working on an instance where that app is absent or older than
# the client.

SESSION_USER = frappe.session.user
UNRESTRICTED = SESSION_USER == "Administrator"

DEFAULT_TITLE = "Upande Sensors"

# Fallback display units per sensor type. A Sensor Type Setting row may name its
# own unit; most sites never fill that in, which leaves every series unitless —
# and unitless series share one y-axis, flattening a cold room's 4-8 degC against
# a 70-92 % humidity line on a single 0-100 scale.
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


def slugify(label):
	"""Lowercase, non-alphanumerics collapsed to single dashes.

	Hand-rolled because the sandbox has no `re`; the output must match
	upande_sensors' own slugs, which the app uses as route keys.
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
	slug = "".join(out).strip("-")
	return slug or "tab"


def unit_for(sensor_type, configured):
	if configured and frappe.utils.cstr(configured).strip():
		return frappe.utils.cstr(configured).strip()
	return DEFAULT_UNITS.get(frappe.utils.cstr(sensor_type or "").strip().lower(), "")


def scoped(allow):
	rows = frappe.get_all(
		"User Permission",
		filters={"user": SESSION_USER, "allow": allow},
		fields=["for_value"],
		limit_page_length=0,
	)
	return sorted(set([r.get("for_value") for r in rows if r.get("for_value")]))


settings = frappe.get_cached_doc("Sensor Settings")

# An empty set means nobody scoped this user to particular tabs, so they see them
# all. Only a non-empty set actually restricts.
allowed_tabs = None
if not UNRESTRICTED:
	allowed_tabs = scoped("Sensor Setting") or None

# Group enabled sensor types by parent tab. `parent_tab` is a comma-separated
# list so one Sensor Type Setting row can surface under several tabs (Temperature
# appears under "Temperature and Humidity", "Cold Room" and "Cold Chain").
types_by_parent = {}
type_labels = []
units = {}
for tr in settings.get("sensor_types") or []:
	if not tr.get("enable"):
		continue
	label = frappe.utils.cstr(tr.get("sensor_type") or "").strip()
	if not label:
		continue
	resolved = unit_for(label, tr.get("unit"))
	type_labels.append(label)
	units[label.lower()] = resolved
	parents = frappe.utils.cstr(tr.get("parent_tab") or "").strip()
	if not parents:
		continue
	for parent in parents.split(","):
		parent = parent.strip()
		if not parent:
			continue
		if parent not in types_by_parent:
			types_by_parent[parent] = []
		types_by_parent[parent].append(
			{
				"label": label,
				"slug": slugify(label),
				"chart_type": tr.get("chart_type") or "Line",
				"unit": resolved or None,
			}
		)

tabs = []
for row in settings.get("table_jpeo") or []:
	if not row.get("enable"):
		continue
	label = frappe.utils.cstr(row.get("tab") or "").strip()
	if not label:
		continue
	if allowed_tabs is not None and row.get("name") not in allowed_tabs:
		continue
	tabs.append(
		{
			"name": row.get("name"),
			"label": label,
			"slug": slugify(label),
			"title": frappe.utils.cstr(row.get("title") or "").strip() or label,
			"subtitle": frappe.utils.cstr(row.get("subtitle") or "").strip(),
			"icon": frappe.utils.cstr(row.get("icon") or "").strip() or None,
			"sensor_types": types_by_parent.get(row.get("name")) or [],
		}
	)

permitted = None if UNRESTRICTED else (scoped("Sensor Site") or None)
if permitted is None:
	sites = [
		r.get("name")
		for r in frappe.get_all("Sensor Site", fields=["name"], order_by="name asc", limit_page_length=0)
	]
else:
	sites = permitted

title = frappe.utils.cstr(settings.get("dashboard_title") or "").strip() or DEFAULT_TITLE

frappe.response["message"] = {
	"title": title,
	"tabs": tabs,
	"sites": sites,
	"sensor_types": type_labels,
	# type label (lowercased) -> display unit, so the app can label an axis for a
	# measure it charted without asking for the tab config again.
	"units": units,
	# True always: an unconfigured site shows everything to everyone rather than
	# locking every account out. The app keeps the flag so a future policy change
	# has somewhere to land.
	"access": True,
}
