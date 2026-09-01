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
# Params: site, date_from, date_to, sensor_type, sensor_name,
#         start, page_length (max 500), order (desc|asc), with_total (0|1)

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


site = arg("site")
date_from = arg("date_from")
date_to = arg("date_to")
sensor_type = arg("sensor_type")
sensor_name = arg("sensor_name")
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
