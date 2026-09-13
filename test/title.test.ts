import { describe, expect, it } from 'vitest';
import { buildTitle } from '../src/domain/title.js';
import { parseMeasure, type Measure, type Unit } from '../src/domain/measure.js';

const m = (raw: string, unit: Unit | null = 'cm'): Measure => {
  const result = parseMeasure(raw, unit, 'TEST');
  if (!result.ok) throw new Error(result.reason);
  return result.measure;
};

const title = (over: Partial<Parameters<typeof buildTitle>[0]> = {}) =>
  buildTitle({
    stoneEnglish: 'Malachite',
    productType: 'Sphere',
    dimension: m('38 mm', null),
    weight: m('110g'),
    ...over,
  });

describe('title shape', () => {
  it('is {stone} {type} - {size} {weight}', () => {
    // The format the owner asked for.
    expect(title()).toBe('Malachite Sphere - 38 mm 110 gr');
  });

  it('writes grams as "gr", the way the owner writes it', () => {
    expect(title({ weight: m('250g') })).toContain('250 gr');
  });

  it('keeps kilograms as kg, with their decimal', () => {
    expect(title({ weight: m('1,2kg') })).toBe('Malachite Sphere - 38 mm 1.2 kg');
  });

  it('rounds the weight — the exact figure is in the spec line', () => {
    expect(title({ weight: m('110,4g') })).toContain('110 gr');
  });
});

describe('when something is missing', () => {
  it('drops the weight rather than writing zero', () => {
    // 56 of the 144 real rows have no weight.
    expect(title({ weight: null })).toBe('Malachite Sphere - 38 mm');
  });

  it('drops the size and keeps the weight', () => {
    expect(title({ dimension: null })).toBe('Malachite Sphere - 110 gr');
  });

  it('drops the separator entirely when neither exists', () => {
    expect(title({ dimension: null, weight: null })).toBe('Malachite Sphere');
  });

  it('returns nothing when there is no stone and no type', () => {
    expect(title({ stoneEnglish: '', productType: '' })).toBe('');
  });

  it('ignores a length in the weight column instead of printing nonsense', () => {
    expect(title({ weight: m('12 cm') })).toBe('Malachite Sphere - 38 mm');
  });
});

describe('ranges', () => {
  it('uses the upper bound of a size range', () => {
    expect(title({ dimension: m('5-6 cm') })).toBe('Malachite Sphere - 6 cm 110 gr');
  });
});
