/**
 * The coordinate arithmetic behind the location capture and the map.
 *
 *   node tests/geo.test.js        (from the app directory)
 *
 * What is pinned: the accuracy scale the screen documents (±3 m = 100 %,
 * ±50 m = 0 %), that a sharp fix outweighs a vague one in the running
 * position, that 0,0 is "not set", and that the overwrite distance is right.
 * The scale in particular is a promise made on screen in words, so a change to
 * the constants has to change the words too — this fails until it does.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// geo.js has no imports, so the whole file loads as an ES module once copied
// to a .mjs path — the real source, not a lifted copy of one function.
const src = fs.readFileSync('src/utils/geo.js', 'utf8');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'geo-')), 'geo.mjs');
fs.writeFileSync(tmp, src);

const failures = [];
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  if (!ok) failures.push(name);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  const geo = await import(tmp);

  // The documented scale.
  check('±3 m is 100 %', geo.accuracyPercent(3) === 100);
  check('sharper than 3 m is still 100 %', geo.accuracyPercent(1) === 100);
  check('±50 m is 0 %', geo.accuracyPercent(50) === 0);
  check('vaguer than 50 m is still 0 %', geo.accuracyPercent(120) === 0);
  check('the midpoint of the scale is 50 %', geo.accuracyPercent(26.5) === 50);
  check('no accuracy is no percentage, not 100 %', geo.accuracyPercent(undefined) === null);
  check('a negative accuracy is no percentage', geo.accuracyPercent(-1) === null);
  check('the constants match the words on screen', geo.ACCURACY_FULL_M === 3 && geo.ACCURACY_ZERO_M === 50);

  // Inverse-variance weighting.
  {
    const sharp = { latitude: -1.2921, longitude: 36.8219, accuracy: 2 };
    const vague = { latitude: -1.2931, longitude: 36.8229, accuracy: 20 };
    const out = geo.weightedPosition([sharp, vague]);
    check('two fixes are two samples', out.samples === 2);
    // Weights are 1/4 and 1/400: the sharp fix is 99 % of the answer.
    check(
      'the sharp fix carries the position',
      near(out.latitude, sharp.latitude, 0.00002) && near(out.longitude, sharp.longitude, 0.00002),
    );
    check('the reported accuracy is the weighted mean, not the sharpest', near(out.accuracy, 2.18, 0.01));
    const plain = geo.weightedPosition([sharp, { ...sharp, latitude: -1.2923, accuracy: 2 }]);
    check('equal accuracies average plainly', near(plain.latitude, -1.2922, 1e-9));
  }
  check('no fixes is null', geo.weightedPosition([]) === null);
  check(
    'a fix with no accuracy is skipped, not fatal',
    geo.weightedPosition([{ latitude: 1, longitude: 1 }, { latitude: 2, longitude: 2, accuracy: 5 }]).samples === 1,
  );
  check(
    'a 0 m fix does not swallow the average',
    near(
      geo.weightedPosition([
        { latitude: 0.001, longitude: 0, accuracy: 0 },
        { latitude: 0.002, longitude: 0, accuracy: 0.5 },
      ]).latitude,
      0.0015,
      1e-9,
    ),
  );

  // Distance.
  {
    const nairobi = { latitude: -1.2921, longitude: 36.8219 };
    const mombasa = { latitude: -4.0435, longitude: 39.6682 };
    const km = geo.haversineMetres(nairobi, mombasa) / 1000;
    check('Nairobi to Mombasa is about 440 km', near(km, 440, 5));
    check('a point to itself is 0', geo.haversineMetres(nairobi, nairobi) === 0);
    const step = geo.haversineMetres(nairobi, { latitude: -1.2921 + 0.0001, longitude: 36.8219 });
    check('a ten-thousandth of a degree of latitude is ~11 m', near(step, 11.1, 0.2));
    check('a missing point is null, not NaN', geo.haversineMetres(nairobi, null) === null);
  }

  // Not set.
  check('0,0 is not a position', geo.hasCoordinates({ latitude: 0, longitude: 0 }) === false);
  check('null is not a position', geo.hasCoordinates({ latitude: null, longitude: 36 }) === false);
  check('a real pair is', geo.hasCoordinates({ latitude: -1.34, longitude: 36.78 }) === true);
  check('0 latitude alone is still a position', geo.hasCoordinates({ latitude: 0, longitude: 36.78 }) === true);

  // Labels.
  check('coordinates print to five places', geo.formatCoordinates(-1.2921, 36.8219) === '-1.29210, 36.82190');
  check('metres under 10 keep a decimal', geo.formatMetres(4.25) === '±4.3 m');
  check('metres over 10 round', geo.formatMetres(12.6) === '±13 m');
  check('a kilometre reads as one', geo.formatMetres(1234) === '±1.2 km');
  check('an unknown accuracy has no label', geo.formatMetres(null) === null);

  console.log(failures.length ? `\n${failures.length} FAILED` : '\nall passed');
  process.exit(failures.length ? 1 : 0);
})();
