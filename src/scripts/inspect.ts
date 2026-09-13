/**
 * Prints the distinct values in a column, with counts.
 *
 * For looking at what is really in the sheet before writing rules about it.
 *
 *   npx tsx src/scripts/inspect.ts stoneName
 *   npx tsx src/scripts/inspect.ts productType
 *   npx tsx src/scripts/inspect.ts sku --raw
 */

import '../bootstrap.js';

import { readSheet } from '../google/sheets.js';
import { loadAuth } from '../google/auth.js';
import type { SheetRow } from '../domain/types.js';

async function main(): Promise<void> {
  const field = (process.argv[2] ?? 'stoneName') as keyof SheetRow;
  const raw = process.argv.includes('--raw');

  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID is not set in .env');

  const sheet = await readSheet(await loadAuth(), sheetId, process.env.GOOGLE_SHEET_TAB ?? '');

  const counts = new Map<string, number>();
  for (const row of sheet.rows) {
    const value = String(row[field] ?? '').trim();
    if (value === '') continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) =>
    raw ? a[0].localeCompare(b[0]) : b[1] - a[1] || a[0].localeCompare(b[0]),
  );

  console.log(`\n${field}: ${sorted.length} distinct values across ${sheet.rows.length} rows\n`);
  for (const [value, count] of sorted) {
    console.log(`${String(count).padStart(4)}  ${JSON.stringify(value)}`);
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
