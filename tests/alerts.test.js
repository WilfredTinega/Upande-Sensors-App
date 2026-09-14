/**
 * The Notifications list's pure helpers: day grouping and the unread rule.
 *
 *   node tests/alerts.test.js       (from the app directory)
 *
 * What this locks down: rows are grouped by the calendar day of `creation` in
 * the PHONE's zone, newest-first order is preserved rather than re-sorted, an
 * unparseable stamp is kept (under "Undated") rather than dropped, the unread
 * rule compares the server's own creation strings (never the phone clock), and
 * a phone that has never opened the list treats everything as unread — the
 * honest reading of "never looked".
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// Pull the helpers out of the ESM module without dragging in the timezone
// resolution, so this runs under plain node. `parseServerTime` is stubbed as
// "the server keeps UTC", which is all the helpers need from it.
const src = fs.readFileSync('src/utils/alerts.js', 'utf8');
const grab = (name) => {
  const start = src.indexOf(`export function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in alerts.js`);
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1).replace('export ', '');
    }
  }
  throw new Error(`unbalanced ${name}`);
};
// `startOfDay` is a module-private helper the exported ones lean on.
const grabPrivate = (name) => {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in alerts.js`);
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`unbalanced ${name}`);
};

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-')), 'alerts.mjs');
fs.writeFileSync(
  tmp,
  `function parseServerTime(value) {
  if (!value) return null;
  const m = /^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2})(?::(\\d{2}))?/.exec(String(value));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
}
${grabPrivate('startOfDay')}
${grabPrivate('normaliseStamp')}
${grab('dayLabel')}
${grab('groupAlertsByDay')}
${grab('isUnreadAlert')}
${grab('directionChip')}
export { dayLabel, groupAlertsByDay, isUnreadAlert, directionChip };
`,
);

const failures = [];
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  if (!ok) failures.push(name);
};

(async () => {
  const { dayLabel, groupAlertsByDay, isUnreadAlert, directionChip } = await import(tmp);

  // A fixed "now" at local noon, so the day arithmetic is not at the mercy of
  // the clock the test happens to run on.
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const stamp = (d) => {
    const pad = (n) => `${n}`.padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
  };
  const shift = (hours) => new Date(now.getTime() + hours * 3600000);

  check('today is "Today"', dayLabel(now, now) === 'Today');
  check('24h back is "Yesterday"', dayLabel(shift(-24), now) === 'Yesterday');
  const older = dayLabel(shift(-24 * 5), now);
  check('older days are a date, not a relative word', older !== 'Today' && older !== 'Yesterday' && older.length > 3);

  const rows = [
    { name: 'A1', creation: stamp(shift(-1)), direction: 'above' },
    { name: 'A2', creation: stamp(shift(-2)), direction: 'below' },
    { name: 'A3', creation: stamp(shift(-26)), direction: 'above' },
    { name: 'A4', creation: 'not a time' },
  ];
  const groups = groupAlertsByDay(rows, now);
  check('three groups: today, yesterday, undated', groups.length === 3);
  check('today group holds both of today\'s rows in order', groups[0].label === 'Today' && groups[0].rows.map((r) => r.name).join() === 'A1,A2');
  check('yesterday group follows', groups[1].label === 'Yesterday' && groups[1].rows[0].name === 'A3');
  check('unparseable stamp kept under Undated, last', groups[2].key === 'undated' && groups[2].rows[0].name === 'A4');
  check('empty input → no groups', groupAlertsByDay([], now).length === 0 && groupAlertsByDay(null, now).length === 0);

  // The cursor is the server's own `creation` string at full precision.
  const cursor = `${stamp(shift(-1.5))}.250000`;
  check('newer than the cursor is unread', isUnreadAlert(rows[0], cursor) === true);
  check('older than the cursor is read', isUnreadAlert(rows[1], cursor) === false);
  check('never opened → everything unread', isUnreadAlert(rows[1], null) === true);
  check('no stamp is never marked', isUnreadAlert({ name: 'X' }, null) === false);
  // The row the cursor was taken from: its seconds-only creation sorts before
  // the cursor's fractional tail, so it reads as seen rather than new forever.
  const newest = { creation: '2026-09-14 10:00:00' };
  check('the cursor row itself is read', isUnreadAlert(newest, '2026-09-14 10:00:00.123456') === false);
  check('a later second is unread', isUnreadAlert({ creation: '2026-09-14 10:00:01' }, '2026-09-14 10:00:00.123456') === true);
  check('ISO "T" separator is folded', isUnreadAlert({ creation: '2026-09-14T10:00:01' }, '2026-09-14 10:00:00.123456') === true);

  check('below → warning', directionChip('below').tone === 'warning');
  check('above → critical', directionChip('above').tone === 'critical');
  check('unknown direction reads as above', directionChip(undefined).tone === 'critical');

  if (failures.length) {
    console.error(`\n${failures.length} failing`);
    process.exit(1);
  }
  console.log('\nall passing');
})();
