import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
// The prebuilt browser bundle, not the package entry: the latter conditionally
// requires `fs` and `stream`, which Metro tries to resolve and fails on.
import * as XLSX from 'xlsx/dist/xlsx.full.min.js';

import { getSensorReadings } from '../api/endpoints';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Rows fetched per request while assembling an export. */
const BATCH = 500;

/**
 * Upper bound on an export.
 *
 * The reading table runs to hundreds of thousands of rows; pulling all of them
 * over a ~1s-per-request link would take minutes and produce a file no phone
 * wants to open. Hitting the cap is reported back to the caller so the UI can
 * say the export was truncated instead of quietly handing over a partial file.
 */
const MAX_ROWS = 20000;

/**
 * Build a real .xlsx workbook.
 *
 * Values are written as numbers, not strings, so Excel can chart and aggregate
 * them without the user retyping the column. Timestamps stay as the server's
 * own text — converting to an Excel serial date would silently reinterpret a
 * naive server timestamp in whatever timezone the spreadsheet is opened in.
 */
function toWorkbook(rows) {
  const sheet = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      Sensor: r.sensor_name ?? '',
      Type: r.sensor_type ?? '',
      Timestamp: r.timestamp ?? '',
      // `Number(null)` is 0 and 0 is finite, so a null/blank reading would
      // export as a measured zero. Reject the empty cases before coercing.
      Value:
        r.value === null || r.value === undefined || r.value === '' || !Number.isFinite(Number(r.value))
          ? ''
          : Number(r.value),
    })),
    { header: ['Sensor', 'Type', 'Timestamp', 'Value'] },
  );

  sheet['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 20 }, { wch: 12 }];
  // Freeze the header so a long export stays readable while scrolling.
  sheet['!freeze'] = { xSplit: 0, ySplit: 1 };

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Readings');
  return book;
}

function safeName(site, dateFrom, dateTo) {
  const slug = String(site || 'all-sites')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return `readings-${slug}-${dateFrom}-to-${dateTo}.xlsx`;
}

/**
 * Export every reading matching the current filters as .xlsx and hand it to the share
 * sheet. Returns `{ shared, rows, truncated, total, fileName }`.
 *
 * Exports the whole filtered set, not the page on screen — a button labelled
 * "export" that produced only the visible 50 rows of 12,000 would be a trap.
 * `onProgress(rowsSoFar)` is called after each batch so the caller can show
 * movement on a long pull.
 */
export async function exportReadingsToExcel(filters, { onProgress } = {}) {
  const rows = [];

  for (;;) {
    const batch = await getSensorReadings({
      ...filters,
      start: rows.length,
      pageLength: Math.min(BATCH, MAX_ROWS - rows.length),
    });
    const list = Array.isArray(batch) ? batch : [];
    rows.push(...list);
    onProgress?.(rows.length);

    if (list.length < BATCH) break; // last page
    if (rows.length >= MAX_ROWS) break;
  }

  if (!rows.length) return { shared: false, rows: 0, truncated: false };

  const fileName = safeName(filters.site, filters.dateFrom, filters.dateTo);
  const file = new File(Paths.cache, fileName);
  // The cache directory survives between runs, so an earlier export with the
  // same filters would still be sitting there.
  try {
    file.create({ overwrite: true });
  } catch {
    // create() throws if it already exists on some platforms; write() below
    // replaces the contents either way.
  }

  // 'array' gives an ArrayBuffer of the real zipped xlsx; writing it as bytes
  // keeps it a valid workbook. Writing it as a string would corrupt the zip.
  const buffer = XLSX.write(toWorkbook(rows), { type: 'array', bookType: 'xlsx' });
  file.write(new Uint8Array(buffer));

  const canShare = await Sharing.isAvailableAsync();
  if (!canShare) {
    return {
      shared: false,
      rows: rows.length,
      truncated: rows.length >= MAX_ROWS,
      fileName,
      uri: file.uri,
    };
  }

  await Sharing.shareAsync(file.uri, {
    mimeType: XLSX_MIME,
    dialogTitle: 'Export sensor readings',
    UTI: 'org.openxmlformats.spreadsheetml.sheet',
  });

  return {
    shared: true,
    rows: rows.length,
    truncated: rows.length >= MAX_ROWS,
    fileName,
    uri: file.uri,
  };
}

export { MAX_ROWS };
