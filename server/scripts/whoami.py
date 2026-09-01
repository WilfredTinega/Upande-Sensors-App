# Server Script — script_type: API · api_method: upande_sensors_app.whoami · allow_guest: 0
#
# Everything the app needs to know about the signed-in account, in one request.
#
# Replaces five separate calls the app used to make at sign-in, three of which
# are not available to a normal account on a stock site:
#
#   frappe.auth.get_logged_user                     — whitelisted, fine
#   frappe.client.get_list on Has Role              — frappe.get_roles is not whitelisted
#   frappe.client.get_value on User                 — whitelisted, fine
#   frappe.client.get_value on System Settings      — System Manager only
#   frappe.utils.change_log.get_versions            — NOT whitelisted at all (403 for everyone)
#
# Running here means the app gets the timezone and the app versions for every
# account rather than for System Managers only, and gets them in one round trip
# instead of five (each costs about a second against the cloud instance).

SESSION_USER = frappe.session.user

roles = []
for row in frappe.get_all(
	"Has Role",
	filters={"parent": SESSION_USER, "parenttype": "User"},
	fields=["role"],
	limit_page_length=0,
):
	if row.get("role"):
		roles.append(row.get("role"))
roles = sorted(set(roles))

profile = frappe.db.get_value("User", SESSION_USER, ["full_name", "user_image"], as_dict=True) or {}

# App versions. Read from the Installed Application child table rather than
# frappe.utils.change_log.get_versions, which is not whitelisted, so the app's
# Account screen can show what the server is running for any account.
versions = {}
for row in frappe.db.sql(
	"SELECT app_name, app_version, git_branch FROM `tabInstalled Application` ORDER BY idx",
	as_dict=True,
):
	app_name = row.get("app_name")
	if app_name:
		versions[app_name] = {
			"title": app_name,
			"version": row.get("app_version") or "",
			"branch": row.get("git_branch") or "",
		}

# Sensor Site scoping, reported so the app can tell "no sites configured" from
# "you have not been granted any". An empty permission set is NOT a restriction
# — it means nobody has scoped this user, so they see every site.
scoped = []
for row in frappe.get_all(
	"User Permission",
	filters={"user": SESSION_USER, "allow": "Sensor Site"},
	fields=["for_value"],
	limit_page_length=0,
):
	if row.get("for_value"):
		scoped.append(row.get("for_value"))

frappe.response["message"] = {
	"user": SESSION_USER,
	"full_name": profile.get("full_name") or SESSION_USER,
	"user_image": profile.get("user_image") or None,
	"roles": roles,
	"is_admin": SESSION_USER == "Administrator",
	"is_system_manager": "System Manager" in roles or SESSION_USER == "Administrator",
	"time_zone": frappe.db.get_single_value("System Settings", "time_zone") or None,
	# The app compares reading timestamps against the phone clock; sending the
	# server's own clock lets it detect skew instead of calling fresh data stale.
	"server_time": frappe.utils.now(),
	"versions": versions,
	"scoped_sites": sorted(set(scoped)),
}
