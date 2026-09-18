import { describe, expect, it } from 'vitest';
import { toRows } from '../src/sheets/rows.js';

/** The real header row, PRODUCT name included, in the sheet's own order. */
const HEADER = [
  'PRODUCT Type',
  'PRODUCT name',
  'STONE Name ',
  'WEIGHT - súly - in gramm',
  'HEIGHT - magasság in cm',
  'WIDTH - szélesség ',
  'LENGHT/ DEPTH - hossz/mélység in cm',
  'PRICE',
  'SKU',
  'Photo Status',
];

const DRAGON = ['CARVING', 'DRAGON (ON STAND)', 'Amethyst', '250', '12', '', '', '12000', 'CA-738-A1', 'Completed'];

describe('reading the PRODUCT name column', () => {
  it('finds it by header, next to PRODUCT Type, with neither taking the other', () => {
    const { rows } = toRows([HEADER, DRAGON]);
    expect(rows[0]?.productName).toBe('DRAGON (ON STAND)');
    expect(rows[0]?.productType).toBe('CARVING');
  });

  it('finds it wherever it sits', () => {
    const moved = [...HEADER.slice(0, 1), ...HEADER.slice(2), 'Product Name'];
    const row = [...DRAGON.slice(0, 1), ...DRAGON.slice(2), 'BAT'];
    const { rows } = toRows([moved, row]);
    expect(rows[0]?.productName).toBe('BAT');
    expect(rows[0]?.productType).toBe('CARVING');
  });

  it('is optional: a sheet without it reads as every name empty', () => {
    const header = HEADER.filter((h) => h !== 'PRODUCT name');
    const row = DRAGON.filter((_, i) => i !== 1);
    const { columns, rows } = toRows([header, row]);

    expect(rows[0]?.productName).toBe('');
    expect(rows[0]?.stoneName).toBe('Amethyst');
    expect(columns.missingOptional).toContain('productName');
    expect(columns.missingRequired).toEqual([]);
  });
});
