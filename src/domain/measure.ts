/**
 * Measurements, with the unit read from the cell rather than the header.
 *
 * The real sheet writes "37 mm", "80g", "5-6 cm", "17 cm (box)". Three things
 * follow from that:
 *
 *   - Values carry their own units and the units disagree with the headers (the
 *     WIDTH header implies cm, the data is millimetres). Trusting the cell over
 *     the header is what stops a 37 mm sphere being published as 37 cm.
 *   - Some pieces are measured as a range, because the size genuinely varies.
 *     We keep both ends rather than inventing a single figure.
 *   - Some cells carry a parenthetical note. We keep the note and parse the
 *     number, rather than refusing the whole cell over it.
 */

export type LengthUnit = 'mm' | 'cm';
export type MassUnit = 'g' | 'kg';
export type Unit = LengthUnit | MassUnit;

export interface Measure {
  /** The value, or the lower bound of a range. */
  value: number;
  /** Upper bound when the cell held a range, otherwise null. */
  max: number | null;
  unit: Unit;
  /** Parenthetical note from the cell, e.g. "box". */
  note: string | null;
}

export type MeasureResult =
  | { ok: true; measure: Measure }
  | { ok: false; reason: string };

const UNIT_SUFFIX = /(mm|cm|kg|g)$/;

/** Blank, or one of the placeholders the owner uses for "not filled in yet". */
export function isBlank(raw: string | undefined | null): boolean {
  if (raw == null) return true;
  const value = raw.trim();
  return value === '' || value === '?' || value === '-';
}

function stripUnit(part: string): { number: string; unit: Unit | null } {
  const match = part.match(UNIT_SUFFIX);
  if (!match) return { number: part, unit: null };
  return { number: part.slice(0, -match[1]!.length), unit: match[1] as Unit };
}

function parseScalar(part: string): number | null {
  if (part === '') return null;
  if (!/^[\d.,]+$/.test(part)) return null;

  const separators = part.match(/[.,]/g) ?? [];
  if (separators.length > 1) return null;

  const value = Number(part.replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * `fallbackUnit` is the unit to assume when the cell is a bare number. Pass
 * `null` for columns where there is no safe assumption — the WIDTH header
 * carries no unit and the data is millimetres, so a bare `37` there could
 * plausibly mean either 37 mm or 37 cm. We refuse rather than guess.
 */
export function parseMeasure(
  raw: string,
  fallbackUnit: Unit | null,
  label: string,
): MeasureResult {
  const shown = raw.trim();

  // Pull out "(box)" and similar before touching the number.
  let note: string | null = null;
  const noteMatch = shown.match(/\(([^)]*)\)/);
  const withoutNote = noteMatch ? shown.replace(noteMatch[0], ' ') : shown;
  if (noteMatch?.[1]) note = noteMatch[1].trim() || null;

  const cleaned = withoutNote
    .replace(/ /g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');

  if (cleaned === '') return { ok: false, reason: `${label} is empty` };

  // A range: "5-6 cm", "2,5-3,5cm". Split before stripping units, since either
  // half may carry one.
  const halves = cleaned.split('-');
  if (halves.length > 2) {
    return { ok: false, reason: `${label} "${shown}" is not a number or a range` };
  }

  const parsedHalves = halves.map((half) => stripUnit(half));
  const unit =
    parsedHalves[parsedHalves.length - 1]?.unit ?? parsedHalves[0]?.unit ?? fallbackUnit;

  if (unit == null) {
    return {
      ok: false,
      reason: `${label} "${shown}" has no unit — write it as "37 mm" or "3,7 cm"`,
    };
  }

  const values = parsedHalves.map((half) => parseScalar(half.number));
  if (values.some((value) => value === null)) {
    return { ok: false, reason: `${label} "${shown}" is not a number` };
  }

  const [low, high = null] = values as number[];
  if (high !== null && high < low!) {
    return { ok: false, reason: `${label} "${shown}" has its range the wrong way round` };
  }

  return { ok: true, measure: { value: low!, max: high, unit, note } };
}

/** Trims pointless trailing zeros: 37 -> "37", 24.70 -> "24.7". */
export function formatNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** "37 mm", "5–6 cm", "17 cm (box)" — in the unit it was written in. */
export function formatMeasure(measure: Measure): string {
  const range =
    measure.max === null
      ? formatNumber(measure.value)
      : `${formatNumber(measure.value)}–${formatNumber(measure.max)}`;

  return `${range} ${measure.unit}${measure.note ? ` (${measure.note})` : ''}`;
}

/**
 * Rounded for titles: titles are for scanning, the spec line is for deciding.
 * A range shows its upper bound, which is the figure a buyer pictures.
 */
export function formatMeasureRounded(measure: Measure): string {
  return `${Math.round(measure.max ?? measure.value)} ${measure.unit}`;
}

export function toGrams(measure: Measure): number | null {
  if (measure.unit === 'g') return measure.value;
  if (measure.unit === 'kg') return measure.value * 1000;
  return null;
}
