/**
 * Product titles.
 *
 * Shape: `{Stone} {Type} - {size} {weight}`, e.g. "Malachite Sphere - 38 mm
 * 110 gr". The owner asked for the weight in the title: for a unique physical
 * piece, size and weight together are what a buyer is actually choosing between.
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

export interface TitleInput {
  stoneEnglish: string;
  productType: string;
  dimension: Measure | null;
  weight: Measure | null;
}

export function buildTitle({
  stoneEnglish,
  productType,
  dimension,
  weight,
}: TitleInput): string {
  const name = [stoneEnglish, productType]
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
