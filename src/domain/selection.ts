/**
 * Which creatable rows a run attempts.
 *
 * Everything upstream has already decided which rows *could* become products.
 * This decides which of those this run actually tries, and says why about the
 * rest, so the report can show them rather than silently leave them out.
 */

import { normaliseSku } from './filenames.js';

/** A creatable row, reduced to what the choice looks at. */
export interface Candidate {
  rowNumber: number;
  draft: { sku: string };
}

export interface ChoiceOptions {
  /**
   * The Selection: the SKUs the owner ticked. Absent means every creatable
   * row; empty means none.
   */
  skus?: string[];
  /** Stop after this many. Absent means no limit. */
  limit?: number;
  /** Every SKU in the sheet, whatever became of its row. */
  sheetSkus: Iterable<string>;
}

export interface Choice<T extends Candidate> {
  /** In row order. */
  attempt: T[];
  /** In row order, each with the detail the report shows for it. */
  notAttempted: (T & { reason: string })[];
  missingFromSheet: string[];
}

export function chooseRowsToAttempt<T extends Candidate>(
  creatable: T[],
  options: ChoiceOptions,
): Choice<T> {
  const selection = options.skus == null ? null : new Set(options.skus.map(normaliseSku));

  // Reported as typed, once each. A row that exists but isn't creatable needs
  // nothing here — it already has its own result.
  const inSheet = new Set([...options.sheetSkus].map(normaliseSku));
  const missingFromSheet: string[] = [];
  const reported = new Set<string>();
  for (const sku of options.skus ?? []) {
    const key = normaliseSku(sku);
    if (key === '' || inSheet.has(key) || reported.has(key)) continue;
    reported.add(key);
    missingFromSheet.push(sku.trim());
  }
  const selected: T[] = [];
  const notAttempted: (T & { reason: string })[] = [];

  for (const row of creatable) {
    if (selection && !selection.has(row.draft.sku)) {
      // The page tells these rows apart from unready ones by this exact text.
      notAttempted.push({ ...row, reason: 'not selected' });
    } else {
      selected.push(row);
    }
  }

  const attempt = options.limit == null ? selected : selected.slice(0, options.limit);
  for (const row of selected.slice(attempt.length)) {
    notAttempted.push({
      ...row,
      reason: `not attempted — the run was limited to ${options.limit} products`,
    });
  }
  notAttempted.sort((a, b) => a.rowNumber - b.rowNumber);

  return { attempt, notAttempted, missingFromSheet };
}

/** The part of a run report that says when it was a preview that finished. */
export interface ReportTiming {
  mode: 'preview' | 'commit';
  finishedAt: string | null;
}

/**
 * When the most recent finished preview finished, or null if there is none.
 *
 * This starts the clock on a Selection. Only a finished preview counts: a
 * commit doesn't show the owner the whole sheet, and a preview that crashed or
 * is still running never showed him anything.
 */
export function latestFinishedPreview(reports: ReportTiming[]): string | null {
  let latest: string | null = null;
  for (const report of reports) {
    if (report.mode !== 'preview' || report.finishedAt === null) continue;
    if (latest === null || Date.parse(report.finishedAt) > Date.parse(latest)) {
      latest = report.finishedAt;
    }
  }
  return latest;
}
