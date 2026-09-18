/**
 * Product titles.
 *
 * Shape: `{Stone} {Piece} - {size} {weight}`, e.g. "Malachite Sphere - 38 mm
 * 110 gr". The piece is the owner's PRODUCT name when he has written one
 * ("Dragon (on Stand)"), and the product type otherwise. The owner asked for
 * the weight in the title: for a unique physical piece, size and weight
 * together are what a buyer is actually choosing between.
 *
 * We originally decided to always use height. The real sheet disproved that:
 * spheres record only a width, in millimetres, and would have ended up with no
 * size in the title at all. So the rule is the first dimension that actually
 * has a value — height, then width, then depth — displayed in the unit the
 * cell was written in. That matches how these are really sold: spheres by
 * diameter in mm, towers by height in cm.
 *
 * The size is rounded: titles are for scanning, the spec line carries the
 * exact figures. When there is no dimension at all, the size is dropped rather
 * than rendered as "- 0 cm".
 */

import { formatMeasureRounded, formatNumber, type Measure } from './measure.js';
import { titleCase } from './stones.js';

/** First dimension with a value. Order reflects how a piece is normally described. */
export function pickTitleMeasure(
  height: Measure | null,
  width: Measure | null,
  depth: Measure | null,
): Measure | null {
  return height ?? width ?? depth ?? null;
}

/**
 * Weight as the owner writes it in a title: "250 gr", not "250 g".
 *
 * Kilograms keep their decimal, since "1.2 kg" is how a heavy piece reads. A
 * length unit here means the WEIGHT column holds something that isn't a weight,
 * so it is left out of the title rather than shown as nonsense.
 */
function weightForTitle(weight: Measure | null): string | null {
  if (!weight) return null;
  if (weight.unit === 'kg') return `${formatNumber(weight.value)} kg`;
  if (weight.unit === 'g') return `${Math.round(weight.value)} gr`;
  return null;
}

/** Kept lower case inside a product name, as English titles write them. */
const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

/**
 * The owner's PRODUCT name, as a title reads it: "GHOST IN HAT" → "Ghost in
 * Hat", "CAT HEAD (on a string)" → "Cat Head (on a String)".
 *
 * Deliberately separate from `titleCase`, which formats stones and types: those
 * titles are already in Shopify and must not change under this rule. His
 * brackets are kept — they are what tells "Dragon" from "Dragon (on Stand)".
 */
export function formatProductName(raw: string): string {
  return titleCase(raw)
    .split(' ')
    .map((word, i) => {
      const bracket = word.startsWith('(') ? '(' : '';
      const bare = word.slice(bracket.length);
      const lower = bare.toLocaleLowerCase('hu-HU');
      if (i > 0 && SMALL_WORDS.has(lower)) return bracket + lower;
      return bracket + bare.charAt(0).toLocaleUpperCase('hu-HU') + bare.slice(1);
    })
    .join(' ');
}

export interface TitleInput {
  stoneEnglish: string;
  /** What the piece is: the formatted PRODUCT name, or the title-cased type. */
  piece: string;
  dimension: Measure | null;
  weight: Measure | null;
}

export function buildTitle({
  stoneEnglish,
  piece,
  dimension,
  weight,
}: TitleInput): string {
  const name = [stoneEnglish, piece]
    .map((part) => part.trim().replace(/\s+/g, ' '))
    .filter((part) => part !== '')
    .join(' ');

  if (name === '') return '';

  // Either part may be missing — 56 of the real rows have no weight at all —
  // so the suffix is built from whatever is actually there.
  const suffix = [dimension ? formatMeasureRounded(dimension) : null, weightForTitle(weight)]
    .filter((part): part is string => part !== null)
    .join(' ');

  return suffix === '' ? name : `${name} - ${suffix}`;
}

/**
 * Tags drive Shopify's automated collections, so getting them right at creation
 * means the "Malachite" and "Sphere" collections populate themselves forever,
 * with no curation and no extra column in the sheet.
 */
export function buildTags(stoneEnglish: string, productType: string): string[] {
  const tags = [stoneEnglish, productType]
    .map((part) => part.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter((part) => part !== '');

  return [...new Set(tags)];
}
