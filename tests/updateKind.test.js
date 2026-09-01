/**
 * Which delivery an upgrade needs, and where the boundary sits.
 *
 *   node tests/updateKind.test.js       (from the app directory)
 *
 * The rule this locks down: `major.minor` is the compatibility boundary, so a
 * patch bump is JS-deliverable and anything wider needs the APK. It matches the
 * odometer in scripts/version.mjs — a normal merge bumps the patch, `--bump
 * minor` is the deliberate "native changed" signal — and it is the same string
 * expo-updates uses as its own runtimeVersion gate.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// Pull the two pure functions out of the ESM module without dragging in
// SecureStore, so this runs under plain node.
const src = fs.readFileSync('src/api/updates.js', 'utf8');
const grab = (name) => {
  const start = src.indexOf(`export function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in updates.js`);
  // Balance braces from the first { after the signature.
  let i = src.indexOf('{', start);
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

const kindsMatch = src.match(/export const UPDATE_KINDS = \{[\s\S]*?\};/);
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'upd-')), 'u.mjs');
fs.writeFileSync(
  tmp,
  `${kindsMatch[0].replace('export ', '')}\n${grab('runtimeVersionOf')}\n${grab('updateKind')}\n` +
    'export { UPDATE_KINDS, runtimeVersionOf, updateKind };\n',
);

const failures = [];
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  if (!ok) failures.push(name);
};

(async () => {
  const { UPDATE_KINDS, runtimeVersionOf, updateKind } = await import(tmp);

  check('a patch bump is JS-deliverable', updateKind('1.0.5', '1.0.6') === UPDATE_KINDS.JS);
  check('several patches still are', updateKind('1.0.0', '1.0.99') === UPDATE_KINDS.JS);
  check('a minor bump needs the APK', updateKind('1.0.9', '1.1.0') === UPDATE_KINDS.NATIVE);
  check('so does a major bump', updateKind('1.49.99', '2.0.0') === UPDATE_KINDS.NATIVE);
  check('and a jump across minors', updateKind('1.0.1', '1.4.0') === UPDATE_KINDS.NATIVE);

  // Direction is deliberately not this function's business.
  check('a downgrade is classified, not judged', updateKind('1.0.6', '1.0.5') === UPDATE_KINDS.JS);

  check('runtime of 1.0.6 is 1.0', runtimeVersionOf('1.0.6') === '1.0');
  check('runtime of 2.13.4 is 2.13', runtimeVersionOf('2.13.4') === '2.13');
  check('a two-part version still resolves', runtimeVersionOf('1.2') === '1.2');

  check('garbage in, null out', runtimeVersionOf('nonsense') === null);
  check('missing minor is null', runtimeVersionOf('1') === null);
  check('empty is null', runtimeVersionOf('') === null);
  check('unknown versions cannot be classified', updateKind(null, '1.0.6') === null);
  check('nor can an unknown release', updateKind('1.0.6', undefined) === null);

  console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
})();
