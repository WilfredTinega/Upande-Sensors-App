/**
 * Request-cache tests, with the live-readings deadlock as the headline case.
 *
 *   node tests/cache.test.js            (from the app directory)
 *
 * The bug this locks down: `useQuery(sensorsKey(site), () => loadSiteSensors(site))`
 * where `loadSiteSensors` also cached under `sensorsKey(site)`. `inflight.set`
 * runs before the loader does, so the inner call was handed the promise it was
 * itself inside — which can never settle. The Live screen skeletoned forever and
 * no request was ever made, so nothing in the network log explained it.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// The module is ESM; run it through a temp file so the real source is exercised
// rather than a copy of its logic.
const src = fs.readFileSync('src/api/cache.js', 'utf8');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-')), 'cache.mjs');
fs.writeFileSync(tmp, src);

const failures = [];
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  if (!ok) failures.push(name);
};

const settles = (promise, ms = 1000) =>
  Promise.race([
    promise.then((v) => ({ ok: true, v })),
    new Promise((r) => setTimeout(() => r({ ok: false, v: 'never settled' }), ms)),
  ]);

(async () => {
  const { cached, cacheKey, invalidate, peek, TTL_LIVE } = await import(tmp);

  /* ── the deadlock ─────────────────────────────────────────────────────────── */
  {
    const K = cacheKey('site_sensors', { site: 'RLR' });
    let calls = 0;
    const fetchSite = async () => {
      calls += 1;
      return { sensors: [{ sensor_name: 'A' }], values: { A: { value: 1 } } };
    };
    // liveSite.loadSiteSensors, as it must be: no cache under the screen's key.
    const loadSiteSensors = async () => (await fetchSite()).sensors;
    // useQuery.run('load')
    const res = await settles(cached(K, () => loadSiteSensors(), { ttl: 1000 }));
    check('a loader reached through useQuery settles', res.ok);
    check('and it actually made the request', calls === 1);
    invalidate();
  }

  {
    const K = cacheKey('site_sensors', { site: 'X' });
    let calls = 0;
    // The shape that used to hang: the loader asks for its OWN key.
    const reentrant = () => cached(K, async () => { calls += 1; return 'inner'; }, { ttl: 1000 });
    const res = await settles(cached(K, () => reentrant(), { ttl: 1000 }));
    check('a re-entrant same-key load still settles', res.ok && res.v === 'inner');
    check('served uncached rather than deadlocked', calls === 1);
    invalidate();
  }

  /* ── the guard must not mistake a sibling for a cycle ─────────────────────── */
  {
    let calls = 0;
    const load = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return 'v';
    };
    // Same tick.
    await Promise.all([cached('sib', () => load(), { ttl: 5000 }), cached('sib', () => load(), { ttl: 5000 })]);
    check('two siblings in one tick share a request', calls === 1);

    // Mid-flight — the case a whole-window guard gets wrong. A device log showed
    // two `whoami` requests here, because the Account screen asked while
    // sign-in's ask was still open.
    calls = 0;
    const first = cached('sib2', () => load(), { ttl: 5000 });
    await new Promise((r) => setTimeout(r, 5));
    const second = cached('sib2', () => load(), { ttl: 5000 });
    await Promise.all([first, second]);
    check('a sibling arriving mid-flight joins it', calls === 1);
    invalidate();
  }

  /* ── the Dashboard's two queries must cost ONE request ────────────────────── */
  {
    let calls = 0;
    const SITE = cacheKey('app_live', { site: 'RLR' });
    const fetchSite = () =>
      cached(SITE, async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return { sensors: [{ sensor_name: 'A' }], values: { A: { value: 1 } } };
      }, { ttl: TTL_LIVE });

    const sensorsQ = cached(cacheKey('site_sensors', { site: 'RLR' }),
      () => fetchSite().then((p) => p.sensors), { ttl: 1000 });
    const valuesQ = cached(cacheKey('live_values', { site: 'RLR' }),
      () => fetchSite().then((p) => p.values), { ttl: 1000 });

    const [sensors, values] = await Promise.all([sensorsQ, valuesQ]);
    check('both halves resolve', sensors.length === 1 && !!values.A);
    check('and share a single request', calls === 1);

    // A later read of the same site inside the TTL adds nothing.
    await cached(cacheKey('live_readings', { site: 'RLR' }), () => fetchSite(), { ttl: 1000 });
    check('a third consumer inside the TTL adds no request', calls === 1);
    invalidate();
  }

  /* ── the plain contract still holds ───────────────────────────────────────── */
  {
    let calls = 0;
    const load = async () => { calls += 1; return calls; };
    await cached('k', load, { ttl: 10000 });
    await cached('k', load, { ttl: 10000 });
    check('a fresh entry is reused', calls === 1);
    check('peek sees it without fetching', peek('k') === 1 && calls === 1);

    await cached('k', load, { ttl: 10000, force: true });
    check('force refetches', calls === 2);

    await cached('expiring', load, { ttl: 1 });
    await new Promise((r) => setTimeout(r, 15));
    await cached('expiring', load, { ttl: 1 });
    check('an expired entry refetches', calls === 4);

    invalidate();
    check('invalidate clears', peek('k') === undefined);
  }

  console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
})();
