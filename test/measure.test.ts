/**
 * Every input string in this file is a real value taken from the owner's sheet.
 * That is the point: these are not invented edge cases, they are the shapes the
 * data actually comes in.
 */

import { describe, expect, it } from 'vitest';
import { formatMeasure, formatMeasureRounded, isBlank, parseMeasure } from '../src/domain/measure.js';

const ok = (raw: string, fallback: Parameters<typeof parseMeasure>[1] = 'cm') => {
  const result = parseMeasure(raw, fallback, 'TEST');
  if (!result.ok) throw new Error(`expected "${raw}" to parse, got: ${result.reason}`);
  return result.measure;
};

describe('units come from the cell, not the header', () => {
  it('reads millimetres out of the WIDTH column', () => {
    // The WIDTH header implies cm. The data is mm. Getting this wrong publishes
    // a 37 mm sphere as a 37 cm one.
    expect(ok('37 mm', null)).toMatchObject({ value: 37, unit: 'mm' });
    expect(ok('68 mm', null)).toMatchObject({ value: 68, unit: 'mm' });
  });

  it('reads grams with no space before the unit', () => {
    expect(ok('80g')).toMatchObject({ value: 80, unit: 'g' });
    expect(ok('266g')).toMatchObject({ value: 266, unit: 'g' });
  });

  it('falls back to the column unit for a bare number', () => {
    expect(ok('24,7', 'cm')).toMatchObject({ value: 24.7, unit: 'cm' });
  });

  it('refuses a bare number where the column has no safe default', () => {
    const result = parseMeasure('37', null, 'WIDTH');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no unit');
  });
});

describe('Hungarian decimal commas', () => {
  it('treats a comma as the decimal point', () => {
    expect(ok('2,5 cm').value).toBe(2.5);
  });

  it('refuses two separators rather than guessing', () => {
    const result = parseMeasure('1.234,5 cm', 'cm', 'TEST');
    expect(result.ok).toBe(false);
  });
});

describe('ranges', () => {
  it('keeps both ends', () => {
    expect(ok('5-6 cm')).toMatchObject({ value: 5, max: 6, unit: 'cm' });
    expect(ok('2,5-3,5 cm')).toMatchObject({ value: 2.5, max: 3.5, unit: 'cm' });
    expect(ok('10-11 cm')).toMatchObject({ value: 10, max: 11, unit: 'cm' });
  });

  it('displays a range with an en dash', () => {
    expect(formatMeasure(ok('5-6 cm'))).toBe('5–6 cm');
    expect(formatMeasure(ok('2,5-3,5 cm'))).toBe('2.5–3.5 cm');
  });

  it('uses the upper bound in a title, since that is the size a buyer pictures', () => {
    expect(formatMeasureRounded(ok('5-6 cm'))).toBe('6 cm');
    expect(formatMeasureRounded(ok('2,5-4,5 cm'))).toBe('5 cm');
  });

  it('refuses a backwards range', () => {
    expect(parseMeasure('9-2 cm', 'cm', 'TEST').ok).toBe(false);
  });
});

describe('parenthetical notes', () => {
  it('parses the number and keeps the note', () => {
    expect(ok('17 cm (box)')).toMatchObject({ value: 17, unit: 'cm', note: 'box' });
    expect(ok('34 cm (box)')).toMatchObject({ value: 34, unit: 'cm', note: 'box' });
  });

  it('shows the note in the spec line so the information is not lost', () => {
    expect(formatMeasure(ok('17 cm (box)'))).toBe('17 cm (box)');
  });
});

describe('placeholders', () => {
  it('treats "?" as not filled in', () => {
    // the owner types "?" for values he has not decided yet.
    expect(isBlank('?')).toBe(true);
    expect(isBlank('')).toBe(true);
    expect(isBlank('  ')).toBe(true);
    expect(isBlank('37')).toBe(false);
  });
});

describe('formatting', () => {
  it('drops pointless trailing zeros', () => {
    expect(formatMeasure(ok('24,70 cm'))).toBe('24.7 cm');
    expect(formatMeasure(ok('37 mm', null))).toBe('37 mm');
  });
});
