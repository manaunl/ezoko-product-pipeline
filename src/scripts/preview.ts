/**
 * Show exactly what would be created, without creating anything.
 *
 * Reads the sheet and the photo folder, matches them up, and prints the
 * resolved product for every row. Nothing is written to Shopify, nothing is
 * written back to the sheet.
 *
 *   npx tsx src/scripts/preview.ts           # only rows whose photos exist
 *   npx tsx src/scripts/preview.ts --all     # validate every row regardless
 *   npx tsx src/scripts/preview.ts --quiet   # summary and problems only
 */

import '../bootstrap.js';

import { buildSpecParts } from '../domain/spec.js';
import { loadDescriptionAliases } from '../domain/descriptions.js';
import { claimedSku, indexPhotos, normaliseSku } from '../domain/filenames.js';
import { findDuplicateSkus, rowToOutcome } from '../domain/mapping.js';
import { formatHuf } from '../domain/numbers.js';
import { listPhotoFiles } from '../google/drive.js';
import { readSheet } from '../google/sheets.js';
import { loadAuth } from '../google/auth.js';
import { fetchDescriptionCatalogue } from '../storefront/feed.js';
import { toPlainText } from '../domain/descriptions.js';
import type { RowOutcome } from '../domain/types.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const OFF = '\x1b[0m';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

function printReady(outcome: Extract<RowOutcome, { kind: 'ready' }>): void {
  const { draft } = outcome;
  console.log(
    `${DIM}row ${String(outcome.rowNumber).padStart(3)}${OFF}  ${GREEN}CREATE${OFF}  ${BOLD}${draft.title}${OFF}`,
  );
  console.log(`            ${DIM}sku${OFF}    ${draft.displaySku}`);
  console.log(`            ${DIM}price${OFF}  ${formatHuf(draft.priceHuf)}`);
  console.log(
    `            ${DIM}specs${OFF}  ${buildSpecParts(draft).join(' · ') || `${DIM}(none)${OFF}`}`,
  );
  console.log(
    `            ${DIM}type${OFF}   ${draft.productType}   ${DIM}tags${OFF} ${draft.tags.join(', ')}`,
  );
  console.log(
    `            ${DIM}photos${OFF} ${draft.photos.length}  ${DIM}${draft.photos.map((p) => p.file.name).join(', ')}${OFF}`,
  );
  const body = toPlainText(draft.descriptionHtml).replace(/\n+/g, ' ');
  console.log(
    `            ${DIM}body${OFF}   ${
      body === '' ? `${RED}(empty — no published copy for this stone)${OFF}` : `${DIM}${body.slice(0, 90)}…${OFF}`
    }`,
  );
  for (const warning of draft.warnings) {
    console.log(`            ${YELLOW}!${OFF} ${warning}`);
  }
  console.log('');
}

/** Groups repeated reasons so 43 identical lines become one line saying 43. */
function printGrouped(title: string, colour: string, entries: [string, string[]][]): void {
  if (entries.length === 0) return;
  console.log(`${colour}${title}${OFF}`);
  for (const [reason, skus] of entries) {
    const shown = skus.length > 6 ? `${skus.slice(0, 6).join(', ')}, +${skus.length - 6} more` : skus.join(', ');
    console.log(`  ${String(skus.length).padStart(3)}  ${reason}`);
    console.log(`       ${DIM}${shown}${OFF}`);
  }
  console.log('');
}

function group(pairs: [string, string][]): [string, string[]][] {
  const map = new Map<string, string[]>();
  for (const [key, sku] of pairs) {
    const list = map.get(key);
    if (list) list.push(sku);
    else map.set(key, [sku]);
  }
  return [...map].sort((a, b) => b[1].length - a[1].length);
}

async function main(): Promise<void> {
  const validateAll = process.argv.includes('--all');
  const quiet = process.argv.includes('--quiet');
  const auth = await loadAuth();

  const sheet = await readSheet(auth, required('GOOGLE_SHEET_ID'), process.env.GOOGLE_SHEET_TAB ?? '');
  const files = await listPhotoFiles(auth, required('GOOGLE_DRIVE_FOLDER_ID'));
  const photos = indexPhotos(files);
  const descriptions = await fetchDescriptionCatalogue();

  if (sheet.columns.missingRequired.length > 0) {
    throw new Error(`these required columns were not found: ${sheet.columns.missingRequired.join(', ')}`);
  }

  const sheetSkus = new Set(sheet.rows.map((row) => normaliseSku(row.sku)).filter((sku) => sku !== ''));
  const relevantRejections = photos.rejected.filter((r) => sheetSkus.has(claimedSku(r.file.name)));

  const matchedCount = [...photos.bySku.values()].reduce((n, list) => n + list.length, 0);
  console.log(`\n${BOLD}Sheet${OFF}   ${sheet.title} → ${sheet.tab}   ${sheet.rows.length} rows`);
  if (sheet.columns.missingOptional.length > 0) {
    console.log(`        ${YELLOW}missing optional columns:${OFF} ${sheet.columns.missingOptional.join(', ')}`);
  }
  console.log(
    `${BOLD}Photos${OFF}  ${files.length} files → ${matchedCount} matched across ${photos.bySku.size} SKUs`,
  );
  console.log(
    `${BOLD}Copy${OFF}    ${descriptions.products} published products on ${descriptions.host} → ` +
      `${descriptions.catalogue.size} stones described`,
  );
  if (validateAll) {
    console.log(`${YELLOW}        --all: validating every row, ignoring whether photos exist${OFF}`);
  }
  console.log('');

  if (relevantRejections.length > 0) {
    printGrouped(
      'Rejected photo files for SKUs in this sheet',
      YELLOW,
      group(relevantRejections.map((r) => [r.reason, r.file.name])),
    );
  }

  const duplicateSkus = findDuplicateSkus(sheet.rows);
  const descriptionAliases = loadDescriptionAliases();
  const outcomes = sheet.rows.map((row) =>
    rowToOutcome(row, photos, {
      requirePhotos: !validateAll,
      duplicateSkus,
      descriptions: descriptions.catalogue,
      descriptionAliases,
    }),
  );

  const ready = outcomes.filter((o) => o.kind === 'ready') as Extract<RowOutcome, { kind: 'ready' }>[];
  const skipped = outcomes.filter((o) => o.kind === 'skipped') as Extract<RowOutcome, { kind: 'skipped' }>[];
  const invalid = outcomes.filter((o) => o.kind === 'invalid') as Extract<RowOutcome, { kind: 'invalid' }>[];

  if (!quiet) {
    for (const outcome of ready) printReady(outcome);
  }

  printGrouped(
    'Needs fixing before it can be created',
    RED,
    group(invalid.flatMap((o) => o.problems.map((p) => [p.message, o.sku] as [string, string]))),
  );

  printGrouped('Not ready yet', YELLOW, group(skipped.map((o) => [o.reason, o.sku])));

  const warnings = group(ready.flatMap((o) => o.draft.warnings.map((w) => [w, o.draft.displaySku] as [string, string])));
  printGrouped('Warnings on products that will still be created', YELLOW, warnings);

  const readySkus = new Set(ready.map((o) => o.draft.sku));
  const orphans = [...photos.bySku.keys()].filter((sku) => !readySkus.has(sku));
  if (orphans.length > 0) {
    console.log(`${YELLOW}Photos with no row ready to create${OFF}  ${orphans.join(', ')}\n`);
  }

  console.log(
    `${BOLD}Summary${OFF}  ${GREEN}${ready.length} to create${OFF}  ·  ${YELLOW}${skipped.length} not ready${OFF}  ·  ${RED}${invalid.length} need fixing${OFF}\n`,
  );
}

main().catch((error: unknown) => {
  console.error(`\n${RED}${error instanceof Error ? error.message : String(error)}${OFF}\n`);
  process.exit(1);
});
