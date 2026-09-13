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

export function formatHuf(value: number): string {
  return `${value.toLocaleString('hu-HU')} Ft`;
}
