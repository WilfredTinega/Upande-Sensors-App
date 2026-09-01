# Server Script — script_type: API · api_method: upande_sensors_app.report_submit · allow_guest: 0
#
# MUST be called with POST — a Server Script that writes over GET reports
# success and changes nothing, because Frappe rolls back the GET transaction.
#
# Files a problem report or feature request from the app.
#
# Reports are stored as Issue so they land in the queue the desk already works
# from. Issue ships with create granted to Support Team only, so every account
# outside that role could not report a problem with the app at all — the one
# thing you most want a user to be able to do when something is broken. This
# writes with ignore_permissions and records the reporter itself.
#
# Three requests become one: create, assign, attach screenshot. Assignment has
# to be its own step at the document level — `_assign` passed to an insert is
# discarded, because the field is maintained by the assignment API rather than
# by the save, so a report created that way arrives with an empty Assign panel
# and no ToDo in anyone's queue.
#
# Params: subject, description, kind (issue|feature), assign_to (optional),
#         screenshot_base64 (optional), screenshot_name (optional)

SESSION_USER = frappe.session.user

# The two kinds of report, told apart by a prefix on the subject. Both begin
# "app-", so the problem filter must exclude the feature form explicitly.
PREFIXES = {"issue": "app-", "feature": "app-feature-"}

if frappe.request and frappe.request.method != "POST":
	frappe.throw("Reports must be filed with POST; a GET is rolled back.", frappe.PermissionError)


def arg(key, default=""):
	val = frappe.form_dict.get(key)
	if val is None:
		return default
	val = frappe.utils.cstr(val).strip()
	return val or default


subject = arg("subject")
description = arg("description")
kind = arg("kind", "issue").lower()
assign_to = arg("assign_to")
screenshot = frappe.form_dict.get("screenshot_base64")
screenshot_name = arg("screenshot_name", "screenshot.jpg")

if not subject:
	frappe.throw("A report needs a subject.")
if kind not in PREFIXES:
	kind = "issue"

# No space after the prefix: the subject reads as one token in the desk list,
# e.g. "app-the dashboard is not showing data".
doc = frappe.get_doc(
	{
		"doctype": "Issue",
		"subject": PREFIXES.get(kind) + subject,
		"description": description,
	}
)

# raised_by is an Email field. Frappe account ids are usually addresses but not
# always — "Administrator" is the obvious one — and a non-address fails
# validation, which used to block those accounts from reporting at all. The
# doc's owner records who filed it either way.
if "@" in SESSION_USER and "." in SESSION_USER.split("@")[-1]:
	doc.raised_by = SESSION_USER

doc.insert(ignore_permissions=True)

assigned = None
if assign_to:
	if frappe.db.exists("User", assign_to):
		# A ToDo is what actually puts the report in the assignee's queue and
		# notifies them; setting _assign alone would only decorate the form.
		todo = frappe.get_doc(
			{
				"doctype": "ToDo",
				"allocated_to": assign_to,
				"reference_type": "Issue",
				"reference_name": doc.name,
				"description": subject,
				"assigned_by": SESSION_USER,
				"status": "Open",
			}
		)
		todo.insert(ignore_permissions=True)
		frappe.db.set_value(
			"Issue", doc.name, "_assign", as_json([assign_to]), update_modified=False
		)
		assigned = assign_to

attached = None
if screenshot:
	# The sandbox has no base64 module. The File controller decodes it instead:
	# `decode` tells save_file the content is base64, so nothing has to be
	# decoded here.
	image = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": screenshot_name,
			"attached_to_doctype": "Issue",
			"attached_to_name": doc.name,
			"is_private": 1,
			"content": screenshot,
			"decode": True,
		}
	)
	image.insert(ignore_permissions=True)
	attached = image.file_url

frappe.response["message"] = {
	"name": doc.name,
	"subject": doc.subject,
	"kind": kind,
	"assigned_to": assigned,
	"attachment": attached,
	"owner": SESSION_USER,
}
