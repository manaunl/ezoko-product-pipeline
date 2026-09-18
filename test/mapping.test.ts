import { describe, expect, it } from 'vitest';
import { buildCatalogue } from '../src/domain/descriptions.js';
import { indexPhotos } from '../src/domain/filenames.js';
import { findDuplicateSkus, looksLikeRangeSku, rowToOutcome } from '../src/domain/mapping.js';
import type { DriveFile, SheetRow } from '../src/domain/types.js';

const photo = (name: string): DriveFile => ({
  id: name,
  name,
  mimeType: 'image/jpeg',
  size: 1000,
  folder: 'Spheres',
});

/** Row 3 of the real sheet. */
const malachiteSphere: SheetRow = {
  rowNumber: 3,
  sku: 'SP-190-B',
  stoneName: 'Malachit',
  productType: 'SPHERE',
  productName: '',
  price: '8500',
  weight: '110g',
  height: '',
  width: '38 mm',
  depth: '',
  photoStatus: 'Completed',
};

const photos = indexPhotos([
  photo('SP-190-B_01.jpg'),
  photo('SP-190-B_02.jpg'),
  photo('SP-190-B_03.jpg'),
]);

const row = (overrides: Partial<SheetRow>): SheetRow => ({ ...malachiteSphere, ...overrides });

const catalogue = buildCatalogue([
  { title: 'Malachite Sphere - 40mm', bodyHtml: '<h3>Malachite</h3><p>Malachite is a copper mineral.</p>' },
  { title: 'Malachite Tower - 9cm', bodyHtml: '<h3>Malachite</h3><p>Malachite is a copper mineral.</p>' },
  { title: 'Fluorite Cube', bodyHtml: '<h3>Fluorite</h3><p>Fluorite is calcium fluoride.</p>' },
]);

const withCopy = (overrides: Partial<SheetRow> = {}, aliases: Record<string, string> = {}) => {
  const outcome = rowToOutcome(row(overrides), photos, {
    descriptions: catalogue,
    descriptionAliases: aliases,
  });
  if (outcome.kind !== 'ready') throw new Error(`expected ready, got ${outcome.kind}`);
  return outcome.draft;
};

describe('a complete row', () => {
  const outcome = rowToOutcome(malachiteSphere, photos);

  it('produces a product', () => {
    expect(outcome.kind).toBe('ready');
  });

  it('translates the stone, title-cases the type, and carries size and weight', () => {
    if (outcome.kind !== 'ready') throw new Error('expected ready');
    expect(outcome.draft.title).toBe('Malachite Sphere - 38 mm 110 gr');
  });

  it('falls back to width when there is no height, in the unit the cell used', () => {
    // Spheres record only a width, in millimetres. Our first design always used
    // height, which would have left every sphere with no size in its title.
    if (outcome.kind !== 'ready') throw new Error('expected ready');
    expect(outcome.draft.title).toContain('38 mm');
  });

  it('tags lowercase, for automated collections', () => {
    if (outcome.kind !== 'ready') throw new Error('expected ready');
    expect(outcome.draft.tags).toEqual(['malachite', 'sphere']);
  });

  it('leaves the description empty when no catalogue is supplied', () => {
    // Nothing is invented locally. The body is the owner's published copy or it is
    // nothing — there is no generated filler any more.
    if (outcome.kind !== 'ready') throw new Error('expected ready');
    expect(outcome.draft.descriptionHtml).toBe('');
  });

  it('keeps the photos in filename order', () => {
    if (outcome.kind !== 'ready') throw new Error('expected ready');
    expect(outcome.draft.photos.map((p) => p.file.name)).toEqual([
      'SP-190-B_01.jpg',
      'SP-190-B_02.jpg',
      'SP-190-B_03.jpg',
    ]);
  });
});

describe('the PRODUCT name, when the owner has written one', () => {
  const ready = (overrides: Partial<SheetRow>) => {
    const outcome = rowToOutcome(row({ productType: 'CARVING', ...overrides }), photos);
    if (outcome.kind !== 'ready') throw new Error(`expected ready, got ${outcome.kind}`);
    return outcome.draft;
  };

  it('takes the place of the type in the title', () => {
    expect(ready({ productName: 'BAT' }).title).toBe('Malachite Bat - 38 mm 110 gr');
  });

  it('leaves the title exactly as before when empty', () => {
    expect(ready({ productName: '' }).title).toBe('Malachite Carving - 38 mm 110 gr');
    expect(ready({ productName: '  ' }).title).toBe('Malachite Carving - 38 mm 110 gr');
  });

  it('reads as a title: small words lower case, the owner’s brackets kept', () => {
    // Every shape in the real sheet: typed in capitals, with notes in brackets
    // that tell "Dragon" and "Dragon (on Stand)" apart.
    const cases: Record<string, string> = {
      'GHOST IN HAT': 'Ghost in Hat',
      'DRAGONFLY (ON STAND)': 'Dragonfly (on Stand)',
      'BUTTERFLY (ON SPRING)': 'Butterfly (on Spring)',
      'CAT HEAD (on a string)': 'Cat Head (on a String)',
      'DOG HEAD (on a string)': 'Dog Head (on a String)',
      'MOTHER WITH CHILD': 'Mother with Child',
      'CAT ON TOMBSTONE': 'Cat on Tombstone',
      'rotating glass tumbler': 'Rotating Glass Tumbler',
      'POISON BOTTLE': 'Poison Bottle',
    };
    for (const [typed, shown] of Object.entries(cases)) {
      expect(ready({ productName: typed }).title, typed).toBe(`Malachite ${shown} - 38 mm 110 gr`);
    }
  });

  it('capitalises a small word when it starts the name', () => {
    expect(ready({ productName: 'THE HERMIT' }).title).toContain('Malachite The Hermit -');
  });

  it('ignores stray spaces', () => {
    expect(ready({ productName: '  GHOST   IN  HAT ' }).title).toContain('Malachite Ghost in Hat -');
  });

  it('does not touch tags or product type, so collections keep filling themselves', () => {
    const draft = ready({ productName: 'DRAGON (ON STAND)' });
    expect(draft.tags).toEqual(['malachite', 'carving']);
    expect(draft.productType).toBe('Carving');
  });
});

describe('the Product template', () => {
  it('is bracelet for every product, whatever its type or name', () => {
    // The owner's recent towers, spheres and necklaces all use the theme's
    // "bracelet" template despite its name. See ADR-0008.
    const rows = [
      row({}),
      row({ productType: 'CARVING', productName: 'DRAGON (ON STAND)' }),
      row({ productType: 'CARVING', productName: '' }),
      row({ productType: 'TOWER' }),
      row({ productType: 'PENDANT' }),
    ];
    for (const r of rows) {
      const outcome = rowToOutcome(r, photos);
      if (outcome.kind !== 'ready') throw new Error(`expected ready, got ${outcome.kind}`);
      expect(outcome.draft.template, `${r.productType} ${r.productName}`).toBe('bracelet');
    }
  });
});

describe('the description, inherited from the storefront', () => {
  it('uses the published copy for the stone, verbatim', () => {
    expect(withCopy().descriptionHtml).toBe('<p>Malachite is a copper mineral.</p>');
  });

  it('matches on the translated English name, not the Hungarian cell', () => {
    // The cell says "Malachit"; the store's heading says "Malachite".
    expect(withCopy({ stoneName: 'Malachit' }).descriptionHtml).toContain('copper mineral');
  });

  it('creates the product anyway when the stone has no published copy', () => {
    const draft = withCopy({ stoneName: 'Shattuckit', sku: 'SP-190-B' });
    expect(draft.descriptionHtml).toBe('');
    expect(draft.title).toContain('Shattuckite');
  });

  it('warns, naming the stone and the fix, when there is no copy', () => {
    const warnings = withCopy({ stoneName: 'Shattuckit' }).warnings;
    expect(warnings.some((w) => w.includes('Shattuckite') && w.includes('publish'))).toBe(true);
  });

  it('follows an alias and says what it borrowed from', () => {
    const draft = withCopy({ stoneName: 'TIFFANY FLUORIT' }, { 'tiffany fluorite': 'Fluorite' });
    expect(draft.descriptionHtml).toContain('calcium fluoride');
    expect(draft.warnings.some((w) => w.includes('borrowed from "Fluorite"'))).toBe(true);
  });

  it('keeps the row’s own stone name in the title when copy is borrowed', () => {
    // The whole reason aliases are a separate table from stone-names.json: the
    // title must still say Tiffany Fluorite.
    const draft = withCopy({ stoneName: 'TIFFANY FLUORIT' }, { 'tiffany fluorite': 'Fluorite' });
    expect(draft.title).toBe('Tiffany Fluorite Sphere - 38 mm 110 gr');
    expect(draft.tags).toEqual(['tiffany fluorite', 'sphere']);
  });

  it('does not borrow without an explicit alias', () => {
    expect(withCopy({ stoneName: 'TIFFANY FLUORIT' }).descriptionHtml).toBe('');
  });

  it('warns when the store disagrees with itself about a stone', () => {
    const tied = buildCatalogue([
      { title: 'A', bodyHtml: '<h3>Malachite</h3><p>One version of the copy.</p>' },
      { title: 'B', bodyHtml: '<h3>Malachite</h3><p>A different and rather longer version.</p>' },
    ]);
    const outcome = rowToOutcome(malachiteSphere, photos, { descriptions: tied });
    if (outcome.kind !== 'ready') throw new Error('expected ready');
    expect(outcome.draft.descriptionHtml).toContain('rather longer');
    expect(outcome.draft.warnings.some((w) => w.includes('none is more common'))).toBe(true);
  });

  it('never contains a spec line — dimensions live in the title', () => {
    expect(withCopy().descriptionHtml).not.toContain('This piece');
    expect(withCopy().descriptionHtml).not.toContain('Width 38 mm');
  });
});

describe('rows that are simply not ready — expected, not faults', () => {
  const skipReason = (overrides: Partial<SheetRow>) => {
    const outcome = rowToOutcome(row(overrides), photos);
    if (outcome.kind !== 'skipped') throw new Error(`expected skipped, got ${outcome.kind}`);
    return outcome.reason;
  };

  it('skips when the price is still "?"', () => {
    expect(skipReason({ price: '?' })).toContain('PRICE');
  });

  it('skips when the stone name is still "?"', () => {
    // 53 rows of the real sheet. Without this they would be titled just
    // "Carving", which is worse than not existing.
    expect(skipReason({ stoneName: '?' })).toContain('STONE Name');
  });

  it('skips when the product name is still "?", rather than falling back to the type', () => {
    // Falling back would create a permanent title he said he hadn't decided on.
    expect(skipReason({ productName: '?' })).toContain('PRODUCT name');
  });

  it('skips when the photographer has not marked it', () => {
    expect(skipReason({ photoStatus: '' })).toContain('PHOTO Status');
  });

  it('skips when Drive has no photos for the SKU', () => {
    expect(skipReason({ sku: 'SP-190-A' })).toContain('no photos');
  });
});

describe('rows that need a human', () => {
  const problems = (overrides: Partial<SheetRow>, duplicateSkus?: Set<string>) => {
    const outcome = rowToOutcome(row(overrides), photos, { duplicateSkus });
    if (outcome.kind !== 'invalid') throw new Error(`expected invalid, got ${outcome.kind}`);
    return outcome.problems.map((p) => p.message).join(' | ');
  };

  it('refuses a SKU covering a range of pieces', () => {
    expect(problems({ sku: 'CA-738-A1-A11' })).toContain('range of pieces');
  });

  it('refuses a duplicated SKU rather than picking one', () => {
    expect(problems({}, new Set(['SP-190-B']))).toContain('more than one row');
  });

  it('refuses an unparseable measurement', () => {
    expect(problems({ width: 'big' })).toContain('WIDTH');
  });

  it('refuses a stone name with a question mark in it, naming the cell and the fix', () => {
    // "BRONZE ?" is a half-made decision. Only a bare "?" is a placeholder, so
    // without this it would go out titled "Bronze ? Horse" — and titles are
    // never updated.
    const message = problems({ stoneName: 'BRONZE ?' });
    expect(message).toContain('"BRONZE ?"');
    expect(message).toContain('question mark');
    expect(message).toContain('run again');
  });

  it('refuses a product name with a question mark in it', () => {
    const message = problems({ productName: 'DRAGON ?' });
    expect(message).toContain('PRODUCT name "DRAGON ?"');
    expect(message).toContain('question mark');
  });

  it('flags the question mark even before the price is set', () => {
    // The real row is "BRONZE ?" with no price. Waiting for the price would hide
    // the half-decision behind "not ready yet".
    expect(problems({ stoneName: 'BRONZE ?', price: '?' })).toContain('question mark');
  });
});

describe('range SKU detection', () => {
  it('spots the real ones', () => {
    for (const sku of ['CA-738-A1-A11', 'CA-735-A-D', 'CA-722-A-B', 'CA-514-C-A15']) {
      expect(looksLikeRangeSku(sku), sku).toBe(true);
    }
  });

  it('leaves ordinary SKUs alone', () => {
    for (const sku of ['SP-190-B', 'CA-745-A1', 'H-080-B', 'CM-233-E', 'TO-093', 'SMF-038']) {
      expect(looksLikeRangeSku(sku), sku).toBe(false);
    }
  });
});

describe('duplicate detection', () => {
  it('finds SKUs that appear twice, ignoring case', () => {
    const rows = [
      row({ rowNumber: 109, sku: 'H-080-B' }),
      row({ rowNumber: 110, sku: 'h-080-b' }),
      row({ rowNumber: 111, sku: 'SP-190-B' }),
    ];
    expect([...findDuplicateSkus(rows)]).toEqual(['H-080-B']);
  });
});
