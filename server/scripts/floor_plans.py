# Server Script — script_type: API · api_method: upande_sensors_app.floor_plans · allow_guest: 0
#
# Everything the app's Floor Plan tab draws, in ONE request: the site's plans,
# the selected plan with its sensor placements and fixture markers, the latest
# reading per placed sensor, and the open/closed history of every door marker.
#
# The web board assembles the same picture from four calls (list_flow_plans +
# get_flow_plan + get_live_readings + get_door_stats). A phone pays about a
# second per round trip against the cloud instance and re-polls this screen
# every minute, so four calls is four seconds a minute of a screen that is
# meant to be glanced at.
#
# Same response shape as `upande_sensors.api.mobile.floor_plans`, so the client
# cannot tell which of the two answered:
#
#   {plans: [{name, plan_name, sensor_site, has_blueprint}],
#    plan:  {name, plan_name, sensor_site, can_edit, blueprint, placements[],
#            markers[]} or null,
#    readings:    {<sensor_name>: {value, uom, ts, utr, ltr, params[]} | null},
#    door_states: {<sensor_name>: {state, since, open_seconds, closed_seconds,
#                                  openings, longest_open_seconds} | null},
#    server_time}
#
# `blueprint` is an ABSOLUTE url. The field holds a site-relative path and the
# phone has no base to resolve one against, so a relative value is a plan that
# never appears.
#
# Params: site (optional), plan (optional), door_hours (optional, default 24)

SESSION_USER = frappe.session.user
UNRESTRICTED = SESSION_USER == "Administrator"

MARKER_SIZE_DEFAULT = 26
MARKER_SIZE_MIN = 12
MARKER_SIZE_MAX = 160

# A door reading above this is open. LDS03A contact sensors report 0/1.
DOOR_OPEN_ABOVE = 0.5
# Words that identify which of a multi-parameter device's types IS the door.
DOOR_TYPE_HINTS = ["door", "contact", "magnet", "open"]
DOOR_MAX_HOURS = 92 * 24
DOOR_MAX_READINGS = 5000

# Readings older than this are not consulted for a pin's value. `tabSensor
# Reading` has no index leading with (site_name, timestamp), so what this query
# costs is decided entirely by how many rows the window lets through — and this
# screen re-polls every minute. A stale pin still wants its last value shown,
# though, so a window that finds NOTHING is widened once (see FALLBACK below):
# a plan whose gateway has been down for a fortnight should show old values
# greyed out, not read as though no sensor had ever been placed.
READING_WINDOW_DAYS = 30
READING_FALLBACK_DAYS = 400


def arg(key, default=""):
	val = frappe.form_dict.get(key)
	if val is None:
		return default
	val = frappe.utils.cstr(val).strip()
	return val or default


def scoped(allow):
	rows = frappe.get_all(
		"User Permission",
		filters={"user": SESSION_USER, "allow": allow},
		fields=["for_value"],
		limit_page_length=0,
	)
	return sorted(set([r.get("for_value") for r in rows if r.get("for_value")]))


def named_params(prefix, values):
	"""{"keys": [...], "params": {...}} for an IN clause, named-style.

	A dict rather than a pair because RestrictedPython has no
	`_unpack_sequence_`: `keys, params = ...` compiles and then fails at run
	time. Named placeholders because a literal `%` in the SQL collides with the
	driver's own `%(name)s` syntax.
	"""
	keys = []
	params = {}
	idx = 0
	for value in values:
		key = prefix + str(idx)
		params[key] = value
		keys.append("%(" + key + ")s")
		idx = idx + 1
	return {"keys": keys, "params": params}


def clamp_size(value):
	n = frappe.utils.cint(value)
	if n <= 0:
		return MARKER_SIZE_DEFAULT
	if n < MARKER_SIZE_MIN:
		return MARKER_SIZE_MIN
	if n > MARKER_SIZE_MAX:
		return MARKER_SIZE_MAX
	return n


def pos(value):
	"""A placement with no coordinate sits in the middle rather than at 0,0,
	where it would hide under the plan's top-left corner."""
	if value is None:
		return 50
	return frappe.utils.flt(value)


def door_type_for(sensor_name):
	"""Which sensor_type carries this device's door state, or None.

	A device reporting door AND temperature has one type that names the
	door; a single-parameter device has one type whatever it is called.
	Several types and none recognisable means the state is unknowable —
	answered with "" so no stats are produced, because reading a
	temperature as a door opening is worse than reading nothing.
	"""
	types = []
	for row in frappe.get_all(
		"Sensor Reading",
		filters={"sensor_name": sensor_name},
		fields=["sensor_type"],
		group_by="sensor_type",
		limit_page_length=20,
	):
		types.append(frappe.utils.cstr(row.get("sensor_type") or ""))
	for t in types:
		low = t.lower()
		for hint in DOOR_TYPE_HINTS:
			if hint in low:
				return t
	if len(types) == 1:
		return types[0]
	if not types:
		return None
	return ""


# ── Scope ────────────────────────────────────────────────────────────────────

allowed_sites = None if UNRESTRICTED else (scoped("Sensor Site") or None)

site = arg("site")
if site and allowed_sites is not None and site not in allowed_sites:
	frappe.throw("You do not have access to site " + site, frappe.PermissionError)

# Per-plan grants narrow further than the site can: KN1, KN2 and KN3 all sit on
# one Sensor Site, and a viewer may be granted only one of them. No rows at all
# means no restriction, the same convention as the site scope.
allowed_plans = None
if not UNRESTRICTED:
	allowed_plans = scoped("Flow Plan") or None

# A user granted particular Sensors sees those pins and no others, and a door
# marker linked to a sensor they may not see is left off the plan entirely.
allowed_sensors = None
if not UNRESTRICTED:
	sensor_docnames = scoped("Sensor")
	if sensor_docnames:
		rows = frappe.get_all(
			"Sensor",
			filters={"name": ["in", sensor_docnames]},
			fields=["sensor_name"],
			limit_page_length=0,
		)
		allowed_sensors = sorted(set([r.get("sensor_name") for r in rows if r.get("sensor_name")]))

visible_sensors = None if allowed_sensors is None else set(allowed_sensors)


def can_see(sensor_name):
	if visible_sensors is None:
		return True
	return (sensor_name or "") in visible_sensors


door_hours = frappe.utils.cint(arg("door_hours", "24")) or 24
if door_hours > DOOR_MAX_HOURS:
	door_hours = DOOR_MAX_HOURS

now_str = frappe.utils.now()

# ── The plans on the strip ───────────────────────────────────────────────────

plan_filters = {}
if site:
	# Site-less plans apply everywhere, so they ride along with the site's own.
	plan_filters["sensor_site"] = ["in", [site, "", None]]
elif allowed_sites is not None:
	wanted = []
	wanted.extend(allowed_sites)
	wanted.append("")
	plan_filters["sensor_site"] = ["in", wanted]

plan_rows = frappe.get_all(
	"Flow Plan",
	filters=plan_filters,
	fields=["name", "plan_name", "sensor_site", "blueprint", "sort_order"],
	# sort_order is what dragging the chips on the web writes; it defaults to 0,
	# so plans nobody has reordered keep falling back to creation order.
	order_by="sort_order asc, creation asc",
	limit_page_length=500,
)

plans = []
for row in plan_rows:
	if allowed_plans is not None and row.get("name") not in allowed_plans:
		continue
	plans.append(
		{
			"name": row.get("name"),
			"plan_name": row.get("plan_name") or row.get("name"),
			"sensor_site": row.get("sensor_site") or "",
			"has_blueprint": bool(row.get("blueprint")),
		}
	)

out = {
	"plans": plans,
	"plan": None,
	"readings": {},
	"door_states": {},
	"server_time": now_str,
}

wanted_plan = arg("plan")
chosen = None
if wanted_plan:
	for row in plans:
		if row["name"] == wanted_plan:
			chosen = wanted_plan
	if not chosen:
		# Refused rather than silently answered with the first plan: asking for
		# a plan by name is how a viewer scoped to KN1 would otherwise reach KN2.
		frappe.throw("You do not have access to plan " + wanted_plan, frappe.PermissionError)
elif plans:
	chosen = plans[0]["name"]

# ── The chosen plan ──────────────────────────────────────────────────────────

if chosen:
	doc = frappe.get_doc("Flow Plan", chosen)

	placements = []
	for p in doc.get("placements") or []:
		if not can_see(p.get("sensor_name")):
			continue
		placements.append(
			{
				"sensor_name": p.get("sensor_name"),
				"sensor_type": p.get("sensor_type") or "",
				"label": p.get("label") or "",
				"pos_x": pos(p.get("pos_x")),
				"pos_y": pos(p.get("pos_y")),
			}
		)

	markers = []
	for m in doc.get("markers") or []:
		linked = m.get("sensor_name") or ""
		# An unlinked fixture shows to everyone; one tied to a sensor this
		# account may not see is left off, like the sensor's own pin.
		if linked and not can_see(linked):
			continue
		markers.append(
			{
				"icon": m.get("icon") or "",
				"label": m.get("label") or "",
				"pos_x": pos(m.get("pos_x")),
				"pos_y": pos(m.get("pos_y")),
				"rotation": frappe.utils.cint(m.get("rotation")) % 360,
				"size_px": clamp_size(m.get("size_px")),
				"sensor_name": linked,
				"color": m.get("color") or "",
			}
		)

	blueprint = frappe.utils.cstr(doc.get("blueprint") or "").strip()
	if blueprint and not blueprint.lower().startswith("http"):
		blueprint = frappe.utils.get_url(blueprint)

	out["plan"] = {
		"name": doc.name,
		"plan_name": doc.get("plan_name") or doc.name,
		"sensor_site": doc.get("sensor_site") or "",
		# The app is read-only, but the field is part of the shape the web's
		# payload carries and the client stays free to use it later.
		"can_edit": False,
		"blueprint": blueprint,
		"placements": placements,
		"markers": markers,
	}

	reading_site = doc.get("sensor_site") or site or ""

	names = []
	for p in placements:
		if p["sensor_name"] and p["sensor_name"] not in names:
			names.append(p["sensor_name"])
	linked_names = []
	for m in markers:
		if m["sensor_name"] and m["sensor_name"] not in linked_names:
			linked_names.append(m["sensor_name"])
	for nm in linked_names:
		if nm not in names:
			names.append(nm)

	# ── Latest value per (sensor, measure) ───────────────────────────────────

	if names:
		picked = named_params("n", names)
		rparams = {}
		rparams.update(picked["params"])
		rparams["since"] = (
			frappe.utils.add_days(frappe.utils.today(), -READING_WINDOW_DAYS) + " 00:00:00"
		)
		# A handful of rows carry implausible future timestamps (one reads 2080).
		# Uncapped they win every "latest value" and a pin reports a reading that
		# has not happened.
		rparams["until"] = now_str
		rwhere = [
			"sensor_name IN (" + ", ".join(picked["keys"]) + ")",
			"timestamp >= %(since)s",
			"timestamp <= %(until)s",
		]
		if reading_site:
			rparams["site"] = reading_site
			rwhere.append("site_name = %(site)s")
		elif allowed_sites is not None:
			spicked = named_params("rs", allowed_sites)
			rparams.update(spicked["params"])
			rwhere.append("site_name IN (" + ", ".join(spicked["keys"]) + ")")

		# SUBSTRING_INDEX(GROUP_CONCAT(... ORDER BY timestamp DESC), ',', 1)
		# takes the newest value of each group without a correlated subquery.
		# GROUP_CONCAT truncates only at the tail, and the newest value is the
		# first element, so a long group is harmless.
		READING_SQL = (
			"SELECT sensor_name, LOWER(COALESCE(sensor_type, '')) AS sensor_type, "
			"MAX(timestamp) AS ts, "
			"SUBSTRING_INDEX(GROUP_CONCAT(value ORDER BY timestamp DESC), ',', 1) AS latest_value "
			"FROM `tabSensor Reading` WHERE " + " AND ".join(rwhere) + " "
			"GROUP BY sensor_name, LOWER(COALESCE(sensor_type, ''))"
		)
		raw = frappe.db.sql(READING_SQL, rparams, as_dict=True)
		if not raw:
			rparams["since"] = (
				frappe.utils.add_days(frappe.utils.today(), -READING_FALLBACK_DAYS) + " 00:00:00"
			)
			raw = frappe.db.sql(READING_SQL, rparams, as_dict=True)

		by_sensor = {}
		for row in raw:
			nm = row.get("sensor_name")
			if not nm:
				continue
			if nm not in by_sensor:
				by_sensor[nm] = []
			by_sensor[nm].append(
				{
					"type": row.get("sensor_type") or "",
					"value": frappe.utils.flt(row.get("latest_value"))
					if row.get("latest_value") is not None
					else None,
					"uom": "",
					"ts": frappe.utils.cstr(row.get("ts") or "")[:19],
					"utr": None,
					"ltr": None,
				}
			)

		# Live Sensor Data is preferred where it exists: it is the only source
		# carrying the unit AND the alarm thresholds, and utr/ltr are what turn
		# a pin red. A live row names no measure, so it replaces the sensor's
		# whole param list rather than being merged into it.
		live_filters = {}
		if reading_site:
			live_filters["name"] = reading_site
		elif allowed_sites is not None:
			live_filters["name"] = ["in", allowed_sites]
		live_parents = [
			r.get("name")
			for r in frappe.get_all(
				"Live Sensor Data", filters=live_filters, fields=["name"], limit_page_length=200
			)
		]
		if live_parents:
			lpicked = named_params("lp", live_parents)
			lnpicked = named_params("ln", names)
			lparams = {}
			lparams.update(lpicked["params"])
			lparams.update(lnpicked["params"])
			for item in frappe.db.sql(
				"SELECT sensor_name, current_reading, uom, submission_timestamp, utr, ltr "
				"FROM `tabLive Sensor Data Item` WHERE parent IN ("
				+ ", ".join(lpicked["keys"])
				+ ") AND sensor_name IN ("
				+ ", ".join(lnpicked["keys"])
				+ ")",
				lparams,
				as_dict=True,
			):
				nm = item.get("sensor_name")
				if not nm:
					continue
				by_sensor[nm] = [
					{
						"type": "",
						"value": item.get("current_reading"),
						"uom": item.get("uom") or "",
						"ts": frappe.utils.cstr(item.get("submission_timestamp") or "")[:19],
						"utr": item.get("utr"),
						"ltr": item.get("ltr"),
					}
				]

		for nm in names:
			params_for = by_sensor.get(nm) or []
			if not params_for:
				# Explicitly null, not absent: the pin says "No readings" rather
				# than the plan looking as though the sensor were not placed.
				out["readings"][nm] = None
				continue
			# Temperature first, then Humidity, then the rest — the order the
			# pin draws them in, decided here so every client agrees.
			ordered = []
			for wanted_type in ["temperature", "humidity"]:
				for p in params_for:
					if p["type"] == wanted_type:
						ordered.append(p)
			for p in params_for:
				if p["type"] not in ["temperature", "humidity"]:
					ordered.append(p)
			primary = ordered[0]
			out["readings"][nm] = {
				# The top-level fields mirror the first measure, which is what a
				# single-parameter sensor's pin reads.
				"value": primary.get("value"),
				"uom": primary.get("uom"),
				"ts": primary.get("ts"),
				"utr": primary.get("utr"),
				"ltr": primary.get("ltr"),
				"params": ordered,
			}

	# ── Door markers: state and durations over the window ────────────────────

	if linked_names:
		window_start = frappe.utils.cstr(
			frappe.utils.add_to_date(now_str, hours=-door_hours)
		)[:19]

		for nm in linked_names:
			dtype = door_type_for(nm)
			if dtype == "":
				out["door_states"][nm] = None
				continue

			dparams = {"sensor": nm, "start": window_start, "end": now_str}
			dwhere = ["sensor_name = %(sensor)s"]
			if reading_site:
				dparams["site"] = reading_site
				dwhere.append("site_name = %(site)s")
			elif allowed_sites is not None:
				dpicked = named_params("ds", allowed_sites)
				dparams.update(dpicked["params"])
				dwhere.append("site_name IN (" + ", ".join(dpicked["keys"]) + ")")
			if dtype is not None:
				dparams["dtype"] = dtype
				dwhere.append("COALESCE(sensor_type, '') = %(dtype)s")
			dclause = " AND ".join(dwhere)

			# The state the door was in when the window opened — without it, a
			# door that has not moved all day reads as having no state at all.
			carry = frappe.db.sql(
				"SELECT timestamp, value FROM `tabSensor Reading` WHERE "
				+ dclause
				+ " AND timestamp < %(start)s ORDER BY timestamp DESC LIMIT 1",
				dparams,
				as_dict=True,
			)
			inside = frappe.db.sql(
				"SELECT timestamp, value FROM `tabSensor Reading` WHERE "
				+ dclause
				+ " AND timestamp >= %(start)s AND timestamp <= %(end)s "
				"ORDER BY timestamp ASC LIMIT " + str(DOOR_MAX_READINGS),
				dparams,
				as_dict=True,
			)

			if not carry and not inside:
				out["door_states"][nm] = None
				continue

			# Collapse the readings into state changes. Only a change is a
			# segment boundary: a contact sensor that reports every 15 minutes
			# would otherwise produce 96 one-reading "openings" a day.
			changes = []
			state = None
			if carry:
				state = "open" if frappe.utils.flt(carry[0].get("value")) > DOOR_OPEN_ABOVE else "closed"
				changes.append({"state": state, "at": window_start})
			for row in inside:
				nxt = "open" if frappe.utils.flt(row.get("value")) > DOOR_OPEN_ABOVE else "closed"
				if nxt == state:
					continue
				state = nxt
				at = frappe.utils.cstr(row.get("timestamp") or "")[:19]
				changes.append({"state": state, "at": max([at, window_start])})

			open_seconds = 0
			closed_seconds = 0
			openings = 0
			longest_open = 0
			idx = 0
			for change in changes:
				if idx + 1 < len(changes):
					until = changes[idx + 1]["at"]
				else:
					until = now_str
				held = frappe.utils.time_diff_in_seconds(until, change["at"])
				if held < 0:
					held = 0
				if change["state"] == "open":
					open_seconds = open_seconds + held
					openings = openings + 1
					longest_open = max([longest_open, held])
				else:
					closed_seconds = closed_seconds + held
				idx = idx + 1

			out["door_states"][nm] = {
				"state": state or "",
				# When the door entered the state it is in now, which is what
				# the sheet shows as "Since".
				"since": changes[len(changes) - 1]["at"] if changes else None,
				"open_seconds": frappe.utils.cint(open_seconds),
				"closed_seconds": frappe.utils.cint(closed_seconds),
				"openings": openings,
				"longest_open_seconds": frappe.utils.cint(longest_open),
			}

frappe.response["message"] = out
