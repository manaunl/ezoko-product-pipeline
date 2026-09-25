/**
 * The run: read everything, decide everything, then create.
 *
 * Sequential on purpose. Eighty products is a handful of minutes and the store
 * is not in a hurry; running in parallel would buy little and cost us clear
 * ordering, simple rate-limit behaviour and a readable report.
 */

import { decideChannels, reachedAllChannels } from '../domain/channels.js';
import { loadDescriptionAliases } from '../domain/descriptions.js';
import { claimedSku, indexPhotos, normaliseSku } from '../domain/filenames.js';
import { findDuplicateSkus, rowToOutcome } from '../domain/mapping.js';
import { chooseRowsToAttempt } from '../domain/selection.js';
import { loadAuth } from '../google/auth.js';
import { listPhotoFiles } from '../google/drive.js';
import { readSheet } from '../google/sheets.js';
import { fetchDescriptionCatalogue } from '../storefront/feed.js';
import { writeResults, type WriteBackResult } from '../sheets/writeback.js';
import { storeDomain } from '../shopify/client.js';
import { findVariantBySku, primaryLocationId, probeChannels } from '../shopify/products.js';
import { adminUrl, createOne } from './create.js';
import type { ProductDraft } from '../domain/types.js';
import { ReportWriter, type ProductResult, type RunReport } from './report.js';
import { envPath, runsDir } from '../paths.js';
import { VERSION } from '../version.js';

export interface RunOptions {
  /** False (the default) previews without writing anything anywhere. */
  commit?: boolean;
  /** Stop after this many products would be created. The staged-rollout control. */
  limit?: number;
  /**
   * The Selection: create only these SKUs. Absent means every ready row.
   * Ignored by a preview, which always examines every row — selecting happens
   * after it.
   */
  skus?: string[];
  /** Directory for the run artifact. */
  runsDir?: string;
  onProgress?: (result: ProductResult, done: number, total: number) => void;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — fill it in on the setup page (${envPath()})`);
  return value;
}

export async function run(options: RunOptions = {}): Promise<RunReport> {
  const commit = options.commit ?? false;
  const auth = await loadAuth();

  const sheetId = env('GOOGLE_SHEET_ID');
  const sheet = await readSheet(auth, sheetId, process.env.GOOGLE_SHEET_TAB ?? '');
  if (sheet.columns.missingRequired.length > 0) {
    throw new Error(`required columns not found in the sheet: ${sheet.columns.missingRequired.join(', ')}`);
  }

  const files = await listPhotoFiles(auth, env('GOOGLE_DRIVE_FOLDER_ID'));
  const photos = indexPhotos(files);
  const duplicateSkus = findDuplicateSkus(sheet.rows);

  // A third precondition alongside the sheet and Drive. This throws on any
  // failed page rather than returning what it managed to read: a half-read
  // catalogue would silently drop stones, and their rows would be created with
  // an empty body looking exactly like the rows whose copy genuinely does not
  // exist yet. Nothing is created if this fails.
  const descriptions = await fetchDescriptionCatalogue();
  const descriptionAliases = loadDescriptionAliases();

  // A fourth precondition, and the only one that can refuse the whole run
  // rather than just reporting a gap: creating products nobody can reach
  // because a scope is missing would look exactly like a healthy run. See
  // ADR-0009.
  const channelsDecision = decideChannels(await probeChannels());
  if (!channelsDecision.proceed) throw new Error(channelsDecision.message);

  // Only rejections about a SKU the sheet actually asks about. The folder holds
  // photos for thousands of other pieces, and their naming problems are not
  // this run's business.
  const sheetSkus = new Set(sheet.rows.map((row) => normaliseSku(row.sku)).filter((sku) => sku !== ''));

  const report: RunReport = {
    version: VERSION,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    mode: commit ? 'commit' : 'preview',
    store: storeDomain(),
    sheet: { title: sheet.title, tab: sheet.tab, rows: sheet.rows.length },
    photos: {
      files: files.length,
      matched: [...photos.bySku.values()].reduce((n, list) => n + list.length, 0),
      skus: photos.bySku.size,
    },
    descriptions: {
      host: descriptions.host,
      products: descriptions.products,
      stones: descriptions.catalogue.size,
      // Filled in below, once the rows have been resolved.
      stonesWanted: 0,
      stonesMatched: 0,
    },
    channels: {
      names: channelsDecision.channels.map((channel) => channel.name),
      summary: channelsDecision.message,
      // Filled in below, once every product has been attempted.
      fullyAvailable: 0,
    },
    rejectedPhotos: photos.rejected
      .filter((r) => sheetSkus.has(claimedSku(r.file.name)))
      .map((r) => ({ name: r.file.name, reason: r.reason })),
    results: [],
    selectedNotInSheet: [],
    writeBack: null,
  };

  const writer = await ReportWriter.create(options.runsDir ?? runsDir(), report);

  // Write-back totals, accumulated across the per-product writes during the run
  // and the final pass over everything else.
  const writeBackTotals = { updated: 0, preserved: 0 };
  const notFound: string[] = [];
  const addedColumns: string[] = [];
  const writtenDuringRun = new Set<string>();
  let writeBackError: string | undefined;

  const addWriteBack = (result: WriteBackResult): void => {
    writeBackTotals.updated += result.updated;
    writeBackTotals.preserved += result.preserved;
    notFound.push(...result.notFound);
    for (const column of result.addedColumns) {
      if (!addedColumns.includes(column)) addedColumns.push(column);
    }
  };

  // Decide everything first, so the report is complete even if creation stops
  // early — and so `limit` counts products, not rows.
  const outcomes = sheet.rows.map((row) =>
    rowToOutcome(row, photos, {
      duplicateSkus,
      descriptions: descriptions.catalogue,
      descriptionAliases,
    }),
  );

  const creatable: { rowNumber: number; draft: ProductDraft }[] = [];

  for (const outcome of outcomes) {
    if (outcome.kind === 'skipped') {
      report.results.push({
        rowNumber: outcome.rowNumber,
        sku: outcome.sku,
        status: 'skipped',
        detail: outcome.reason,
      });
      continue;
    }
    if (outcome.kind === 'invalid') {
      report.results.push({
        rowNumber: outcome.rowNumber,
        sku: outcome.sku,
        status: 'invalid',
        detail: outcome.problems.map((p) => p.message).join(' | '),
      });
      continue;
    }
    creatable.push({ rowNumber: outcome.rowNumber, draft: outcome.draft });
  }

  // Description coverage over the stones this run could actually create, which
  // is the number that tells you whether the storefront is configured right.
  const wanted = new Map<string, boolean>();
  for (const { draft } of creatable) {
    const stone = draft.tags[0] ?? draft.title;
    wanted.set(stone, (wanted.get(stone) ?? false) || draft.descriptionFrom !== null);
  }
  report.descriptions.stonesWanted = wanted.size;
  report.descriptions.stonesMatched = [...wanted.values()].filter(Boolean).length;

  // A commit trusts nothing from the preview the SKUs were chosen from: every
  // row was re-read above, and each selected one is created only if it is
  // still ready now — and, in createOne, not already in Shopify.
  const choice = chooseRowsToAttempt(creatable, {
    limit: options.limit,
    skus: commit ? options.skus : undefined,
    sheetSkus,
  });
  const { attempt, notAttempted } = choice;
  report.selectedNotInSheet = choice.missingFromSheet;

  if (!commit) {
    // Preview asks Shopify too. Without this it reports rows it "would create"
    // that in fact already exist, which is exactly the question preview is
    // being asked. The lookup is read-only, so preview still writes nothing.
    let done = 0;

    for (const { rowNumber, draft } of attempt) {
      const base = { rowNumber, sku: draft.displaySku };

      try {
        const existing = await findVariantBySku(draft.displaySku);
        report.results.push(
          existing
            ? {
                ...base,
                title: existing.product.title,
                status: 'exists',
                productId: existing.product.id,
                adminUrl: adminUrl(existing.product.id),
                detail: `already in Shopify as a ${existing.product.status.toLowerCase()} product`,
              }
            : {
                ...base,
                title: draft.title,
                status: 'would-create',
                photos: { total: draft.photos.length, ready: 0, failed: 0 },
                warnings: draft.warnings,
              },
        );
      } catch (error: unknown) {
        // A lookup failure is not a creation failure — nothing was attempted.
        // Report it as unknown rather than promising it would be created.
        report.results.push({
          ...base,
          title: draft.title,
          status: 'would-create',
          photos: { total: draft.photos.length, ready: 0, failed: 0 },
          warnings: [
            ...draft.warnings,
            `could not check Shopify for this SKU: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ],
        });
      }

      done += 1;
      options.onProgress?.(report.results[report.results.length - 1]!, done, attempt.length);
      await writer.flush();
    }
  } else {
    const locationId = await primaryLocationId();
    let done = 0;

    for (const { rowNumber, draft } of attempt) {
      const result = await createOne(auth, draft, rowNumber, locationId, channelsDecision.channels);
      report.results.push(result);
      done += 1;
      options.onProgress?.(result, done, attempt.length);
      await writer.flush();

      // Record it in the sheet straight away rather than at the end of the run.
      // If the process dies after creating forty products, the sheet still says
      // so — otherwise it would be silent about forty products that exist.
      try {
        addWriteBack(await writeResults(auth, sheetId, sheet.tab, [result]));
        writtenDuringRun.add(result.sku);
      } catch (error: unknown) {
        // The product is created; failing to annotate the sheet must not stop
        // the run. The final pass, or the next run, will catch up.
        writeBackError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  for (const { rowNumber, draft, reason } of notAttempted) {
    report.results.push({
      rowNumber,
      sku: draft.displaySku,
      title: draft.title,
      status: 'skipped',
      detail: reason,
    });
  }
  report.results.sort((a, b) => a.rowNumber - b.rowNumber);

  // Only meaningful for a commit — a preview never calls `publishablePublish`.
  if (commit) {
    report.channels.fullyAvailable = report.results.filter(
      (r) => (r.status === 'created' || r.status === 'partial') && reachedAllChannels(r.warnings),
    ).length;
  }

  // Only a commit run writes to the sheet. A preview writes nothing anywhere,
  // and that promise is worth more than the convenience of a preview column.
  if (commit) {
    try {
      // Everything not already recorded during the run: rows needing a fix,
      // rows that already existed, and stale annotations to be cleared.
      const remaining = report.results.filter((r) => !writtenDuringRun.has(r.sku));
      if (remaining.length > 0) {
        addWriteBack(await writeResults(auth, sheetId, sheet.tab, remaining));
      }
    } catch (error: unknown) {
      // Failing to annotate the sheet must not turn a successful run into a
      // failed one — the products are created, and Shopify is the source of
      // truth. The sheet is a mirror.
      writeBackError = error instanceof Error ? error.message : String(error);
    }

    report.writeBack = {
      updated: writeBackTotals.updated,
      preserved: writeBackTotals.preserved,
      notFound,
      addedColumns,
      ...(writeBackError ? { error: writeBackError } : {}),
    };
  }

  report.finishedAt = new Date().toISOString();
  await writer.flush();

  return report;
}
