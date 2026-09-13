/**
 * Inheriting product copy from the live storefront.
 *
 * The owner writes one description per *stone* and reuses it across every piece of
 * that stone — 100 of his 103 published agates carry the same body. So the
 * description for a new piece is not something to invent: it already exists in
 * his catalogue, and the job here is to find the right one and copy it exactly.
 *
 * Everything in this file is pure. The fetching lives in `src/storefront/`, so
 * the selection rules — which are where a mistake puts the wrong mineral's
 * chemistry on a product page — can be tested against saved fixtures with no
 * network and no credentials.
 *
 * The rules, each one earned from looking at the real 2,550 products:
 *
 *   key       the `<h3>` heading that opens the body, not the product title.
 *             Titles carry per-piece noise ("- 45cm/13mm"); the heading is the
 *             stone name and nothing else.
 *   match     exact, after normalising. The store contains "Azurite Malachite"
 *             and "Blue Aragonite" but no plain Azurite or Aragonite, so any
 *             prefix or substring rule confidently returns the wrong mineral.
 *   choose    the body used on the most products wins. Frequency is evidence of
 *             what the owner settled on; anything else is us guessing over him.
 *   reject    candidates carrying another piece's data — a body that opens
 *             "Dimension: 49cm" is a true statement about a different stone.
 */

import { createRequire } from 'node:module';

/** One product as the storefront feed reports it. Only what we read. */
export interface FeedProduct {
  title: string;
  bodyHtml: string;
}

/** A description chosen for one stone, with the workings shown. */
export interface ChosenDescription {
  /** Sanitised HTML, ready to send to Shopify. */
  html: string;
  /** The heading it was found under, exactly as the owner wrote it. */
  heading: string;
  /** How many published products carry this body. */
  used: number;
  /** How many distinct bodies were considered for this stone. */
  candidates: number;
  /**
   * True when no single body was the most common and length decided it. Worth
   * telling a human about: it means the store disagrees with itself.
   */
  tied: boolean;
}

/** Normalised stone key -> the description chosen for it. */
export type DescriptionCatalogue = Map<string, ChosenDescription>;

/**
 * Tags kept when sanitising, chosen by counting what actually appears in the
 * 2,550 live bodies rather than from imagination. Everything else is unwrapped
 * (its text survives, the tag does not) or, if void, dropped.
 *
 * `span` and `div` are deliberately absent: they carry nothing but the editor's
 * own noise and account for 15,000 of the tags in the feed.
 */
const KEEP_TAGS = new Set([
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'ul',
  'ol',
  'li',
  'blockquote',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
]);

/** Void tags that must not get a closing tag. */
const VOID_TAGS = new Set(['br', 'hr']);

/**
 * Tags whose *contents* are markup or metadata, not prose. Dropped whole —
 * unwrapping them would spill CSS or script text into the description.
 */
const DROP_WITH_CONTENTS = ['script', 'style', 'head', 'title', 'noscript'];

/**
 * Markers that a body is about one specific piece rather than the stone.
 *
 * These are real: one Rose Quartz body opens "Dimension: 49cm", another carries
 * a "photos are for reference only" disclaimer. Inheriting either states a
 * measured fact about the wrong object, which is worse than saying nothing.
 */
const PER_PIECE_MARKERS = [
  /\bdimensions?\s*:/i,
  /\bsize\s*:/i,
  /\bweight\s*:/i,
  /photos?\s+are\s+for\s+reference\s+only/i,
];

/** Strips tags and decodes the handful of entities the feed actually uses. */
export function toPlainText(html: string): string {
  const withBreaks = html.replace(/<\s*\/?\s*(br|p|div|h[1-6]|li|tr)\b[^>]*>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]*>/g, '');
  return decodeEntities(stripped).replace(/[^\S\n]+/g, ' ').replace(/\n{2,}/g, '\n\n').trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    rsquo: '’',
    lsquo: '‘',
    rdquo: '”',
    ldquo: '“',
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return named[body.toLowerCase()] ?? whole;
  });
}

/**
 * The heading that opens the body, which is the stone name.
 *
 * Only a *leading* heading counts. 121 bodies carry several headings, and a
 * later one is a section title ("Metaphysical Context"), not the stone.
 */
export function extractHeading(bodyHtml: string): string | null {
  const withoutJunk = stripDroppedElements(bodyHtml);
  const match = /^\s*(?:<[^>]*>\s*)*?<\s*h[1-6]\b[^>]*>(.*?)<\s*\/\s*h[1-6]\s*>/is.exec(withoutJunk);
  if (!match?.[1]) return null;

  const text = toPlainText(match[1]).trim();
  return text === '' ? null : text;
}

/**
 * The lookup key for a stone name, from either side of the join.
 *
 * A trailing parenthetical is dropped: the store writes "Bowenite (New Jade)"
 * and "Lemuriai Kvarc (Lemurian Quartz)", where the bracket holds a synonym or
 * an origin rather than a different stone. Accents are folded so "Óceán" and
 * "Ocean" normalise alike.
 */
export function descriptionKey(name: string): string {
  return name
    .replace(/\s*\([^()]*\)\s*$/g, ' ')
    .normalize('NFD')
    .replace(/\p{Mn}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when this body describes one specific piece, not the stone. */
export function isPerPiece(bodyHtml: string): boolean {
  const text = toPlainText(bodyHtml);
  return PER_PIECE_MARKERS.some((marker) => marker.test(text));
}

/**
 * Identity of a body for voting. Two products "carry the same description" when
 * their prose matches — whitespace, entities and the editor's tag soup differ
 * constantly between products that are otherwise identical.
 */
export function fingerprint(bodyHtml: string): string {
  return toPlainText(bodyHtml).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function stripDroppedElements(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of DROP_WITH_CONTENTS) {
    out = out.replace(new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*?<\\s*/\\s*${tag}\\s*>`, 'gi'), '');
    // An unclosed one would otherwise survive as a bare tag.
    out = out.replace(new RegExp(`<\\s*/?\\s*${tag}\\b[^>]*>`, 'gi'), '');
  }
  return out;
}

/**
 * Reduces the feed's HTML to the tags we want, with every attribute removed.
 *
 * The attributes are not decoration: 14,598 `data-start`/`data-end` pairs are
 * residue from pasting out of a chat window, and `style` and `class` reference a
 * theme that has nothing to do with a product body. Dropping all of them also
 * disposes of any `on*` handler without needing to enumerate them.
 */
export function sanitiseHtml(html: string): string {
  const body = stripDroppedElements(html);

  const rebuilt = body.replace(
    /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)\s*>/g,
    (_whole, closing: string, rawName: string) => {
      const name = rawName.toLowerCase();
      if (!KEEP_TAGS.has(name)) return '';
      if (VOID_TAGS.has(name)) return closing === '/' ? '' : `<${name}>`;
      return `<${closing === '/' ? '/' : ''}${name}>`;
    },
  );

  return tidy(rebuilt);
}

/** Collapses the empty paragraphs and stray whitespace that unwrapping leaves. */
function tidy(html: string): string {
  return html
    .replace(/<p>(?:\s|<br>|&nbsp;)*<\/p>/gi, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/(<\/(?:p|h[1-6]|ul|ol|li|blockquote)>)\s*/gi, '$1\n')
    .replace(/\s*(<(?:p|h[1-6]|ul|ol|li|blockquote)>)/gi, '\n$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Removes the leading stone-name heading.
 *
 * The product title already says which stone this is, so the heading only
 * repeats it — and for a stone borrowing another's copy through an alias it
 * would contradict the title outright, announcing "Fluorite" above a product
 * called "Tiffany Fluorite Sphere".
 */
export function stripLeadingHeading(html: string): string {
  return html.replace(/^\s*<\s*h[1-6]\b[^>]*>[\s\S]*?<\s*\/\s*h[1-6]\s*>\s*/i, '').trim();
}

interface Candidate {
  bodyHtml: string;
  heading: string;
  count: number;
}

/**
 * Groups every published body by stone and chooses one per stone.
 *
 * Products with no heading are ignored rather than guessed at — 901 of the live
 * bodies have none, and they are the older hand-written bilingual listings whose
 * stone cannot be read off reliably.
 */
export function buildCatalogue(products: readonly FeedProduct[]): DescriptionCatalogue {
  const byStone = new Map<string, Map<string, Candidate>>();

  for (const product of products) {
    const body = product.bodyHtml?.trim();
    if (!body) continue;

    const heading = extractHeading(body);
    if (heading === null) continue;

    const key = descriptionKey(heading);
    if (key === '') continue;

    // Excluded before voting, so one contaminated body can never win and never
    // distorts the count of the bodies that are genuinely about the stone.
    if (isPerPiece(body)) continue;

    const candidates = byStone.get(key) ?? new Map<string, Candidate>();
    byStone.set(key, candidates);

    const print = fingerprint(body);
    if (print === '') continue;

    const existing = candidates.get(print);
    if (existing) existing.count += 1;
    else candidates.set(print, { bodyHtml: body, heading, count: 1 });
  }

  const catalogue: DescriptionCatalogue = new Map();

  for (const [key, candidates] of byStone) {
    const chosen = choose([...candidates.values()]);
    if (chosen) catalogue.set(key, chosen);
  }

  return catalogue;
}

/**
 * Most-used body wins. A tie goes to the longest.
 *
 * Moonstone is the real case: five published products, five different bodies,
 * no vote to separate them. Length is an arbitrary but *deterministic*
 * tie-break, and it picks the most complete of the five — but the caller is
 * told it happened, because the honest fix is for the owner to standardise his copy.
 */
function choose(candidates: Candidate[]): ChosenDescription | null {
  if (candidates.length === 0) return null;

  const most = Math.max(...candidates.map((c) => c.count));
  const leaders = candidates.filter((c) => c.count === most);
  const winner = leaders.reduce((best, c) =>
    toPlainText(c.bodyHtml).length > toPlainText(best.bodyHtml).length ? c : best,
  );

  const html = stripLeadingHeading(sanitiseHtml(winner.bodyHtml));
  if (html === '') return null;

  return {
    html,
    heading: winner.heading,
    used: winner.count,
    candidates: candidates.length,
    tied: leaders.length > 1,
  };
}

/**
 * How many of the given stone names the catalogue can describe.
 *
 * The point of this is to catch a catalogue read in the wrong language. A
 * Hungarian feed produces a perfectly healthy-looking 276 stones — it is just
 * that they are called Szerpentin and Rózsakvarc, so every English lookup
 * misses and every product is created with an empty body. Counting known names
 * distinguishes them without naming any single stone: 47 against 3.
 */
export function countDescribedStones(
  catalogue: DescriptionCatalogue,
  stoneNames: readonly string[],
): number {
  const keys = new Set(stoneNames.map(descriptionKey));
  let found = 0;
  for (const key of keys) if (catalogue.has(key)) found += 1;
  return found;
}

/** What the lookup found, and how. */
export interface DescriptionLookup {
  chosen: ChosenDescription;
  /** Set when an alias redirected the lookup, naming the stone borrowed from. */
  borrowedFrom?: string;
}

/**
 * Finds the description for a stone, following an alias if one is configured.
 *
 * Aliases are deliberate human decisions, never inferred. "Tiffany Fluorite"
 * only borrows Fluorite's copy because somebody wrote that down; the tool will
 * not reason its way there from the shared word, because the same reasoning
 * turns Azurite into Lapis Lazuli.
 */
export function lookupDescription(
  catalogue: DescriptionCatalogue,
  stoneEnglish: string,
  aliases: Readonly<Record<string, string>> = {},
): DescriptionLookup | null {
  const key = descriptionKey(stoneEnglish);
  if (key === '') return null;

  const direct = catalogue.get(key);
  if (direct) return { chosen: direct };

  const aliasTarget = aliases[key];
  if (aliasTarget === undefined) return null;

  const borrowed = catalogue.get(descriptionKey(aliasTarget));
  return borrowed ? { chosen: borrowed, borrowedFrom: aliasTarget } : null;
}

/**
 * The curated alias table from `data/description-aliases.json`.
 *
 * Kept out of the functions above so the selection rules stay pure and take
 * their aliases as an argument — the same shape `stone-names.json` has, and for
 * the same reason: it can be edited without touching code.
 */
export function loadDescriptionAliases(): Record<string, string> {
  const require = createRequire(import.meta.url);
  const table = require('../../data/description-aliases.json') as Record<string, string>;

  return Object.fromEntries(
    Object.entries(table)
      .filter(([key]) => !key.startsWith('_'))
      .map(([stone, borrowFrom]) => [descriptionKey(stone), borrowFrom]),
  );
}
