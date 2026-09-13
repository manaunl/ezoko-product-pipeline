import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  buildCatalogue,
  countDescribedStones,
  descriptionKey,
  extractHeading,
  fingerprint,
  isPerPiece,
  lookupDescription,
  sanitiseHtml,
  stripLeadingHeading,
  toPlainText,
  type FeedProduct,
} from '../src/domain/descriptions.js';

const require = createRequire(import.meta.url);

/**
 * Real products from ezoko.shop, trimmed to the fields the tool reads. Using
 * the owner's own HTML matters: every rule in descriptions.ts exists because of
 * something in it, and invented markup would not have `data-start` attributes,
 * a stray `<meta charset>`, or a body that opens with another piece's size.
 */
const fixture = require('./fixtures/storefront-feed.json') as {
  products: { title: string; body_html: string; _why: string }[];
};

const feed: FeedProduct[] = fixture.products.map((p) => ({
  title: p.title,
  bodyHtml: p.body_html,
}));

const find = (why: string): FeedProduct => {
  const at = fixture.products.findIndex((p) => p._why.includes(why));
  if (at < 0) throw new Error(`no fixture product for "${why}"`);
  return feed[at]!;
};

describe('descriptionKey', () => {
  it('folds case, accents and punctuation so both sides of the join agree', () => {
    expect(descriptionKey('Malachite')).toBe('malachite');
    expect(descriptionKey('  MALACHITE  ')).toBe('malachite');
    expect(descriptionKey('Óceán Jáspis')).toBe('ocean jaspis');
    expect(descriptionKey('Blue Chalcedony')).toBe('blue chalcedony');
  });

  it('drops a trailing parenthetical, which holds a synonym or an origin', () => {
    expect(descriptionKey('Bowenite (New Jade)')).toBe('bowenite');
    expect(descriptionKey('Lemuriai Kvarc (Lemurian Quartz)')).toBe('lemuriai kvarc');
    expect(descriptionKey('Midnight Lace Obszidián (Örményország)')).toBe('midnight lace obszidian');
  });

  it('keeps a parenthetical that is not at the end, where it may carry meaning', () => {
    expect(descriptionKey('Natúr citrin (Kongó) rough')).toBe('natur citrin kongo rough');
  });

  it('does not collapse two different stones onto one key', () => {
    expect(descriptionKey('Azurite')).not.toBe(descriptionKey('Azurite Malachite'));
    expect(descriptionKey('Aragonite')).not.toBe(descriptionKey('Blue Aragonite'));
    expect(descriptionKey('Fluorite')).not.toBe(descriptionKey('Tiffany Fluorite'));
  });
});

describe('extractHeading', () => {
  it('reads the stone name from the leading heading', () => {
    expect(extractHeading(find('malachite dominant body').bodyHtml)).toBe('Malachite');
  });

  it('keeps the parenthetical for reporting, and normalises it only in the key', () => {
    const heading = extractHeading(find('trailing parenthetical').bodyHtml);
    expect(heading).toBe('Bowenite (New Jade)');
    expect(descriptionKey(heading!)).toBe('bowenite');
  });

  it('returns null for a body with no heading rather than guessing from the title', () => {
    expect(extractHeading(find('no heading').bodyHtml)).toBeNull();
  });

  it('ignores a heading that is not the first element', () => {
    expect(extractHeading('<p>Some prose first.</p><h3>Metaphysical Context</h3>')).toBeNull();
  });

  it('looks past the junk tags that precede a real heading', () => {
    expect(extractHeading(find('<meta charset> junk').bodyHtml)).toBe('Agate');
  });
});

describe('isPerPiece', () => {
  it('rejects a body that opens with one piece’s measurements', () => {
    expect(isPerPiece(find('contaminated').bodyHtml)).toBe(true);
  });

  it('accepts ordinary stone copy', () => {
    expect(isPerPiece(find('malachite dominant body').bodyHtml)).toBe(false);
    expect(isPerPiece(find('agate dominant body').bodyHtml)).toBe(false);
  });

  it('rejects the reference-photo disclaimer', () => {
    expect(
      isPerPiece('<p>Please note that the product photos are for reference only</p>'),
    ).toBe(true);
  });

  it('is not fooled by a measurement mentioned inside prose', () => {
    expect(isPerPiece('<p>Agate forms in cavities up to 30 cm across.</p>')).toBe(false);
  });
});

describe('sanitiseHtml', () => {
  const clean = sanitiseHtml(find('malachite dominant body').bodyHtml);

  it('strips every attribute, including the pasted data-start residue', () => {
    expect(clean).not.toMatch(/data-start|data-end|data-section-id/);
    expect(clean).not.toMatch(/\s(class|style|id|role)=/);
    expect(clean).not.toMatch(/<[a-z0-9]+\s/i);
  });

  it('keeps the tags that carry meaning', () => {
    expect(clean).toContain('<p>');
    expect(clean).toContain('<strong>');
  });

  it('unwraps span without losing its text', () => {
    expect(clean).not.toContain('<span');
    expect(clean).toContain('Fact &amp; Fun Fact:');
  });

  it('drops the stray meta tag some bodies carry', () => {
    expect(sanitiseHtml(find('<meta charset> junk').bodyHtml)).not.toMatch(/<meta/i);
  });

  it('drops script and style along with their contents', () => {
    const out = sanitiseHtml('<p>Real copy.</p><script>alert(1)</script><style>p{color:red}</style>');
    expect(out).toBe('<p>Real copy.</p>');
  });

  it('removes an event handler by removing all attributes', () => {
    expect(sanitiseHtml('<p onclick="steal()">Copy.</p>')).toBe('<p>Copy.</p>');
  });

  it('does not emit a closing tag for a void element', () => {
    expect(sanitiseHtml('<p>One<br />two</p>')).toBe('<p>One<br>two</p>');
  });

  it('leaves the prose itself untouched', () => {
    expect(toPlainText(clean)).toContain(
      'Malachite is known for its rich green color and distinctive banded patterns',
    );
  });
});

describe('stripLeadingHeading', () => {
  it('removes the stone-name heading and nothing else', () => {
    const out = stripLeadingHeading(sanitiseHtml(find('malachite dominant body').bodyHtml));
    expect(out).not.toMatch(/<h[1-6]>/);
    expect(out.startsWith('<p>')).toBe(true);
    expect(out).toContain('Malachite is known for');
  });

  it('leaves a later section heading in place', () => {
    expect(stripLeadingHeading('<h3>Agate</h3><p>Prose.</p><h5>Sources</h5>')).toBe(
      '<p>Prose.</p><h5>Sources</h5>',
    );
  });

  it('does nothing when the body has no heading', () => {
    expect(stripLeadingHeading('<p>Prose.</p>')).toBe('<p>Prose.</p>');
  });
});

describe('fingerprint', () => {
  it('treats bodies with the same prose but different markup as one', () => {
    expect(fingerprint('<p><span>Agate is banded.</span></p>')).toBe(
      fingerprint('<p data-start="1">Agate&nbsp;is banded.</p>'),
    );
  });

  it('separates genuinely different prose', () => {
    expect(fingerprint('<p>Agate is banded.</p>')).not.toBe(fingerprint('<p>Agate is green.</p>'));
  });
});

describe('buildCatalogue', () => {
  const catalogue = buildCatalogue(feed);

  it('keys stones by their normalised heading', () => {
    expect([...catalogue.keys()].sort()).toEqual(['agate', 'bowenite', 'malachite', 'moonstone']);
  });

  it('ignores bodies with no heading and empty bodies', () => {
    expect(catalogue.size).toBe(4);
  });

  it('picks the body used on the most products', () => {
    const malachite = catalogue.get('malachite')!;
    expect(malachite.used).toBe(2);
    expect(malachite.candidates).toBe(2);
    expect(malachite.tied).toBe(false);
    expect(toPlainText(malachite.html)).toContain('rich green color and distinctive banded patterns');
  });

  it('does not let the minority body win', () => {
    expect(toPlainText(catalogue.get('malachite')!.html)).not.toContain('copper-rich mineral admired');
  });

  it('strips the heading from the chosen body', () => {
    expect(catalogue.get('malachite')!.html).not.toMatch(/<h[1-6]>/);
  });

  it('reports the heading as the owner wrote it, parenthetical included', () => {
    expect(catalogue.get('bowenite')!.heading).toBe('Bowenite (New Jade)');
  });

  it('breaks a tie by length and says that it did', () => {
    const moonstone = catalogue.get('moonstone')!;
    expect(moonstone.tied).toBe(true);
    expect(moonstone.used).toBe(1);
    expect(moonstone.candidates).toBe(2);

    const others = fixture.products.filter((p) => p._why.includes('moonstone'));
    const longest = others
      .map((p) => toPlainText(p.body_html))
      .reduce((a, b) => (a.length >= b.length ? a : b));
    expect(toPlainText(moonstone.html).length).toBeLessThanOrEqual(longest.length);
    expect(toPlainText(moonstone.html).slice(0, 40)).toBe(
      stripHeadingText(longest).slice(0, 40),
    );
  });

  it('never chooses a body about one specific piece', () => {
    for (const chosen of catalogue.values()) {
      expect(isPerPiece(chosen.html)).toBe(false);
    }
    // The contaminated Rose Quartz was the only rose quartz in the fixture, so
    // excluding it must leave the stone absent rather than present-but-wrong.
    expect(catalogue.has('rose quartz')).toBe(false);
  });

  it('is empty for an empty feed rather than throwing', () => {
    expect(buildCatalogue([]).size).toBe(0);
  });
});

/** The plain text of a body minus its first line, which is the heading. */
function stripHeadingText(plain: string): string {
  return plain.split('\n').slice(1).join('\n').trim();
}

describe('lookupDescription', () => {
  const catalogue = buildCatalogue(feed);

  it('finds a stone by its English name', () => {
    expect(lookupDescription(catalogue, 'Malachite')?.chosen.heading).toBe('Malachite');
  });

  it('is case and accent insensitive', () => {
    expect(lookupDescription(catalogue, 'MALACHITE')).not.toBeNull();
  });

  it('finds a stone whose heading carried a parenthetical', () => {
    expect(lookupDescription(catalogue, 'Bowenite')?.chosen.heading).toBe('Bowenite (New Jade)');
  });

  it('returns null for a stone the store does not describe', () => {
    expect(lookupDescription(catalogue, 'Shattuckite')).toBeNull();
    expect(lookupDescription(catalogue, 'Azurite')).toBeNull();
  });

  it('follows a configured alias and names what it borrowed from', () => {
    const found = lookupDescription(catalogue, 'Tiffany Fluorite', {
      'tiffany fluorite': 'Agate',
    });
    expect(found?.borrowedFrom).toBe('Agate');
    expect(found?.chosen.heading).toBe('Agate');
  });

  it('does not invent an alias from a shared word', () => {
    expect(lookupDescription(catalogue, 'Tiffany Malachite')).toBeNull();
    expect(lookupDescription(catalogue, 'Malachite Sphere')).toBeNull();
  });

  it('returns null when an alias points at a stone that is also missing', () => {
    expect(lookupDescription(catalogue, 'Vera Cruz Amethyst', {
      'vera cruz amethyst': 'Amethyst',
    })).toBeNull();
  });

  it('returns null for an empty stone name', () => {
    expect(lookupDescription(catalogue, '')).toBeNull();
    expect(lookupDescription(catalogue, '   ')).toBeNull();
  });
});

describe('countDescribedStones — catching a catalogue read in the wrong language', () => {
  const catalogue = buildCatalogue(feed);

  it('counts the names the catalogue can describe', () => {
    expect(countDescribedStones(catalogue, ['Malachite', 'Agate', 'Shattuckite'])).toBe(2);
  });

  it('counts each name once even when the table repeats a translation', () => {
    // stone-names.json maps both "aventurin" and "AVENTURIN" to Aventurine.
    expect(countDescribedStones(catalogue, ['Malachite', 'malachite', 'MALACHITE'])).toBe(1);
  });

  it('returns zero for a catalogue in the wrong language', () => {
    // What the unprefixed ezoko.shop feed looks like: healthy, and useless.
    const hungarian = buildCatalogue([
      { title: 'Malachit gömb', bodyHtml: '<h3>Malachit</h3><p>A malachit egy réz ásvány.</p>' },
      { title: 'Szerpentin', bodyHtml: '<h3>Szerpentin</h3><p>A szerpentin egy ásványcsoport.</p>' },
    ]);
    expect(hungarian.size).toBe(2);
    expect(countDescribedStones(hungarian, ['Malachite', 'Serpentine'])).toBe(0);
  });

  it('is zero for an empty name list rather than throwing', () => {
    expect(countDescribedStones(catalogue, [])).toBe(0);
  });
});
