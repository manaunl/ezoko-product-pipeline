/**
 * Rendering a piece's measurements for a human reading the console.
 *
 * This used to be appended to the product description. It no longer is: the
 * body now carries the stone's own copy inherited from the storefront, and
 * none of the owner's 2,550 published products has a spec line, so adding one made
 * the tool's products the odd ones out. Dimensions live in the title.
 *
 * The formatting stayed, because `preview` and `create-one` both print it and
 * it is the fastest way to see that a row parsed the way you expected.
 *
 * Dimensions are labelled rather than written as `24.7 × 11.2 × 9.8`, because
 * when one is missing an unlabelled list is ambiguous — the reader cannot tell
 * which axis was dropped. Real rows are frequently missing one.
 */

import { formatMeasure, type Measure } from './measure.js';

export interface SpecInput {
  height: Measure | null;
  width: Measure | null;
  depth: Measure | null;
  weight: Measure | null;
}

export function buildSpecParts({ height, width, depth, weight }: SpecInput): string[] {
  const parts: string[] = [];
  if (height) parts.push(`Height ${formatMeasure(height)}`);
  if (width) parts.push(`Width ${formatMeasure(width)}`);
  if (depth) parts.push(`Depth ${formatMeasure(depth)}`);
  if (weight) parts.push(`Weight ${formatMeasure(weight)}`);
  return parts;
}
