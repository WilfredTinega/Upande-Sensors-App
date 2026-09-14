/**
 * The endpoint fallback chain, and what is and is not allowed to trigger it.
 *
 *   node tests/endpointsChain.test.js       (from the app directory)
 *
 * The rule this locks down: `viaChain` moves to the next address ONLY on
 * Frappe's "Failed to get method for command" (`isMissingEndpoint`). A
 * permission error is the server's real answer and must surface as-is —
 * silently retrying a 403 against an older endpoint would turn a clear "you
 * don't have access" into whatever the legacy path happened to return.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// Pull the pure helper out of the ESM module without dragging in the HTTP
// client, so this runs under plain node. `FrappeError` is stubbed with the one
// getter the helper reads.
const src = fs.readFileSync('src/api/endpoints.js', 'utf8');
const grab = (name) => {
  const start = src.indexOf(`export async function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in endpoints.js`);
  // Balance braces from the first { after the signature.
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

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chain-')), 'chain.mjs');
fs.writeFileSync(
  tmp,
  `class FrappeError extends Error {
  constructor(message, { status } = {}) { super(message); this.status = status; }
  get isMissingEndpoint() { return /Failed to get method for command/i.test(this.message || ''); }
  get isPermission() { return this.status === 403; }
}
${grab('viaChain')}
export { FrappeError, viaChain };
`,
);

const failures = [];
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  if (!ok) failures.push(name);
};

(async () => {
  const { FrappeError, viaChain } = await import(tmp);

  const missing = (name) =>
    new FrappeError(`Failed to get method for command ${name} with No module named ${name}`, {
      status: 404,
    });
  const forbidden = () => new FrappeError('Not permitted', { status: 403 });

  /** Attempts that record whether they were called. */
  const spy = (outcome) => {
    const fn = async () => {
      fn.calls += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    fn.calls = 0;
    return fn;
  };

  // Primary wins: the later links are never even called.
  {
    const app = spy('from app');
    const script = spy('from script');
    const legacy = spy('from legacy');
    const out = await viaChain([app, script, legacy]);
    check('primary wins', out === 'from app');
    check('nothing past the primary is called', script.calls === 0 && legacy.calls === 0);
  }

  // A missing app method falls through to the script.
  {
    const app = spy(missing('upande_sensors.api.mobile.live'));
    const script = spy('from script');
    const legacy = spy('from legacy');
    const out = await viaChain([app, script, legacy]);
    check('missing endpoint falls through to the next', out === 'from script');
    check('and stops there', legacy.calls === 0);
  }

  // Two missing links reach the legacy call.
  {
    const app = spy(missing('upande_sensors.api.mobile.live'));
    const script = spy(missing('upande_sensors_app.live'));
    const legacy = spy('from legacy');
    const out = await viaChain([app, script, legacy]);
    check('two missing links reach the third', out === 'from legacy');
  }

  // A permission error does NOT fall through.
  {
    const app = spy(forbidden());
    const script = spy('from script');
    let caught = null;
    try {
      await viaChain([app, script]);
    } catch (err) {
      caught = err;
    }
    check('a permission error is rethrown', caught?.isPermission === true);
    check('and the fallback is never called', script.calls === 0);
  }

  // A permission error further down the chain is still the answer.
  {
    const app = spy(missing('upande_sensors.api.mobile.readings'));
    const script = spy(forbidden());
    const legacy = spy('from legacy');
    let caught = null;
    try {
      await viaChain([app, script, legacy]);
    } catch (err) {
      caught = err;
    }
    check('a 403 from the script stops the chain', caught?.isPermission === true);
    check('the legacy call is not tried after it', legacy.calls === 0);
  }

  // Any other failure (a network error, a 500) is not a fallback trigger either.
  {
    const app = spy(new FrappeError('Request failed (500).', { status: 500 }));
    const script = spy('from script');
    let caught = null;
    try {
      await viaChain([app, script]);
    } catch (err) {
      caught = err;
    }
    check('a server error is rethrown', caught?.status === 500);
    check('without trying the next link', script.calls === 0);
  }

  // Every link missing: the LAST missing error surfaces, still readable as one.
  {
    const app = spy(missing('upande_sensors.api.mobile.chart_series'));
    const script = spy(missing('upande_sensors_app.chart_series'));
    let caught = null;
    try {
      await viaChain([app, script]);
    } catch (err) {
      caught = err;
    }
    check('all missing rethrows a missing-endpoint error', caught?.isMissingEndpoint === true);
    check(
      'and it is the last link\'s error',
      String(caught?.message).includes('upande_sensors_app.chart_series'),
    );
  }

  // Holes are skipped: a loader with no legacy path passes null for it.
  {
    const app = spy(missing('x'));
    const script = spy('from script');
    const out = await viaChain([app, null, script, undefined]);
    check('null links are skipped', out === 'from script');
  }

  console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
})();
