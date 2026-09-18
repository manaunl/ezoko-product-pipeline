/**
 * Finding the columns by header name.
 *
 * Never by position: the moment anyone inserts a column, position-based reading
 * silently writes prices into the weight field. The real headers are bilingual
 * and untidy — "STONE Name " has a trailing space, "LENGHT/ DEPTH - hossz/
 * mélység in cm" is misspelled and carries its unit — so matching is done on a
 * trimmed, lowercased prefix of the English part.
 */

import type { SheetRow } from '../domain/types.js';

type Field = keyof Omit<SheetRow, 'rowNumber'>;

interface Matcher {
  field: Field;
  required: boolean;
  matches: (header: string) => boolean;
}

const startsWith = (prefix: string) => (header: string) => header.startsWith(prefix);
const equals = (value: string) => (header: string) => header === value;

const MATCHERS: Matcher[] = [
  { field: 'productType', required: true, matches: startsWith('product type') },
  { field: 'stoneName', required: true, matches: startsWith('stone name') },
  { field: 'sku', required: true, matches: equals('sku') },
  { field: 'price', required: true, matches: startsWith('price') },
  { field: 'photoStatus', required: true, matches: startsWith('photo status') },
  { field: 'productName', required: false, matches: startsWith('product name') },
  { field: 'weight', required: false, matches: startsWith('weight') },
  { field: 'height', required: false, matches: startsWith('height') },
  { field: 'width', required: false, matches: startsWith('width') },
  // The sheet spells it "LENGHT". Accept both, since it may get corrected.
  { field: 'depth', required: false, matches: (h) => h.startsWith('lenght') || h.startsWith('length') },
];

export function normaliseHeader(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface ColumnMap {
  /** Field -> zero-based column index. */
  index: Partial<Record<Field, number>>;
  missingRequired: Field[];
  missingOptional: Field[];
}

export function mapColumns(header: string[]): ColumnMap {
  const normalised = header.map(normaliseHeader);
  const index: Partial<Record<Field, number>> = {};

  for (const matcher of MATCHERS) {
    const at = normalised.findIndex((h) => h !== '' && matcher.matches(h));
    if (at >= 0) index[matcher.field] = at;
  }

  return {
    index,
    missingRequired: MATCHERS.filter((m) => m.required && index[m.field] === undefined).map(
      (m) => m.field,
    ),
    missingOptional: MATCHERS.filter((m) => !m.required && index[m.field] === undefined).map(
      (m) => m.field,
    ),
  };
}

/** `values` is the raw grid from Sheets, header row included. */
export function toRows(values: string[][]): { columns: ColumnMap; rows: SheetRow[] } {
  const [header = [], ...body] = values;
  const columns = mapColumns(header);

  const cell = (row: string[], field: Field): string => {
    const at = columns.index[field];
    if (at === undefined) return '';
    return (row[at] ?? '').toString();
  };

  const rows = body
    .map((row, i) => ({
      rowNumber: i + 2, // 1-based, plus the header row
      sku: cell(row, 'sku'),
      stoneName: cell(row, 'stoneName'),
      productType: cell(row, 'productType'),
      productName: cell(row, 'productName'),
      price: cell(row, 'price'),
      weight: cell(row, 'weight'),
      height: cell(row, 'height'),
      width: cell(row, 'width'),
      depth: cell(row, 'depth'),
      photoStatus: cell(row, 'photoStatus'),
    }))
    // Entirely blank rows are padding at the bottom of the sheet, not errors.
    .filter((row) => Object.values(row).some((v) => typeof v === 'string' && v.trim() !== ''));

  return { columns, rows };
}
