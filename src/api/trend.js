/**
 * Chart data for the Dashboard, from whichever server endpoint can actually
 * answer for the window being asked about.
 *
 * `sensor_dashboard` returns every measure in one request and accepts a bucket
 * width in minutes, which is ideal for a single day. But for any window of two
 * days or more it stops reading raw readings and reads a pre-computed hourly
 * rollup table (`__sensor_reading_hourly`) instead. That table is maintained by
 * an hourly scheduled job, and where the job has never run it is simply empty —
 * so the query succeeds, returns no rows, and the chart says "no readings in
 * this range" while the raw readings sit there untouched. That is exactly what
 * the 7, 30 and 60 day ranges were doing.
 *
 * `get_chart_series` always reads the raw table, at hourly or daily resolution.
 * It costs one request per measure, which is why it isn't used for everything —
 * but for the wide ranges it is the only one that answers, and it is the same
 * source the desk dashboards read.
 */

import { getChartSeries, getSensorDashboard } from './endpoints';
import { isPlottable } from '../utils/measures';

/**
 * Windows of this many days or more are served from the rollup by
 * `sensor_dashboard`, so they go to `get_chart_series` instead. Mirrors
 * `ROLLUP_THRESHOLD_DAYS` in `upande_sensors/api/sensor_dashboard.py`.
 */
export const ROLLUP_SPAN_DAYS = 2;

/** Measures to ask for when the tab config lists none. */
export const DEFAULT_MEASURES = ['Temperature', 'Humidity', 'Soil Moisture', 'Soil Temperature'];

const pad = (n) => String(n).padStart(2, '0');

/**
 * The bucket timestamps `get_chart_series` will have used, rebuilt locally.
 *
 * The endpoint returns display labels ("09-08 14:00", "09-Aug") rather than
 * timestamps — no year, and nothing that can be compared against the clock. It
 * does fill the grid densely from `date_from` 00:00 to the end of `date_to`, so
 * the same grid can be regenerated here and used instead: it carries the year,
 * and it lets future buckets be trimmed like every other series.
 *
 * Stepped in UTC deliberately. These are calendar positions, not instants, and
 * local arithmetic would drop or repeat an hour across a DST boundary — putting
 * every later value one place out.
 */
export function bucketStamps(dateFrom, dateTo, interval) {
  const start = Date.parse(`${dateFrom}T00:00:00Z`);
  const end = Date.parse(`${dateTo}T23:59:59Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];

  const step = interval === 'hourly' ? 3600000 : 86400000;
  const out = [];
  for (let at = start; at <= end; at += step) {
    const d = new Date(at);
    out.push(
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
        `${pad(d.getUTCHours())}:00:00`,
    );
  }
  return out;
}

/** Shared shape both paths return: one label axis, one series per measure. */
function empty() {
  return { labels: [], series: [] };
}

/**
 * One request, every measure, bucketed by minutes. For a single day.
 *
 * Buckets a measure has no reading for stay null rather than 0, so a gap breaks
 * the line instead of being drawn as a measured zero.
 */
export async function fetchBucketedTrend(
  { site, sensorName, dateFrom, dateTo, bucketMins },
  signal,
) {
  const data = await getSensorDashboard({ dateFrom, dateTo, site, sensorName, bucketMins }, signal);
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
 * One request per measure, from raw readings. For everything wider than a day.
 *
 * The requests go out together rather than in sequence — each round trip to the
 * instance costs about a second, so four in series would be four seconds of
 * staring at a skeleton.
 *
 * A measure that fails or returns nothing is dropped rather than failing the
 * chart: sites don't all report the same parameters, and asking for soil
 * moisture where there is no soil probe is normal.
 */
export async function fetchSeriesTrend(
  { site, sensorName, tabTag, measures, dateFrom, dateTo, interval },
  signal,
) {
  const wanted = (measures?.length ? measures : DEFAULT_MEASURES).filter(isPlottable);
  if (!wanted.length) return empty();

  const answers = await Promise.all(
    wanted.map((sensorType) =>
      getChartSeries(
        { sensorType, site, sensorName, dateFrom, dateTo, interval, tabTag },
        signal,
      ).catch(() => null),
    ),
  );

  const usable = answers
    .map((res, i) => ({ label: wanted[i], res }))
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

  // Every measure is asked for over the same window at the same resolution, so
  // the grids match. Anything that doesn't is dropped rather than zipped
  // against the wrong instants.
  const width = usable[0].res.values.length;
  const aligned = usable.filter((x) => x.res.values.length === width);

  const stamps = bucketStamps(dateFrom, dateTo, interval);
  // Fall back to the endpoint's own labels if the grid doesn't line up — less
  // readable, still correct.
  const labels = stamps.length === width ? stamps : aligned[0].res.labels.slice(0, width);

  return { labels, series: aligned.map((x) => ({ label: x.label, values: x.res.values })) };
}
