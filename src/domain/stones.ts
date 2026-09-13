/**
 * Hungarian stone names -> English, because the sheet is Hungarian and the
 * storefront is English.
 *
 * The table lives in data/stone-names.json so it can be extended without
 * touching code. An unknown name is passed through unchanged rather than
 * blocking the product — and reported, so the list grows as new stones appear
 * instead of silently going untranslated forever.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const table = require('../../data/stone-names.json') as Record<string, string>;

const LOOKUP = new Map(
  Object.entries(table)
    .filter(([key]) => !key.startsWith('_'))
    .map(([hu, en]) => [hu.trim().toLowerCase(), en]),
);

/**
 * Every English name this table can produce, deduplicated.
 *
 * Used to check that inherited copy is being read in English: the Hungarian
 * storefront knows 3 of these names, the English one knows 47, so counting
 * them tells the two apart without hard-coding a single stone.
 */
export function englishStoneNames(): string[] {
  return [...new Set(LOOKUP.values())];
}

export interface StoneName {
  english: string;
  /** True when we had no translation and passed the Hungarian through. */
  untranslated: boolean;
}

export function translateStone(raw: string): StoneName {
  const key = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  // "?" is the owner's placeholder for "not decided yet", not a stone.
  if (key === '' || key === '?' || key === '-') return { english: '', untranslated: false };

  const english = LOOKUP.get(key);
  if (english) return { english, untranslated: false };

  return { english: titleCase(raw), untranslated: true };
}

/** "SPHERE" -> "Sphere", "TIGER'S EYE" -> "Tiger's Eye". Unicode-safe. */
export function titleCase(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('hu-HU')
    .replace(/(^|[\s\-/])(\p{L})/gu, (_, prefix: string, letter: string) =>
      prefix + letter.toLocaleUpperCase('hu-HU'),
    );
}
