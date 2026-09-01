# Server Script — script_type: API · api_method: upande_sensors_app.reports_list · allow_guest: 0
#
# Reports raised from the app, newest first.
#
# Read here rather than through frappe.client.get_list because Issue grants read
# to Support Team only, so the Reports screen was empty-or-broken for every other
# account — including the accounts that had just filed the reports.
#
# `_assign` is resolved into a plain assignee here. The app cannot read that
# field itself: the script sandbox refuses any subscript whose key starts with
# an underscore, and on the client it was a JSON array in a string that every
# caller had to parse.
#
# Params: kind (issue|feature, omit for both), page_length (max 200),
#         start, mine (0|1)

SESSION_USER = frappe.session.user

MAX_PAGE_LENGTH = 200


def arg(key, default=""):
	val = frappe.form_dict.get(key)
	if val is None:
		return default
	val = frappe.utils.cstr(val).strip()
	return val or default


kind = arg("kind").lower()
start = frappe.utils.cint(arg("start", "0"))
page_length = frappe.utils.cint(arg("page_length", "50")) or 50
mine = frappe.utils.cint(arg("mine", "0"))

if start < 0:
	start = 0
if page_length > MAX_PAGE_LENGTH:
	page_length = MAX_PAGE_LENGTH

params = {"start": start, "page_length": page_length}
where = []

# The patterns are bound, not inlined: a literal % in the SQL text collides with
# the driver's own %(name)s placeholders and the query dies before it runs.
params["any_report"] = "app-%"
params["feature"] = "app-feature-%"

if kind == "feature":
	where.append("subject LIKE %(feature)s")
elif kind == "issue":
	# Both prefixes begin "app-", so a problem filter that does not exclude the
	# feature form matches every request too.
	where.append("subject LIKE %(any_report)s")
	where.append("subject NOT LIKE %(feature)s")
else:
	where.append("subject LIKE %(any_report)s")

if mine:
	params["who"] = SESSION_USER
	where.append("(owner = %(who)s OR raised_by = %(who)s)")

clause = " AND ".join(where)

rows = frappe.db.sql(
	"SELECT name, subject, status, priority, raised_by, owner, creation, modified, "
	"`_assign` AS assigned FROM `tabIssue` WHERE "
	+ clause
	+ " ORDER BY creation DESC LIMIT %(page_length)s OFFSET %(start)s",
	params,
	as_dict=True,
)

counted = frappe.db.sql("SELECT COUNT(*) AS total FROM `tabIssue` WHERE " + clause, params, as_dict=True)

out = []
for row in rows:
	# `_assign` is a JSON array string; the app only ever showed the first name.
	assignees = frappe.utils.parse_json(row.get("assigned") or "[]")
	if not isinstance(assignees, list):
		assignees = []
	subject = frappe.utils.cstr(row.get("subject") or "")
	is_feature = subject.startswith("app-feature-")
	out.append(
		{
			"name": row.get("name"),
			# Reported both ways: with the prefix, as the desk shows it, and
			# without, which is what the user actually typed.
			"subject": subject,
			"title": subject[12:] if is_feature else subject[4:],
			"kind": "feature" if is_feature else "issue",
			"status": row.get("status") or "",
			"priority": row.get("priority") or "",
			"raised_by": row.get("raised_by") or "",
			"owner": row.get("owner") or "",
			"assignees": assignees,
			"assigned_to": assignees[0] if assignees else None,
			"creation": frappe.utils.cstr(row.get("creation") or ""),
			"modified": frappe.utils.cstr(row.get("modified") or ""),
		}
	)

wanted = set()
for row in out:
	for key in ["owner", "assigned_to"]:
		if row.get(key):
			wanted.add(row.get(key))

full_names = {}
if wanted:
	for row in frappe.get_all(
		"User", filters={"name": ["in", sorted(wanted)]}, fields=["name", "full_name"], limit_page_length=0
	):
		if row.get("name") and row.get("full_name"):
			full_names[row.get("name")] = row.get("full_name")

frappe.response["message"] = {
	"rows": out,
	"total": frappe.utils.cint(counted[0].get("total")) if counted else 0,
	"start": start,
	"page_length": page_length,
	"full_names": full_names,
}
