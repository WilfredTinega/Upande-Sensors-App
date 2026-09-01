#!/usr/bin/env node
/**
 * Push `server/scripts/*.py` to a Frappe site as Server Script documents.
 *
 * Idempotent: a script is matched by its `api_method`, so a second run updates
 * the same document rather than creating a rival one. Two Server Scripts sharing
 * an api_method is the failure mode to avoid — the dispatcher picks whichever
 * the cache saw first, so a stale copy can silently keep serving.
 *
 * Credentials come from the environment, never from this file:
 *
 *   SENSORS_BASE_URL   default https://sensor.upande.com
 *   SENSORS_API_KEY    the account's API key
 *   SENSORS_API_SECRET the account's API secret
 *
 * or a single pre-joined pair:
 *
 *   SENSORS_API_TOKEN  "<key>:<secret>"
 *
 * The account needs the **Script Manager** role: Server Script.validate calls
 * frappe.only_for("Script Manager", True), so any other account is refused on
 * save no matter what else it can do.
 *
 * Usage:
 *   node server/deploy.mjs                 # create or update every script
 *   node server/deploy.mjs --dry-run       # show what would change
 *   node server/deploy.mjs --only live,readings
 *   node server/deploy.mjs --verify        # call each endpoint afterwards
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const BASE_URL = (process.env.SENSORS_BASE_URL || 'https://sensor.upande.com').replace(/\/+$/, '');

function token() {
  const joined = process.env.SENSORS_API_TOKEN;
  if (joined) return joined.trim();
  const key = process.env.SENSORS_API_KEY;
  const secret = process.env.SENSORS_API_SECRET;
  if (key && secret) return `${key.trim()}:${secret.trim()}`;
  return null;
}

const AUTH = token();
if (!AUTH) {
  console.error(
    'No credentials. Set SENSORS_API_TOKEN="<key>:<secret>", or SENSORS_API_KEY and\n' +
      'SENSORS_API_SECRET. The account must hold the Script Manager role.',
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERIFY = args.includes('--verify');
const onlyArg = args.find((a) => a.startsWith('--only'));
const ONLY = onlyArg
  ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : null;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `token ${AUTH}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!res.ok) {
    // Frappe buries the real reason in _server_messages; surface it rather than
    // a bare status, which for a 417 could be any validation on the doctype.
    let detail = payload?.exception || payload?.exc_type || `HTTP ${res.status}`;
    try {
      const messages = JSON.parse(payload?._server_messages || '[]');
      const first = messages.length ? JSON.parse(messages[0]) : null;
      if (first?.message) detail = String(first.message).replace(/<[^>]+>/g, '');
    } catch {
      /* keep the fallback */
    }
    const err = new Error(`${method} ${path} — ${detail}`);
    err.status = res.status;
    err.payload = payload ?? text;
    throw err;
  }
  return payload;
}

/** The Server Script document already serving this api_method, if any. */
async function existing(apiMethod) {
  const filters = encodeURIComponent(JSON.stringify([['api_method', '=', apiMethod]]));
  const fields = encodeURIComponent(JSON.stringify(['name', 'script', 'disabled', 'script_type']));
  const res = await api(`/api/resource/Server Script?filters=${filters}&fields=${fields}&limit_page_length=0`);
  return res?.data?.length ? res.data[0] : null;
}

const manifest = JSON.parse(await readFile(join(HERE, 'manifest.json'), 'utf8'));

let created = 0;
let updated = 0;
let unchanged = 0;
let failed = 0;

for (const entry of manifest.scripts) {
  const short = entry.api_method.split('.').pop();
  if (ONLY && !ONLY.includes(short) && !ONLY.includes(entry.api_method)) continue;

  const script = await readFile(join(HERE, 'scripts', entry.file), 'utf8');

  try {
    const current = await existing(entry.api_method);

    if (current && current.script === script && !current.disabled) {
      unchanged += 1;
      console.log(`  =  ${entry.api_method}  (${current.name}, identical)`);
      continue;
    }

    if (DRY_RUN) {
      console.log(`  ${current ? '~' : '+'}  ${entry.api_method}  (dry run)`);
      continue;
    }

    if (current) {
      await api(`/api/resource/Server Script/${encodeURIComponent(current.name)}`, {
        method: 'PUT',
        body: { script, script_type: 'API', api_method: entry.api_method, disabled: 0, allow_guest: 0 },
      });
      updated += 1;
      console.log(`  ~  ${entry.api_method}  ->  ${current.name}`);
    } else {
      const doc = await api('/api/resource/Server Script', {
        method: 'POST',
        body: {
          doctype: 'Server Script',
          // The document name is cosmetic — dispatch is by api_method — but a
          // readable one keeps the Server Script list navigable.
          name: entry.name,
          script_type: 'API',
          api_method: entry.api_method,
          allow_guest: 0,
          disabled: 0,
          script,
        },
      });
      created += 1;
      console.log(`  +  ${entry.api_method}  ->  ${doc?.data?.name}`);
    }
  } catch (err) {
    failed += 1;
    console.error(`  !  ${entry.api_method}  ${err.message}`);
  }
}

console.log(
  `\n${BASE_URL}: ${created} created, ${updated} updated, ${unchanged} unchanged, ${failed} failed`,
);

if (VERIFY && !DRY_RUN) {
  console.log('\nVerifying (GET endpoints only; the POST ones would write):');
  for (const entry of manifest.scripts) {
    if (entry.method !== 'GET') continue;
    const short = entry.api_method.split('.').pop();
    if (ONLY && !ONLY.includes(short) && !ONLY.includes(entry.api_method)) continue;
    try {
      const res = await api(`/api/method/${entry.api_method}`);
      const size = JSON.stringify(res?.message ?? null).length;
      console.log(`  ok  ${entry.api_method}  (${size} bytes)`);
    } catch (err) {
      // A 403 here is a real answer for the gated endpoints: `activity` is
      // System Manager only, so a non-manager deploy account failing it is
      // correct behaviour, not a broken deployment.
      console.log(`  ${err.status === 403 ? '403' : ' ! '} ${entry.api_method}  ${err.message}`);
    }
  }
}

process.exit(failed ? 1 : 0);
