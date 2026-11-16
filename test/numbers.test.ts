import { describe, expect, it } from 'vitest';
import { formatHuf, formatPriceWithStock } from '../src/domain/numbers.js';

describe('the price as the preview shows it', () => {
  it('is the price alone for a single piece, as every unique stone has', () => {
    expect(formatPriceWithStock(8500, 1)).toBe(formatHuf(8500));
  });

  it('carries "× N" beside the price when the row starts with more than one', () => {
    expect(formatPriceWithStock(8500, 28)).toBe(`${formatHuf(8500)} × 28`);
    expect(formatPriceWithStock(1200, 2)).toBe(`${formatHuf(1200)} × 2`);
  });
});
