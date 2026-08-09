/**
 * Route-history recorder tests.
 *
 * Runs the shipped module with stubbed platform edges (network, filesystem,
 * AppState). The one-minute cadence and the ten-minute direct-path retry are
 * compressed so the whole suite runs in seconds; nothing else is altered.
 *
 *   node <this file>            (from the app directory)
 */
const fs = require('fs');

let src = fs
  .readFileSync('src/utils/routeHistory.js', 'utf8')
  .split('\n')
  .filter((l) => !l.startsWith('import '))
  .join('\n')
  .replace(/export /g, '')
  .replace('const FLUSH_EVERY_MS = 60000;', 'const FLUSH_EVERY_MS = 200;')
  .replace('const RETRY_DIRECT_AFTER_MS = 10 * 60 * 1000;', 'const RETRY_DIRECT_AFTER_MS = 500;')
  .replace('const RETRY_MS = [5000, 20000, 60000, 300000];', 'const RETRY_MS = [150, 150, 150];');

/* ── stubs ────────────────────────────────────────────────────────────────── */
let disk = null;
const Paths = { cache: '/c' };
class File {
  get exists() {
    return disk !== null;
  }
  write(t) {
    disk = t;
  }
  text() {
    return disk;
  }
  delete() {
    disk = null;
  }
}
let appHandler = null;
const AppState = {
  addEventListener: (_, h) => {
    appHandler = h;
    return {
      remove() {
        appHandler = null;
      },
    };
  },
};
const getServerOffsetMinutes = () => 0;

let mode = 'ok';
let direct = [];
let queued = [];
let requests = [];
class Perm extends Error {
  get isPermission() {
    return true;
  }
}
const insertRouteHistory = async (batch, user) => {
  if (mode === 'forbidden') throw new Perm('not permitted');
  if (mode === 'down') throw new Error('network down');
  requests.push(batch.length);
  direct.push(...batch.map((r) => ({ ...r, user })));
};
const queueRouteHistory = async (batch) => {
  if (mode === 'down') throw new Error('network down');
  requests.push(batch.length);
  queued.push(...batch);
};

eval(src);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  if (!ok) failures.push(name);
};

(async () => {
  /* ── batching cadence ───────────────────────────────────────────────────── */
  setRouteHistoryEnabled(true, 'jane@upande.com');

  recordRoute('Live');
  check('a visit is on disk before anything is sent', disk && JSON.parse(disk)[0].route === 'Live');
  recordRoute('Readings');
  recordRoute('Dashboard');
  recordRoute('Account');
  check('nothing sent immediately', requests.length === 0 && getRecordingStatus().pending === 4);

  await sleep(300);
  check('one bulk request on the tick', requests.length === 1 && requests[0] === 4);
  check('every visit delivered', direct.length === 4);
  check('rows carry the signed-in account', direct.every((r) => r.user === 'jane@upande.com'));
  check('queue emptied and disk cleared', getRecordingStatus().pending === 0 && disk === null);

  const idle = requests.length;
  await sleep(300);
  check('an idle tick sends nothing', requests.length === idle);

  /* ── failure handling ───────────────────────────────────────────────────── */
  mode = 'down';
  recordRoute('Offline');
  await sleep(300);
  check('a failed send keeps the visit', getRecordingStatus().pending === 1);
  check('the failure is reported', !!getRecordingStatus().error);
  check('the queue is on disk', disk !== null);
  check('a network failure does not divert to the fallback', queued.length === 0);

  mode = 'ok';
  await sleep(400);
  check('retry delivers it directly', direct.some((r) => r.route === 'Offline'));

  /* ── permission refusal and recovery ────────────────────────────────────── */
  mode = 'forbidden';
  recordRoute('Refused');
  await sleep(300);
  check('a refusal falls back to the queue', queued.some((r) => r.route === 'Refused'));
  check('the refusal is visible', getRecordingStatus().directRefused === true);
  check('nothing is lost in the switch', getRecordingStatus().pending === 0);

  mode = 'ok';
  recordRoute('StillQueued');
  await sleep(300);
  check(
    'stays on the fallback inside the retry window',
    queued.some((r) => r.route === 'StillQueued'),
  );

  await sleep(600);
  recordRoute('DirectAgain');
  await sleep(300);
  check('the direct path is retried later', direct.some((r) => r.route === 'DirectAgain'));
  check('the warning clears once direct works', getRecordingStatus().directRefused === false);

  /* ── lifecycle ──────────────────────────────────────────────────────────── */
  recordRoute('Backgrounded');
  appHandler('background');
  await sleep(50);
  check('backgrounding flushes early', direct.some((r) => r.route === 'Backgrounded'));

  recordRoute('Tail');
  await flushRouteHistory();
  check('sign-out flush delivers the tail', direct.some((r) => r.route === 'Tail'));

  mode = 'down';
  recordRoute('Unsent');
  await sleep(300);
  setRouteHistoryEnabled(false);
  check('sign-out keeps unsent work on disk', disk && JSON.parse(disk).some((r) => r.route === 'Unsent'));

  const stopped = requests.length;
  await sleep(300);
  check('the timer stops on sign-out', requests.length === stopped);

  mode = 'ok';
  setRouteHistoryEnabled(true, 'sam@upande.com');
  await sleep(300);
  check('the next sign-in delivers it', direct.some((r) => r.route === 'Unsent'));

  /* ── caps ───────────────────────────────────────────────────────────────── */
  mode = 'down';
  for (let i = 0; i < 600; i += 1) recordRoute(`R${i}`);
  await sleep(250);
  check('the queue is capped', getRecordingStatus().pending === 500);
  const held = JSON.parse(disk);
  check('the cap drops oldest and keeps newest', held[held.length - 1].route === 'R599');
  setRouteHistoryEnabled(false);

  console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
})();
