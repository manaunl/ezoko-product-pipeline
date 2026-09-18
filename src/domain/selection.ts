/**
 * Which creatable rows a run attempts.
 *
 * Everything upstream has already decided which rows *could* become products.
 * This decides which of those this run actually tries, and says why about the
 * rest, so the report can show them rather than silently leave them out.
 */

import { normaliseSku } from './filenames.js';

/** The detail on a ready row a commit wasn't asked to create. */
export const NOT_SELECTED = 'not selected';

const limitedTo = (limit: number | undefined) =>
  `not attempted — the run was limited to ${limit} products`;

/** A ready row this run left alone: not selected, or past the limit. */
export function wasNotAttempted(result: { status: string; detail?: string }): boolean {
  return (
    result.status === 'skipped' &&
    (result.detail === NOT_SELECTED || (result.detail ?? '').startsWith('not attempted — '))
  );
}

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
      notAttempted.push({ ...row, reason: NOT_SELECTED });
    } else {
      selected.push(row);
    }
  }

  const attempt = options.limit == null ? selected : selected.slice(0, options.limit);
  for (const row of selected.slice(attempt.length)) {
    notAttempted.push({
      ...row,
      reason: limitedTo(options.limit),
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

/** The part of a result the picture needs. */
export interface ShownResult {
  rowNumber: number;
  sku: string;
  status: string;
  detail?: string;
}

/**
 * What the page shows once commits have followed a preview: the preview, with
 * what each commit actually did laid over it, in the order they ran.
 *
 * A commit only looks closely at the rows it was asked to create. Everything
 * else comes back as a bare "not selected" — no warnings, no photo count, and
 * no word on whether it is already in Shopify — so for those rows the preview
 * is still the better account, and is kept. Anything a commit did report about
 * a row (created, failed, now needs fixing) is newer, and replaces it.
 *
 * A row a commit found that the preview never showed, and left alone, is left
 * out: it was never on the owner's screen to be chosen.
 */
export function pictureSincePreview<T extends ShownResult>(preview: T[], commits: T[][]): T[] {
  // By SKU, since a row can move between runs. A SKU on two rows has two
  // results, so each key holds a list.
  const key = (r: T) => normaliseSku(r.sku) || `row ${r.rowNumber}`;
  const byKey = new Map<string, T[]>();
  const add = (into: Map<string, T[]>, r: T) => into.set(key(r), [...(into.get(key(r)) ?? []), r]);

  for (const r of preview) add(byKey, r);

  for (const commit of commits) {
    const reported = new Map<string, T[]>();
    for (const r of commit) if (!wasNotAttempted(r)) add(reported, r);
    for (const [k, results] of reported) byKey.set(k, results);
  }

  return [...byKey.values()].flat().sort((a, b) => a.rowNumber - b.rowNumber);
}
