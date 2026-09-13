/**
 * Step 1: prove we can read the spreadsheet.
 *
 * Prints the tab names, the header row, and the first few data rows exactly as
 * Google returns them. No parsing, no interpretation — the point is to see the
 * real data before writing anything that depends on its shape.
 *
 *   npx tsx src/scripts/read-sheet.ts
 */

import '../bootstrap.js';

import { sheets as sheetsApi } from '@googleapis/sheets';
import { loadAuth } from '../google/auth.js';

const ROWS_TO_SHOW = 5;

async function main(): Promise<void> {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID is not set in .env');

  const sheets = sheetsApi({ version: 'v4', auth: await loadAuth() });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const tabs = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? '(unnamed)');

  console.log(`\nSpreadsheet: ${meta.data.properties?.title ?? '(untitled)'}`);
  console.log(`Tabs:        ${tabs.join(', ')}\n`);

  const tab = process.env.GOOGLE_SHEET_TAB || tabs[0];
  if (!tab) throw new Error('the spreadsheet has no tabs');

  const values = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${tab}!A1:Z${ROWS_TO_SHOW + 1}`,
  });

  const rows = values.data.values ?? [];
  if (rows.length === 0) {
    console.log(`Tab "${tab}" is empty.`);
    return;
  }

  const [header, ...data] = rows;

  console.log(`Reading tab "${tab}"`);
  console.log(`\nHeader row — ${header!.length} columns:\n`);
  header!.forEach((name, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${columnLetter(i)}  ${JSON.stringify(name)}`);
  });

  console.log(`\nFirst ${Math.min(data.length, ROWS_TO_SHOW)} data rows:\n`);
  data.slice(0, ROWS_TO_SHOW).forEach((row, i) => {
    console.log(`  Row ${i + 2}:`);
    header!.forEach((name, col) => {
      const cell = row[col];
      if (cell === undefined || cell === '') return;
      console.log(`      ${String(name).padEnd(28)} ${JSON.stringify(cell)}`);
    });
    console.log('');
  });
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

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
