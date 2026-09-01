/**
 * Chart data for the Charts screen, from one request.
 *
 * This used to pick between two server endpoints, and both were wrong in a way
 * that showed:
 *
 *  * `sensor_dashboard` returned every measure in one request and accepted a
 *    bucket width in minutes, which is ideal for a single day. But for any
 *    window of two days or more it stopped reading raw readings and read a
 *    pre-computed hourly rollup (`__sensor_reading_hourly`) instead. That table
 *    is maintained by an hourly scheduled job, and where the job has never run
 *    it is simply empty — so the query succeeded, returned no rows, and the
 *    chart said "no readings in this range" while the raw readings sat there
 *    untouched. That is exactly what the 7, 30 and 60 day ranges did.
 *
 *  * `get_chart_series` always read the raw table, so it answered the wide
 *    ranges — but at one request per measure, and it returned display labels
 *    ("09-08 14:00", "09-Aug") carrying no year and nothing comparable against
 *    a clock. The grid had to be regenerated here and the values zipped back on
 *    by index, which is only correct while every measure reports on exactly the
 *    same cadence.
 *
 * `upande_sensors_app.chart_series` replaces both: raw readings at every width,
 * every measure in one request, and each point carrying its own ISO timestamp so
 * values are placed on the axis by instant rather than by position.
 *
 * The two functions below are kept apart because they ask for different
 * resolutions, not different endpoints — minute buckets for a day, calendar
 * buckets for anything wider.
 */

import {
  FrappeError,
  getChartSeries,
  getLegacyChartSeries,
  getLegacySensorDashboard,
} from './endpoints';
import { isPlottable } from '../utils/measures';

/**
 * Windows of this many days or more are charted at calendar resolution rather
 * than in minute buckets. The name is historical: it used to be the width at
 * which the server switched to its rollup table, which is no longer read at all.
 */
export const ROLLUP_SPAN_DAYS = 2;

/** Measures to ask for when the tab config lists none. */
export const DEFAULT_MEASURES = ['Temperature', 'Humidity', 'Soil Moisture', 'Soil Temperature'];

const pad = (n) => String(n).padStart(2, '0');

/**
 * A dense bucket grid for the window, as ISO timestamps.
 *
 * Gaps are drawn as gaps: with a sparse axis a week of missing readings would be
 * squeezed into the space of one bucket and the line either side would join up
 * as though nothing were missing.
 *
 * Stepped in UTC deliberately. These are calendar positions, not instants, and
 * local arithmetic would drop or repeat an hour across a DST boundary — putting
 * every later value one place out.
 */
export function bucketStamps(dateFrom, dateTo, interval) {
  if (interval !== 'hourly' && interval !== 'daily') return [];

  const start = Date.parse(`${dateFrom}T00:00:00Z`);
  const end = Date.parse(`${dateTo}T23:59:59Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];

  const step = interval === 'hourly' ? 3600000 : 86400000;
  const out = [];
  for (let at = start; at <= end; at += step) {
    const d = new Date(at);
    const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    out.push(interval === 'hourly' ? `${day} ${pad(d.getUTCHours())}:00:00` : day);
  }
  return out;
}

/** Shared shape both paths return: one label axis, one series per measure. */
function empty() {
  return { labels: [], series: [] };
}

/**
 * Turn the endpoint's sparse per-measure points into the label axis plus
 * parallel value arrays the chart draws.
 *
 * A bucket a measure has no reading for stays null rather than 0, so a gap
 * breaks the line instead of being drawn as a measured zero. Measures reporting
 * nothing at all are dropped — sites don't all carry the same probes, and an
 * empty line in the legend with an empty tile above it says nothing.
 */
function toLabelledSeries(payload, { dateFrom, dateTo } = {}) {
  const rows = Array.isArray(payload?.series) ? payload.series : [];
  const usable = rows.filter((s) => s?.points?.length && isPlottable(s.type));
  if (!usable.length) return empty();

  // A dense grid where the interval defines one, otherwise the buckets that
  // actually came back. `payload.interval` is the interval the server used,
  // which is not always the one asked for — weekly is served as daily.
  let labels = dateFrom && dateTo ? bucketStamps(dateFrom, dateTo, payload?.interval) : [];
  if (!labels.length) {
    const seen = new Set();
    usable.forEach((s) => s.points.forEach((p) => seen.add(String(p[0] || ''))));
    labels = [...seen].filter(Boolean).sort();
  }
  if (!labels.length) return empty();

  const position = new Map(labels.map((label, i) => [label, i]));

  const series = [];
  usable.forEach((s) => {
    const values = new Array(labels.length).fill(null);
    let placed = 0;
    s.points.forEach((point) => {
      const at = position.get(String(point[0] || ''));
      if (at !== undefined) {
        values[at] = point[1];
        placed += 1;
      }
    });
    // A measure whose buckets landed nowhere on this axis is a mismatch, not
    // data — dropping it is better than drawing a flat line of nulls.
    if (placed) series.push({ label: s.type, values });
  });

  return series.length ? { labels, series } : empty();
}

/**
 * Every measure the site reported, in minute buckets. For a single day.
 *
 * No measure list is sent: the endpoint charts whatever the window contains,
 * which is what the Dashboard's day view has always shown.
 */
export async function fetchBucketedTrend({ site, sensorName, dateFrom, dateTo, bucketMins }, signal) {
  try {
    const payload = await getChartSeries(
      { site, sensorName, dateFrom, dateTo, bucketMins, sensorTypes: [] },
      signal,
    );
    // Minute buckets are left sparse: a day's grid at 30-minute resolution is 48
    // slots, and the buckets that reported are the axis.
    return toLabelledSeries(payload);
  } catch (err) {
    if (!missingEndpoint(err)) throw err;
    return legacyBucketedTrend({ site, sensorName, dateFrom, dateTo, bucketMins }, signal);
  }
}

/**
 * The configured measures, at calendar resolution. For anything wider than a day.
 */
export async function fetchSeriesTrend(
  { site, sensorName, tabTag, measures, dateFrom, dateTo, interval },
  signal,
) {
  const wanted = (measures?.length ? measures : DEFAULT_MEASURES).filter(isPlottable);
  if (!wanted.length) return empty();

  try {
    const payload = await getChartSeries(
      { site, sensorName, tabTag, sensorTypes: wanted, dateFrom, dateTo, interval },
      signal,
    );
    return toLabelledSeries(payload, { dateFrom, dateTo });
  } catch (err) {
    if (!missingEndpoint(err)) throw err;
    return legacySeriesTrend(
      { site, sensorName, tabTag, measures: wanted, dateFrom, dateTo, interval },
      signal,
    );
  }
}

/* ── Fallbacks ───────────────────────────────────────────────────────────── */

/**
 * Everything below serves an instance that has not had
 * `upande_sensors_app.chart_series` deployed: an APK in the field must not lose
 * its charts because the site it points at is behind the client.
 *
 * Only "Failed to get method for command" routes here. A permission refusal is
 * the server answering the question, and retrying it against an older endpoint
 * would replace a clear refusal with whatever that one happened to return.
 */
function missingEndpoint(err) {
  return err instanceof FrappeError && err.isMissingEndpoint;
}

/** The old all-measures bucketed endpoint, which reads a rollup past two days. */
async function legacyBucketedTrend({ site, sensorName, dateFrom, dateTo, bucketMins }, signal) {
  const data = await getLegacySensorDashboard(
    { dateFrom, dateTo, site, sensorName, bucketMins },
    signal,
  );
  const rows = Array.isArray(data?.trend) ? data.trend : [];
  if (!rows.length) return empty();

  const labels = [...new Set(rows.map((r) => String(r.timestamp || '')).filter(Boolean))].sort();
  const position = new Map(labels.map((l, i) => [l, i]));

  const byType = new Map();
  rows.forEach((r) => {
    const label = String(r.sensor_type || '').trim();
    if (!label || !isPlottable(label)) return;
    if (!byType.has(label)) byType.set(label, new Array(labels.length).fill(null));
    const at = position.get(String(r.timestamp || ''));
    if (at !== undefined) byType.get(label)[at] = r.value;
  });

  return { labels, series: [...byType.entries()].map(([label, values]) => ({ label, values })) };
}

/**
 * The old per-measure endpoint: one request each, values aligned to a locally
 * rebuilt grid by index, because the response carried display labels with no
 * year in them.
 *
 * A measure that fails or returns nothing is dropped rather than failing the
 * chart: sites don't all report the same parameters, and asking for soil
 * moisture where there is no soil probe is normal.
 */
async function legacySeriesTrend(
  { site, sensorName, tabTag, measures, dateFrom, dateTo, interval },
  signal,
) {
  const answers = await Promise.all(
    measures.map((sensorType) =>
      getLegacyChartSeries(
        { sensorType, site, sensorName, dateFrom, dateTo, interval, tabTag },
        signal,
      ).catch(() => null),
    ),
  );

  const usable = answers
    .map((res, i) => ({ label: measures[i], res }))
    .filter(
      (x) =>
        x.res &&
        Array.isArray(x.res.values) &&
        // A measure this site doesn't report comes back as a full-width row of
        // nulls. Keeping it would put an empty line in the legend and an empty
        // tile above the chart.
        x.res.values.some((v) => v !== null && v !== undefined && v !== ''),
    );
  if (!usable.length) return empty();

  // Every measure was asked for over the same window at the same resolution, so
  // the grids match. Anything that doesn't is dropped rather than zipped against
  // the wrong instants.
  const width = usable[0].res.values.length;
  const aligned = usable.filter((x) => x.res.values.length === width);

  const stamps = bucketStamps(dateFrom, dateTo, interval);
  // Fall back to the endpoint's own labels if the grid doesn't line up — less
  // readable, still correct.
  const labels = stamps.length === width ? stamps : aligned[0].res.labels.slice(0, width);

  return { labels, series: aligned.map((x) => ({ label: x.label, values: x.res.values })) };
}
