/**
 * Price parsing.
 *
 * Hungarian number formatting is hostile to naive parsing: the decimal
 * separator is a comma and the thousands separator is a space or a full stop,
 * so `45.000` means forty-five thousand.
 *
 * HUF prices are whole forints in practice, so we take the digits and discard
 * every separator. `45.000`, `45 000`, `45000` and `6500 Ft` all give the same
 * answer, and there is nothing left to guess at.
 *
 * Measurements are a different problem — they genuinely have decimals — and
 * live in measure.ts.
 */

export type PriceResult = { ok: true; value: number } | { ok: false; reason: string };

export function parseHufPrice(raw: string): PriceResult {
  const shown = raw.trim();
  if (shown === '') return { ok: false, reason: 'price is empty' };

  if (shown.startsWith('-')) return { ok: false, reason: `price "${shown}" is negative` };

  const digits = shown.replace(/[^\d]/g, '');
  if (digits === '') return { ok: false, reason: `price "${shown}" contains no digits` };

  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, reason: `price "${shown}" is not a positive amount` };
  }
  return { ok: true, value };
}

/**
 * The owner's Stock cell: how many identical pieces the row stands for, set once
 * as the product's starting quantity.
 *
 * He also types notes into this column ("the stoen is broken"), so anything
 * that is not plainly a whole number above zero is refused rather than read as
 * 1 — a note created at 1 would list a piece he has written is broken. The
 * units he naturally adds, Hungarian `db` and English `pcs`, are accepted.
 * Empty means one unique piece, as before the column existed. A bare `-`,
 * which other columns treat as empty, is refused here: in a quantity column it
 * may as well mean none, and guessing 1 would list it. The `?`
 * placeholder is the caller's to handle: it skips the row, which is not this
 * function's decision.
 */
export type StockResult = { ok: true; value: number } | { ok: false; reason: string };

const STOCK = /^(\d+)\s*(?:db|pcs)?$/i;

export function parseStock(raw: string): StockResult {
  const shown = raw.trim();
  if (shown === '') return { ok: true, value: 1 };

  const digits = shown.match(STOCK)?.[1];
  const value = digits === undefined ? NaN : Number(digits);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return {
      ok: false,
      reason: `Stock "${shown}" is not a quantity. Stock must be a whole number such as 1 or 10. Keep notes in another column.`,
    };
  }
  return { ok: true, value };
}

export function formatHuf(value: number): string {
  return `${value.toLocaleString('hu-HU')} Ft`;
}

/**
 * The price with the starting stock beside it, as a preview shows it:
 * "8 500 Ft × 28". A single piece shows the price alone — that is every unique
 * stone, and marking each of them "× 1" would bury the rows that differ.
 *
 * The quantity appears nowhere else the owner checks before creating a row,
 * and once the product exists Shopify's count is the truth, not this one.
 */
export function formatPriceWithStock(priceHuf: number, stock: number): string {
  return stock === 1 ? formatHuf(priceHuf) : `${formatHuf(priceHuf)} × ${stock}`;
}
