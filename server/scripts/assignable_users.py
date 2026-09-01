# Server Script — script_type: API · api_method: upande_sensors_app.assignable_users · allow_guest: 0
#
# Accounts a report can be assigned to, for the app's assignment picker.
#
# The app used frappe.desk.search.search_link with frappe.client.get_list as a
# fallback. Both are awkward here: User carries a standard query override
# (frappe.core.doctype.user.user.user_query) that rewrites filters, and an
# unexpected filter there yields an empty list rather than an error — which
# reads as "there are no users". A plain query avoids the rewrite entirely.
#
# Only staff accounts are offered, so the picker can never put a report in a
# customer's queue. A Frappe account's name is its email address.
#
# Params: txt (search term), domain (override the staff domain), page_length

STAFF_DOMAIN = "@upande.com"

MAX_PAGE_LENGTH = 100


def arg(key, default=""):
	val = frappe.form_dict.get(key)
	if val is None:
		return default
	val = frappe.utils.cstr(val).strip()
	return val or default


txt = arg("txt")
domain = arg("domain", STAFF_DOMAIN).lower()
page_length = frappe.utils.cint(arg("page_length", "50")) or 50
if page_length > MAX_PAGE_LENGTH:
	page_length = MAX_PAGE_LENGTH

params = {"domain": "%" + domain, "page_length": page_length}
where = ["enabled = 1", "user_type = 'System User'", "name LIKE %(domain)s"]

if txt:
	params["txt"] = "%" + txt + "%"
	where.append("(name LIKE %(txt)s OR full_name LIKE %(txt)s)")

rows = frappe.db.sql(
	"SELECT name, full_name FROM `tabUser` WHERE "
	+ " AND ".join(where)
	+ " ORDER BY full_name ASC, name ASC LIMIT %(page_length)s",
	params,
	as_dict=True,
)

frappe.response["message"] = [
	{
		"value": r.get("name"),
		"label": (r.get("full_name") + " · " + r.get("name")) if r.get("full_name") else r.get("name"),
		"full_name": r.get("full_name") or "",
	}
	for r in rows
]
