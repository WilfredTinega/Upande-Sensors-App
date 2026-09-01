# Server Script — script_type: API · api_method: upande_sensors_app.log_routes · allow_guest: 0
#
# MUST be called with POST. A Server Script that writes over GET reports success
# and changes nothing — Frappe rolls back the transaction for a GET request.
#
# Records screen visits.
#
# Two routes existed before, and both had a hole:
#
#  * frappe.client.insert_many needs `create` on Route History, which ships
#    granted to no role at all, so it was refused on a stock site.
#  * the deferred_insert endpoint only pushes to a Redis queue that the site's
#    scheduler drains on a 15-minute cron — nothing is recorded at all while
#    that scheduler is stopped, and the app has no way to tell.
#
# Here the row exists the moment the request returns.
#
# Visit times are preserved. Document.insert() stamps `creation` with now()
# regardless of what was passed, so the batched visit time was being replaced by
# the flush time; each row's real timestamp is written back afterwards.
#
# Params: routes — JSON array of {route, creation}

SESSION_USER = frappe.session.user

MAX_ROWS = 200

if frappe.request and frappe.request.method != "POST":
	frappe.throw("Visits must be recorded with POST; a GET is rolled back.", frappe.PermissionError)

raw = frappe.form_dict.get("routes")
parsed = frappe.utils.parse_json(raw) if isinstance(raw, str) else raw
if not isinstance(parsed, list):
	parsed = []

written = []
skipped = 0
for entry in parsed[:MAX_ROWS]:
	if not isinstance(entry, dict):
		skipped = skipped + 1
		continue
	route = frappe.utils.cstr(entry.get("route") or "").strip()
	if not route:
		skipped = skipped + 1
		continue
	visited = frappe.utils.cstr(entry.get("creation") or "").strip()

	doc = frappe.get_doc(
		{
			"doctype": "Route History",
			"route": route,
			# Stamped explicitly: this is a plain insert, and nothing else will
			# attribute the visit to the account that made it.
			"user": SESSION_USER,
		}
	)
	doc.insert(ignore_permissions=True)

	if visited:
		# update_modified=False so the row's `modified` keeps saying when it was
		# actually written, while `creation` says when the visit happened.
		frappe.db.set_value("Route History", doc.name, "creation", visited, update_modified=False)

	written.append(doc.name)

frappe.response["message"] = {
	"written": len(written),
	"skipped": skipped,
	"names": written,
	"user": SESSION_USER,
}
