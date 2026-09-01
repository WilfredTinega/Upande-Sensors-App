# Server Script — script_type: API · api_method: upande_sensors_app.activity · allow_guest: 0
#
# Screen visits and sign-in/out events, for the app's admin Activity screen.
#
# Route History and Activity Log both grant read to System Manager only, so the
# app read them through frappe.client.get_list and the screen simply failed for
# anyone else. That gate is kept — this is other people's usage data — but it is
# now enforced once here with a clear message, instead of arriving as an
# ambiguous 403 that the client had to probe the session to interpret.
#
# Three requests become one: the route page, its total, and the sign-in trail.
# Account full names are resolved here too; the lists carry only the account id,
# which is an email address and unrecognisable where the local part is initials.
#
# Params: date_from, date_to, user, start, page_length (max 500),
#         include (csv of routes,auth — default both), auth_limit

SESSION_USER = frappe.session.user

# frappe.get_roles is not available in the script sandbox, so the Has Role child
# table is read directly — same source it reads itself.
if SESSION_USER != "Administrator" and not frappe.db.exists(
	"Has Role", {"parent": SESSION_USER, "parenttype": "User", "role": "System Manager"}
):
	frappe.throw(
		"Activity across accounts is visible to System Managers only.", frappe.PermissionError
	)

MAX_PAGE_LENGTH = 500
MAX_AUTH_ROWS = 2000


def arg(key, default=""):
	val = frappe.form_dict.get(key)
	if val is None:
		return default
	val = frappe.utils.cstr(val).strip()
	return val or default


date_from = arg("date_from")
date_to = arg("date_to")
who = arg("user")
start = frappe.utils.cint(arg("start", "0"))
page_length = frappe.utils.cint(arg("page_length", "50")) or 50
auth_limit = frappe.utils.cint(arg("auth_limit", "1000")) or 1000
include = [p.strip() for p in arg("include", "routes,auth").lower().split(",") if p.strip()]

if start < 0:
	start = 0
if page_length > MAX_PAGE_LENGTH:
	page_length = MAX_PAGE_LENGTH
if auth_limit > MAX_AUTH_ROWS:
	auth_limit = MAX_AUTH_ROWS

params = {"start": start, "page_length": page_length, "auth_limit": auth_limit}
window = []
if date_from:
	params["from_ts"] = date_from + " 00:00:00"
	window.append("creation >= %(from_ts)s")
if date_to:
	params["to_ts"] = date_to + " 23:59:59"
	window.append("creation <= %(to_ts)s")

route_where = [] + window
if who:
	# Without this one heavy browser fills every page and everyone else's visits
	# are further down than anyone scrolls.
	params["who"] = who
	route_where.append("user = %(who)s")

routes = {"rows": [], "total": 0}
if "routes" in include:
	clause = " AND ".join(route_where) if route_where else "1 = 1"
	rows = frappe.db.sql(
		"SELECT name, user, route, creation FROM `tabRoute History` WHERE "
		+ clause
		+ " ORDER BY creation DESC LIMIT %(page_length)s OFFSET %(start)s",
		params,
		as_dict=True,
	)
	counted = frappe.db.sql(
		"SELECT COUNT(*) AS total FROM `tabRoute History` WHERE " + clause, params, as_dict=True
	)
	routes = {
		"rows": [
			{
				"name": r.get("name"),
				"user": r.get("user") or "",
				"route": r.get("route") or "",
				"creation": frappe.utils.cstr(r.get("creation") or ""),
			}
			for r in rows
		],
		"total": frappe.utils.cint(counted[0].get("total")) if counted else 0,
		"start": start,
		"page_length": page_length,
	}

auth = []
truncated = False
if "auth" in include:
	auth_where = ["operation IN ('Login', 'Logout')"] + window
	if who:
		auth_where.append("user = %(who)s")
	# Rows rather than a server-side GROUP BY: the screen draws a per-day
	# in/out count, and reporting the row cap lets it say so rather than
	# quietly under-counting a busy window.
	rows = frappe.db.sql(
		"SELECT name, user, operation, status, subject, creation FROM `tabActivity Log` WHERE "
		+ " AND ".join(auth_where)
		+ " ORDER BY creation DESC LIMIT %(auth_limit)s",
		params,
		as_dict=True,
	)
	auth = [
		{
			"name": r.get("name"),
			"user": r.get("user") or "",
			"operation": r.get("operation") or "",
			# `status` separates a failed sign-in attempt from a successful one;
			# `subject` carries the logout reason.
			"status": r.get("status") or "",
			"subject": frappe.utils.strip_html(frappe.utils.cstr(r.get("subject") or "")),
			"creation": frappe.utils.cstr(r.get("creation") or ""),
		}
		for r in rows
	]
	truncated = len(auth) >= auth_limit

wanted = set([r.get("user") for r in routes.get("rows") if r.get("user")])
for r in auth:
	if r.get("user"):
		wanted.add(r.get("user"))

full_names = {}
if wanted:
	for row in frappe.get_all(
		"User",
		filters={"name": ["in", sorted(wanted)]},
		fields=["name", "full_name"],
		limit_page_length=0,
	):
		if row.get("name") and row.get("full_name"):
			full_names[row.get("name")] = row.get("full_name")

frappe.response["message"] = {
	"routes": routes,
	"auth": auth,
	"auth_truncated": truncated,
	"full_names": full_names,
}
