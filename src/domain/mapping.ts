/**
 * Turning a spreadsheet row plus its photos into a ready-to-send product.
 *
 * This is the last purely-testable step before anything touches the network, so
 * it is where all validation lives. A row either produces a complete, valid
 * draft or it produces problems phrased for the person who has to fix the
 * sheet — never a half-filled product.
 *
 * Three outcomes, and the distinction matters to whoever reads the report:
 *
 *   ready    — will be created
 *   skipped  — not finished yet (no photos, no price, no stone name). Normal,
 *              expected, and not a fault. Roughly a third of the sheet.
 *   invalid  — something is wrong that a human must fix before it can proceed.
 */

import { lookupDescription, type DescriptionCatalogue } from './descriptions.js';
import { normaliseSku } from './filenames.js';
import { isBlank, parseMeasure, type Measure, type Unit } from './measure.js';
import { parseHufPrice } from './numbers.js';
import { translateStone, titleCase } from './stones.js';
import { buildTags, buildTitle, pickTitleMeasure } from './title.js';
import type { PhotoIndex, RowOutcome, RowProblem, SheetRow } from './types.js';

/**
 * Values in PHOTO Status that mean "not finished yet".
 *
 * The rule is: any non-empty value means the photographer has marked the row
 * ready — the real sheet uses "Completed". This set is the escape hatch for
 * values that mean the opposite. Comparison is lowercase and trimmed.
 */
export const NOT_READY_PHOTO_STATUS = new Set<string>([]);

export function isPhotoReady(photoStatus: string): boolean {
  const value = photoStatus.trim().toLowerCase();
  if (value === '') return false;
  return !NOT_READY_PHOTO_STATUS.has(value);
}

/**
 * A SKU covering a range of pieces: `CA-738-A1-A11` means A1 through A11,
 * eleven physical stones on one row. The sheet carries a single price and a
 * single size for all of them, so there is no honest way to expand it into
 * eleven products. v1 refuses these and reports them; the owner splits the row if
 * he wants the pieces listed individually.
 *
 * A false positive here is visible in the report and costs a correction, which
 * is the right way round — the alternative is silently creating one product
 * where eleven were meant.
 */
const RANGE_SKU = /^.*[0-9]-[A-Za-z]+[0-9]*-[A-Za-z]+[0-9]*$/;

export function looksLikeRangeSku(sku: string): boolean {
  return RANGE_SKU.test(sku.trim());
}

/**
 * Default units for bare numbers, taken from the column headers. WIDTH is
 * deliberately null: its header states no unit and its data is millimetres, so
 * a bare number there is genuinely ambiguous.
 */
const DEFAULT_UNITS = {
  height: 'cm',
  width: null,
  depth: 'cm',
  weight: 'g',
} as const satisfies Record<string, Unit | null>;

export interface MapOptions {
  /**
   * When false, rows with no photos are still validated instead of skipped.
   * Used by `preview --all` to surface data problems across the whole sheet
   * before the photographer has shot everything.
   */
  requirePhotos?: boolean;
  /** Normalised SKUs that appear on more than one row. */
  duplicateSkus?: ReadonlySet<string>;
  /**
   * Published descriptions from the storefront, keyed by stone. Absent means
   * every product gets an empty body — which is only ever correct in tests.
   */
  descriptions?: DescriptionCatalogue;
  /** Stones that deliberately borrow another stone's copy. */
  descriptionAliases?: Readonly<Record<string, string>>;
}

/** Text with a question mark in it — as opposed to the bare "?" placeholder. */
function isHalfDecided(raw: string): boolean {
  return !isBlank(raw) && raw.includes('?');
}

function halfDecided(label: string, raw: string): string {
  return `${label} "${raw.trim()}" contains a question mark — decide the name, then run again`;
}

/** Optional measurement: blank is fine, malformed is not. */
function optional(
  raw: string,
  fallback: Unit | null,
  label: string,
  problems: RowProblem[],
): Measure | null {
  if (isBlank(raw)) return null;

  const result = parseMeasure(raw, fallback, label);
  if (!result.ok) {
    problems.push({ field: label, message: result.reason });
    return null;
  }
  return result.measure;
}

/**
 * Resolves the stone's published description, recording in `warnings` anything
 * a human would want to know about how it was chosen.
 *
 * Returns an empty string rather than throwing when nothing matches. The
 * missing copy costs the owner a paste in the admin; refusing the row would cost
 * him the photos, price, title and weight as well.
 */
function describeStone(
  stoneEnglish: string,
  warnings: string[],
  options: MapOptions,
): { html: string; from: string | null } {
  if (!options.descriptions) return { html: '', from: null };

  const found = lookupDescription(
    options.descriptions,
    stoneEnglish,
    options.descriptionAliases ?? {},
  );

  if (!found) {
    warnings.push(
      `no description found on the storefront for "${stoneEnglish}" — the product will have an ` +
        `empty description. Write it on any one ${stoneEnglish} product in the shop and publish ` +
        `that product, and future runs will use it`,
    );
    return { html: '', from: null };
  }

  if (found.borrowedFrom) {
    warnings.push(
      `description borrowed from "${found.borrowedFrom}" — "${stoneEnglish}" has no copy of its ` +
        `own. Remove the entry from data/description-aliases.json to leave it empty instead`,
    );
  }

  if (found.chosen.tied) {
    warnings.push(
      `${found.chosen.candidates} different "${found.chosen.heading}" descriptions are published ` +
        `and none is more common than the others — used the longest. Standardise them in the ` +
        `shop to control which one is inherited`,
    );
  }

  return { html: found.chosen.html, from: found.chosen.heading };
}

export function rowToOutcome(
  row: SheetRow,
  photos: PhotoIndex,
  options: MapOptions = {},
): RowOutcome {
  const requirePhotos = options.requirePhotos ?? true;
  const displaySku = row.sku.trim();
  const sku = normaliseSku(row.sku);
  const rowNumber = row.rowNumber;

  const invalid = (field: string, message: string): RowOutcome => ({
    kind: 'invalid',
    rowNumber,
    sku: displaySku || `(row ${rowNumber})`,
    problems: [{ field, message }],
  });
  const skip = (reason: string): RowOutcome => ({
    kind: 'skipped',
    rowNumber,
    sku: displaySku,
    reason,
  });

  if (sku === '') return invalid('SKU', 'the SKU cell is empty');

  if (options.duplicateSkus?.has(sku)) {
    return invalid(
      'SKU',
      'this SKU appears on more than one row — creating either would be a coin flip, and results are written back by SKU',
    );
  }

  if (looksLikeRangeSku(sku)) {
    return invalid(
      'SKU',
      'this SKU covers a range of pieces (e.g. A1 through A11) but the row has one price and one size — split it into separate rows to list them',
    );
  }

  if (requirePhotos && !isPhotoReady(row.photoStatus)) {
    return skip('PHOTO Status is empty');
  }

  // "?" is what the owner types for "not decided yet". These rows are simply not
  // ready, which is a different thing from being wrong.
  if (isBlank(row.stoneName)) return skip('STONE Name not filled in yet');

  // A "?" beside other text ("BRONZE ?") is a decision half made. It is not a
  // placeholder, so it would otherwise reach a title that can never be renamed.
  // Checked before the price so it is flagged while the row is being filled in.
  if (isHalfDecided(row.stoneName)) {
    return invalid('STONE Name', halfDecided('STONE Name', row.stoneName));
  }

  if (isBlank(row.price)) return skip('PRICE not set yet');

  const matched = photos.bySku.get(sku) ?? [];
  if (requirePhotos && matched.length === 0) {
    // A live product with no photograph is worse than a missing one, so this is
    // a skip rather than a create-with-nothing.
    return skip('no photos found in Drive for this SKU');
  }

  const problems: RowProblem[] = [];
  const warnings: string[] = [];

  const height = optional(row.height, DEFAULT_UNITS.height, 'HEIGHT', problems);
  const width = optional(row.width, DEFAULT_UNITS.width, 'WIDTH', problems);
  const depth = optional(row.depth, DEFAULT_UNITS.depth, 'LENGTH/DEPTH', problems);
  const weight = optional(row.weight, DEFAULT_UNITS.weight, 'WEIGHT', problems);

  const price = parseHufPrice(row.price);
  if (!price.ok) problems.push({ field: 'PRICE', message: price.reason });

  const stone = translateStone(row.stoneName);
  if (stone.untranslated) {
    warnings.push(
      `stone name "${row.stoneName.trim()}" has no English translation — add it to data/stone-names.json`,
    );
  }

  const productType = titleCase(row.productType);
  const dimension = pickTitleMeasure(height, width, depth);
  const title = buildTitle({ stoneEnglish: stone.english, productType, dimension, weight });

  if (title === '') {
    problems.push({
      field: 'STONE Name / PRODUCT Type',
      message: 'both are empty, so there is nothing to build a title from',
    });
  }

  if (problems.length > 0) {
    return { kind: 'invalid', rowNumber, sku: displaySku, problems };
  }

  if (dimension === null) warnings.push('no height, width or depth — the title will have no size');
  if (weight === null) warnings.push('no weight — shipping cost cannot be calculated from it');

  // The description is the owner's own published copy for this stone, inherited
  // verbatim. A stone he has not written about yet gets an empty body and a
  // warning: the product is otherwise complete, it is a draft, and he can paste
  // the copy in the admin where he is already opening it to press Translate.
  const description = describeStone(stone.english, warnings, options);

  return {
    kind: 'ready',
    rowNumber,
    draft: {
      sku,
      displaySku,
      title,
      descriptionHtml: description.html,
      descriptionFrom: description.from,
      productType,
      tags: buildTags(stone.english, productType),
      priceHuf: price.ok ? price.value : 0,
      weight,
      height,
      width,
      depth,
      photos: matched,
      warnings,
    },
  };
}

/** Normalised SKUs that occur on more than one row. */
export function findDuplicateSkus(rows: SheetRow[]): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const sku = normaliseSku(row.sku);
    if (sku === '') continue;
    counts.set(sku, (counts.get(sku) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([sku]) => sku));
}
