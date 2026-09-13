/**
 * Writing results back to the spreadsheet.
 *
 * Four rules, each of which exists because of a specific way this goes wrong:
 *
 *   1. The tool owns four columns and writes nowhere else. `PHOTO Status` is
 *      the photographer's, `Update in Shopify Archy` is the owner's. If they are
 *      missing, we append them to the header rather than assuming a position.
 *
 *   2. Rows are located by SKU in a *fresh* read taken at write time, never by
 *      a row number remembered from the start of the run. A run takes minutes
 *      and the owner may sort, filter or insert rows while it goes; writing by
 *      remembered index would put one stone's result on another stone's row.
 *
 *   3. A cell that records the product being in Shopify is never overwritten by
 *      a weaker outcome. Otherwise a product created last week whose photos
 *      have since been moved would be quietly relabelled "not ready", losing
 *      the only record that it exists.
 *
 *   4. Values that begin with =, +, - or @ are prefixed with an apostrophe, so
 *      a note can never be interpreted as a formula.
 */

import { sheets as sheetsApi } from '@googleapis/sheets';
import type { OAuth2Client } from 'google-auth-library';
import { normaliseSku } from '../domain/filenames.js';
import { normaliseHeader } from './rows.js';
import type { ProductResult, ResultStatus } from '../run/report.js';

/** The columns this tool owns. Nothing else in the sheet is ever written. */
export const OWNED_COLUMNS = [
  'Shopify Status',
  'Shopify Product',
  'Uploaded At',
  'Notes',
] as const;

/** Statuses meaning "this SKU is in Shopify". Never downgraded by a later run. */
const TERMINAL = new Set(['CREATED', 'PARTIAL', 'EXISTS']);

/** Outcomes that say nothing worth recording — the row is just unfinished. */
const QUIET = new Set<ResultStatus>(['skipped', 'would-create']);

export type WriteDecision =
  /** Leave the cell alone: it records a product in Shopify. */
  | 'preserve'
  /** Blank the row's four cells: a note from an earlier run no longer applies. */
  | 'clear'
  /** Write the new values. */
  | 'write'
  /** Nothing to say and nothing there — leave it blank. */
  | 'ignore';

/**
 * What to do with one row, given what its status cell already says.
 *
 * Three rules meet here:
 *
 *   - A cell recording that the product is in Shopify is never downgraded. A
 *     product created last week whose photos have since been moved would come
 *     back as "not ready", and overwriting would destroy the only record in the
 *     sheet that it exists.
 *   - Rows that are merely unfinished are left blank. A column that says
 *     something on all 144 rows says nothing, and trains people to ignore it.
 *   - But an unfinished row still carrying an old note is cleared, so
 *     "NEEDS FIXING" doesn't linger after the problem has been fixed.
 */
export function decideWrite(existingCell: string, incoming: ResultStatus): WriteDecision {
  const existing = existingCell.trim().toUpperCase();

  if (TERMINAL.has(existing) && !TERMINAL.has(STATUS_TEXT[incoming])) return 'preserve';
  if (!QUIET.has(incoming)) return 'write';
  return existing === '' ? 'ignore' : 'clear';
}

const STATUS_TEXT: Record<ResultStatus, string> = {
  created: 'CREATED',
  partial: 'PARTIAL',
  exists: 'EXISTS',
  failed: 'FAILED',
  invalid: 'NEEDS FIXING',
  skipped: 'NOT READY',
  'would-create': 'READY TO UPLOAD',
};

export interface WriteBackResult {
  updated: number;
  /** Results whose SKU is no longer in the sheet — renamed or deleted mid-run. */
  notFound: string[];
  /** Rows left alone because they already record a product in Shopify. */
  preserved: number;
  addedColumns: string[];
}

function columnLetter(index: number): string {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

/** Stops a note or URL being read as a formula. */
function safe(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function existingStatus(grid: string[][], rowNumber: number, column: number): string {
  return (grid[rowNumber - 1]?.[column] ?? '').trim();
}

function timestamp(): string {
  // Sortable, and reads naturally in a spreadsheet: "2026-09-09 08:14:03".
  return new Date().toLocaleString('sv-SE');
}

function noteFor(result: ProductResult): string {
  const parts: string[] = [];
  if (result.detail) parts.push(result.detail);
  if (result.photos && result.photos.total > 0) {
    parts.push(`${result.photos.ready}/${result.photos.total} photos`);
  }
  parts.push(...(result.warnings ?? []));
  return parts.join(' · ');
}

export async function writeResults(
  auth: OAuth2Client,
  spreadsheetId: string,
  tab: string,
  results: ProductResult[],
): Promise<WriteBackResult> {
  const sheets = sheetsApi({ version: 'v4', auth });

  // Rule 2: a fresh read, now, not the one the run started from.
  const current = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A:ZZ`,
  });
  const grid = (current.data.values ?? []) as string[][];
  const header = grid[0] ?? [];

  // Rule 1: find our columns, appending any that are missing.
  const normalised = header.map(normaliseHeader);
  const columnIndex = new Map<string, number>();
  const addedColumns: string[] = [];
  let nextFree = header.length;

  for (const name of OWNED_COLUMNS) {
    const at = normalised.indexOf(normaliseHeader(name));
    if (at >= 0) {
      columnIndex.set(name, at);
    } else {
      columnIndex.set(name, nextFree);
      addedColumns.push(name);
      nextFree += 1;
    }
  }

  const updates: { range: string; values: string[][] }[] = [];

  if (addedColumns.length > 0) {
    const row = [...header];
    for (const name of addedColumns) row[columnIndex.get(name)!] = name;
    updates.push({
      range: `${tab}!A1:${columnLetter(row.length - 1)}1`,
      values: [row],
    });
  }

  // SKU -> 1-based sheet row, from the fresh read.
  const skuColumn = normalised.findIndex((h) => h === 'sku');
  if (skuColumn < 0) throw new Error('no SKU column in the sheet, so results cannot be written back');

  // A SKU maps to every row carrying it, not just the first. Duplicates are
  // refused upstream, but both rows still need to say why — otherwise the
  // second one is blank and the person fixing it has no idea it is involved.
  const rowsBySku = new Map<string, number[]>();
  for (let i = 1; i < grid.length; i += 1) {
    const sku = normaliseSku(grid[i]?.[skuColumn] ?? '');
    if (sku === '') continue;
    const rows = rowsBySku.get(sku);
    if (rows) rows.push(i + 1);
    else rowsBySku.set(sku, [i + 1]);
  }

  const statusColumn = columnIndex.get('Shopify Status')!;
  const positions = OWNED_COLUMNS.map((name) => columnIndex.get(name)!);
  const contiguous = positions.every((at, i) => i === 0 || at === positions[i - 1]! + 1);

  const notFound: string[] = [];
  let preserved = 0;

  const written = new Set<number>();

  for (const result of results) {
    const sku = normaliseSku(result.sku);
    const rows = rowsBySku.get(sku);

    if (!rows || rows.length === 0) {
      notFound.push(result.sku);
      continue;
    }

    for (const rowNumber of rows) {
      // Two results sharing a SKU would otherwise write the same rows twice.
      if (written.has(rowNumber)) continue;

      const decision = decideWrite(existingStatus(grid, rowNumber, statusColumn), result.status);

      if (decision === 'preserve') {
        preserved += 1;
        continue;
      }
      if (decision === 'ignore') continue;

      written.add(rowNumber);

      const cells = decision === 'clear'
        ? ['', '', '', '']
        : [
            STATUS_TEXT[result.status],
            result.adminUrl ?? '',
            result.status === 'created' || result.status === 'partial' ? timestamp() : '',
            noteFor(result),
          ].map(safe);

      if (contiguous) {
        // The common case: our four columns sit side by side, so one range per
        // row instead of four. On a 144-row sheet that is 144 ranges, not 576.
        const first = columnIndex.get(OWNED_COLUMNS[0])!;
        updates.push({
          range: `${tab}!${columnLetter(first)}${rowNumber}:${columnLetter(first + 3)}${rowNumber}`,
          values: [cells],
        });
      } else {
        OWNED_COLUMNS.forEach((name, i) => {
          const letter = columnLetter(columnIndex.get(name)!);
          updates.push({ range: `${tab}!${letter}${rowNumber}`, values: [[cells[i]!]] });
        });
      }
    }
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        // USER_ENTERED so the product URL becomes a clickable link. Rule 4
        // guards against anything being read as a formula.
        valueInputOption: 'USER_ENTERED',
        data: updates,
      },
    });
  }

  return {
    // Rows actually touched, which is not the same as results: a duplicated SKU
    // annotates two rows, and preserved rows are touched none.
    updated: written.size,
    notFound,
    preserved,
    addedColumns,
  };
}
