/**
 * The run report.
 *
 * This is a data structure, not print statements. The console renders it now;
 * the local web page will render the same objects later. Scattering
 * console.log through the pipeline would mean rebuilding all of it for the UI.
 *
 * It is written to disk after every product, not just at the end, so a crashed
 * run still leaves a readable record — and so the web page has something to
 * poll while a run is in progress.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export type ResultStatus =
  /** Preview only: this is what a commit run would create. */
  | 'would-create'
  | 'created'
  /** Created, but at least one photo failed to process. */
  | 'partial'
  /** Already in Shopify. Not an error — this is the guard working. */
  | 'exists'
  /** Not finished yet: no photos, no price, no stone name. Expected. */
  | 'skipped'
  /** Something a human must fix in the sheet. */
  | 'invalid'
  /** The API call failed. */
  | 'failed';

export interface ProductResult {
  rowNumber: number;
  sku: string;
  title?: string;
  status: ResultStatus;
  /** Reason for a skip, message for a failure, problems for an invalid row. */
  detail?: string;
  productId?: string;
  adminUrl?: string;
  photos?: { total: number; ready: number; failed: number };
  warnings?: string[];
}

export interface RunReport {
  /**
   * Which version produced this report.
   *
   * The support story is "send me the newest file in the runs folder", and the
   * first thing that file has to answer is which version was running — the
   * person sending it cannot be asked to know.
   */
  version: string;
  startedAt: string;
  finishedAt: string | null;
  mode: 'preview' | 'commit';
  store: string;
  sheet: { title: string; tab: string; rows: number };
  photos: { files: number; matched: number; skus: number };
  /**
   * Published copy inherited from the storefront.
   *
   * `stonesWanted` / `stonesMatched` count the distinct stones among the rows
   * this run could create. They are here so a misconfigured storefront URL —
   * pointing at the Hungarian default market, say, where no English stone name
   * can match — reads as "0 of 25 stones" instead of hiding as one warning per
   * row.
   */
  descriptions: {
    host: string;
    products: number;
    stones: number;
    stonesWanted: number;
    stonesMatched: number;
  };
  /**
   * Photo files we refused, with the reason.
   *
   * Only files whose SKU appears in the sheet. The owner's folder holds photos for
   * 4,449 SKUs against a 144-row sheet, and reporting all of them meant 1,020
   * red lines about pieces nobody had asked about — which made a healthy run
   * look broken. The `photos` counts above still show the whole folder.
   */
  rejectedPhotos: { name: string; reason: string }[];
  results: ProductResult[];
  /** Null on a preview, which writes nothing anywhere. */
  writeBack: {
    updated: number;
    notFound: string[];
    preserved: number;
    addedColumns: string[];
    error?: string;
  } | null;
}

export function countByStatus(report: RunReport): Record<ResultStatus, number> {
  const counts = {
    'would-create': 0,
    created: 0,
    partial: 0,
    exists: 0,
    skipped: 0,
    invalid: 0,
    failed: 0,
  } satisfies Record<ResultStatus, number>;

  for (const result of report.results) counts[result.status] += 1;
  return counts;
}

/** Something went wrong that a human should look at. */
export function hasFailures(report: RunReport): boolean {
  return report.results.some((r) => r.status === 'failed' || r.status === 'partial');
}

export class ReportWriter {
  private constructor(
    readonly jsonPath: string,
    private readonly report: RunReport,
  ) {}

  static async create(dir: string, report: RunReport): Promise<ReportWriter> {
    await fs.mkdir(dir, { recursive: true });
    const stamp = report.startedAt.replace(/[:.]/g, '-');
    return new ReportWriter(path.join(dir, `${stamp}.json`), report);
  }

  /** Called after every product, so a crash still leaves a usable record. */
  async flush(): Promise<void> {
    await fs.writeFile(this.jsonPath, JSON.stringify(this.report, null, 2));
  }
}
