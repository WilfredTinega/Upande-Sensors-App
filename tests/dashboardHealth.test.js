/**
 * The Home tile's sensor count, from a `dashboard_health` payload.
 *
 *   node tests/dashboardHealth.test.js        (from the app directory)
 *
 * The bug this locks down: the user reported the tiles showing no counts at
 * all. The cause was the endpoint being missing on the server — but the second
 * thing to rule out was the lookup key. The server keys `tabs` by the Sensor
 * Setting CHILD ROW NAME, which is the `name` the config endpoint gives each
 * tab; matching on the slug or the label instead would find no row on a live
 * payload, and the tile would render exactly the same nothing. So the key is
 * pinned here rather than being re-derived by reading.
 *
 * The second rule: an absent row is null (unknown → the tile shows nothing),
 * never zeros. A tile reading "0 sensors" is a claim about the dashboard; a
 * blank line is an admission about the request.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// HomeScreen.js imports react-native, which plain node cannot load, so the one
// pure function is lifted out by text — the same trick tests/cache.test.js and
// tests/endpointsChain.test.js use. The real source is exercised, not a copy.
const src = fs.readFileSync('src/screens/HomeScreen.js', 'utf8');
const start = src.indexOf('export function healthForTab(');
if (start === -1) throw new Error('healthForTab not found in HomeScreen.js');
let depth = 0;
let body = null;
for (let i = src.indexOf('{', start); i < src.length; i += 1) {
  if (src[i] === '{') depth += 1;
  else if (src[i] === '}') {
    depth -= 1;
    if (depth === 0) {
      body = src.slice(start, i + 1);
      break;
    }
  }
}
if (!body) throw new Error('unbalanced healthForTab');

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'health-')), 'health.mjs');
fs.writeFileSync(tmp, body);

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}`);
  if (!ok) console.log(`      got ${JSON.stringify(got)}\n     want ${JSON.stringify(want)}`);
}

(async () => {
  const { healthForTab } = await import(`file://${tmp}`);

  // A payload shaped exactly as server/scripts/dashboard_health.py answers it.
  const payload = {
    stale_minutes: 120,
    tabs: {
      // A legacy row, whose name happens to equal its label.
      'Cold Chain Monitoring': {
        total: 6,
        active: 4,
        stale: 2,
        last_reading: '2026-09-13 09:12:00',
        scope: 'monitoring',
      },
      // A row added later, whose name is a hash and matches neither the label
      // nor the slug — the case a slug lookup gets wrong.
      '4l0i075kah': { total: 0, active: 0, stale: 0, last_reading: null, scope: 'none' },
    },
    site: { total: 17, active: 9, stale: 8, last_reading: '2026-09-13 09:12:00' },
  };

  check(
    'the row is found by tab.name',
    healthForTab(payload, {
      name: 'Cold Chain Monitoring',
      slug: 'cold-chain-monitoring',
      label: 'Cold Chain Monitoring',
    }),
    { total: 6, active: 4, stale: 2, lastReading: '2026-09-13 09:12:00', scope: 'monitoring' },
  );

  check(
    'a hashed row name is found too, where its slug and label would not match',
    healthForTab(payload, {
      name: '4l0i075kah',
      slug: 'pest-and-disease-analysis',
      label: 'Pest & Disease Analysis',
    }),
    { total: 0, active: 0, stale: 0, lastReading: null, scope: 'none' },
  );

  check(
    'the slug is NOT a key — looking up by it finds nothing',
    healthForTab(payload, { name: 'cold-chain-monitoring', label: 'Cold Chain Monitoring' }),
    null,
  );

  check(
    'a tab the payload has no row for is unknown, not zero',
    healthForTab(payload, { name: 'Weather', slug: 'weather', label: 'Weather' }),
    null,
  );

  // The whole reason the tiles were blank: the endpoint is missing, so there is
  // no payload at all. Every tile must read as unknown rather than as empty.
  check('no payload at all is unknown', healthForTab(null, { name: 'Cold Chain Monitoring' }), null);
  check('an error payload is unknown', healthForTab({}, { name: 'Cold Chain Monitoring' }), null);
  check('a tab with no name is unknown', healthForTab(payload, {}), null);
  check('no tab at all is unknown', healthForTab(payload, undefined), null);

  // The site total is in the payload and must never be reachable by a tab key —
  // a dashboard tile showing the site's 17 sensors is a confident wrong answer.
  check(
    'the site total cannot be reached through the tabs map',
    healthForTab(payload, { name: 'site' }),
    null,
  );

  // Frappe hands integers back as strings through some paths.
  check(
    'string counts are coerced',
    healthForTab(
      { tabs: { A: { total: '6', active: '4', stale: '2', scope: 'types' } } },
      { name: 'A' },
    ),
    { total: 6, active: 4, stale: 2, lastReading: null, scope: 'types' },
  );

  check(
    'missing counts read as zero once the row itself exists',
    healthForTab({ tabs: { A: { scope: 'none' } } }, { name: 'A' }),
    { total: 0, active: 0, stale: 0, lastReading: null, scope: 'none' },
  );

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
