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
  optionLabel: '',
  stock: '',
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

describe('the Option label, when the owner has written one', () => {
  const ready = (overrides: Partial<SheetRow>) => {
    const outcome = rowToOutcome(row({ productType: 'CARVING', ...overrides }), photos);
    if (outcome.kind !== 'ready') throw new Error(`expected ready, got ${outcome.kind}`);
    return outcome.draft;
  };

  it('goes in brackets at the very end, after the size and weight', () => {
    expect(ready({ productName: 'DRAGON', optionLabel: 'A1' }).title).toBe(
      'Malachite Dragon - 38 mm 110 gr (A1)',
    );
  });

  it('goes straight after the name when there is no size or weight', () => {
    // The label tells sibling pieces apart, so a missing measurement must not drop it.
    const draft = ready({ productName: 'DRAGON', optionLabel: 'A1', width: '', weight: '' });
    expect(draft.title).toBe('Malachite Dragon (A1)');
  });

  it('follows whichever part of the suffix is there', () => {
    expect(ready({ optionLabel: 'A1', weight: '' }).title).toBe('Malachite Carving - 38 mm (A1)');
    expect(ready({ optionLabel: 'A1', width: '' }).title).toBe('Malachite Carving - 110 gr (A1)');
  });

  it('is not doubled when the owner typed the brackets, as the header’s "Eg. (A1)" shows', () => {
    expect(ready({ optionLabel: '(A1)' }).title).toBe('Malachite Carving - 38 mm 110 gr (A1)');
    expect(ready({ optionLabel: ' ( A1 ) ' }).title).toBe('Malachite Carving - 38 mm 110 gr (A1)');
  });

  it('strips only a pair that really surrounds the whole label', () => {
    // "(A1) (B2)" opens and closes with brackets, but they are two pairs, not one.
    expect(ready({ optionLabel: '(A1) (B2)' }).title).toBe('Malachite Carving - 38 mm 110 gr ((A1) (B2))');
  });

  it('is upper-cased and trimmed, matching the SKU convention', () => {
    expect(ready({ optionLabel: '  a1 ' }).title).toBe('Malachite Carving - 38 mm 110 gr (A1)');
  });

  it('sits beside a bracketed PRODUCT name, keeping both', () => {
    const draft = ready({ productName: 'DRAGON (ON STAND)', optionLabel: 'A1', width: '9 cm', weight: '50' });
    expect(draft.title).toBe('Malachite Dragon (on Stand) - 9 cm 50 gr (A1)');
  });

  it('leaves the title exactly as today when empty', () => {
    for (const optionLabel of ['', '   ', '-']) {
      expect(ready({ optionLabel }).title, JSON.stringify(optionLabel)).toBe('Malachite Carving - 38 mm 110 gr');
    }
  });

  it('is never derived from the SKU', () => {
    // SKU CA-745-A1 has an option-shaped suffix; the title only says what he wrote.
    const outcome = rowToOutcome(
      row({ sku: 'CA-745-A1', productType: 'CARVING' }),
      indexPhotos([photo('CA-745-A1_01.jpg')]),
    );
    if (outcome.kind !== 'ready') throw new Error(`expected ready, got ${outcome.kind}`);
    expect(outcome.draft.title).toBe('Malachite Carving - 38 mm 110 gr');
  });

  it('never becomes a tag, and leaves type and description alone', () => {
    const plain = withCopy({ productType: 'CARVING' });
    const labelled = withCopy({ productType: 'CARVING', optionLabel: 'A1' });
    expect(labelled.tags).toEqual(['malachite', 'carving']);
    expect(labelled.productType).toBe(plain.productType);
    expect(labelled.descriptionHtml).toBe(plain.descriptionHtml);
  });

  it('skips the row while it is still "?", bracketed or not', () => {
    // A title is never renamed, so an undecided label must not go out without it.
    // "(?)" is "?" typed the way the header's "Eg. (A1)" shows.
    for (const optionLabel of ['?', ' ? ', '(?)']) {
      const outcome = rowToOutcome(row({ optionLabel }), photos);
      if (outcome.kind !== 'skipped') throw new Error(`${optionLabel}: expected skipped, got ${outcome.kind}`);
      expect(outcome.reason).toBe('Option not decided yet');
    }
  });

  it('refuses a label with a question mark beside it, naming the cell and the fix', () => {
    const outcome = rowToOutcome(row({ optionLabel: 'A1 ?' }), photos);
    if (outcome.kind !== 'invalid') throw new Error(`expected invalid, got ${outcome.kind}`);
    const message = outcome.problems.map((p) => p.message).join(' | ');
    expect(message).toContain('Option "A1 ?"');
    expect(message).toContain('question mark');
    expect(message).toContain('decide the label');
  });

  it('flags the question mark even before the price is set', () => {
    const outcome = rowToOutcome(row({ optionLabel: 'A1 ?', price: '?' }), photos);
    expect(outcome.kind).toBe('invalid');
  });
});

describe('the Stock, as the starting quantity', () => {
  const stockOf = (stock: string) => {
    const outcome = rowToOutcome(row({ stock }), photos);
    if (outcome.kind !== 'ready') throw new Error(`${JSON.stringify(stock)}: expected ready, got ${outcome.kind}`);
    return outcome.draft.stock;
  };

  it('is 1 when the cell is empty, as for every unique piece today', () => {
    expect(stockOf('')).toBe(1);
    expect(stockOf('   ')).toBe(1);
  });

  it('is the number he wrote, when it is a whole number above zero', () => {
    expect(stockOf('1')).toBe(1);
    expect(stockOf('28')).toBe(28);
    expect(stockOf(' 10 ')).toBe(10);
  });

  it('reads "db" and "pcs" after the number, in any case, with or without a space', () => {
    for (const stock of ['5 db', '5db', '5 DB', '5 Db', '5 pcs', '5pcs', '5 PCS', '5 Pcs']) {
      expect(stockOf(stock), stock).toBe(5);
    }
  });

  it('skips the row while it is still "?"', () => {
    for (const stock of ['?', ' ? ']) {
      const outcome = rowToOutcome(row({ stock }), photos);
      if (outcome.kind !== 'skipped') throw new Error(`${stock}: expected skipped, got ${outcome.kind}`);
      expect(outcome.reason).toBe('Stock not decided yet');
    }
  });

  it('refuses anything that is not a whole number above zero, quoting the cell and the fix', () => {
    // A note typed into Stock must never be read as a quantity: "the stoen is
    // broken" created at 1 would list a piece he wrote is broken.
    for (const stock of [
      '0',
      '-3',
      '-',
      '1.5',
      '1,5',
      '2.0',
      'the stoen is broken ',
      'Missing Stone name',
      'NEEDS FIXING',
      '5 kg',
      'db 5',
      '5 db 3',
      '1 000',
    ]) {
      const outcome = rowToOutcome(row({ stock }), photos);
      if (outcome.kind !== 'invalid') throw new Error(`${JSON.stringify(stock)}: expected invalid, got ${outcome.kind}`);
      const message = outcome.problems.map((p) => p.message).join(' | ');
      expect(message, stock).toContain(`Stock "${stock.trim()}"`);
      expect(message, stock).toContain(
        'Stock must be a whole number such as 1 or 10. Keep notes in another column.',
      );
    }
  });

  it('joins the price and measurement problems rather than replacing them', () => {
    const outcome = rowToOutcome(row({ stock: 'broken', price: 'abc' }), photos);
    if (outcome.kind !== 'invalid') throw new Error(`expected invalid, got ${outcome.kind}`);
    expect(outcome.problems.map((p) => p.field).sort()).toEqual(['PRICE', 'Stock']);
  });

  it('never pre-empts an earlier reason to skip the row', () => {
    // Unfinished rows must not all turn red because Stock holds a note.
    const cases: [Partial<SheetRow>, string][] = [
      [{ stoneName: '' }, 'STONE Name not filled in yet'],
      [{ photoStatus: '' }, 'PHOTO Status is empty'],
      [{ price: '?' }, 'PRICE not set yet'],
    ];
    for (const [overrides, reason] of cases) {
      const outcome = rowToOutcome(row({ ...overrides, stock: 'the stoen is broken' }), photos);
      if (outcome.kind !== 'skipped') throw new Error(`${reason}: expected skipped, got ${outcome.kind}`);
      expect(outcome.reason).toBe(reason);
    }
  });

  it('leaves the title, tags and price alone', () => {
    const plain = withCopy();
    const stocked = withCopy({ stock: '28' });
    expect(stocked.title).toBe(plain.title);
    expect(stocked.tags).toEqual(plain.tags);
    expect(stocked.priceHuf).toBe(plain.priceHuf);
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
