/**
 * Run the pipeline.
 *
 *   npx tsx src/scripts/run.ts                  # preview — writes nothing
 *   npx tsx src/scripts/run.ts --commit         # create everything ready
 *   npx tsx src/scripts/run.ts --commit --limit 3
 *   npx tsx src/scripts/run.ts --commit --sku SP-190-B --sku CA-738-A1
 *
 * Preview is the default and --commit is required to write, because the
 * dangerous thing should be the one you have to ask for.
 */

import '../bootstrap.js';

import { run } from '../run/runner.js';
import { countByStatus, hasFailures, type ProductResult, type RunReport } from '../run/report.js';
import { runsDir } from '../paths.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BLUE = '\x1b[34m';
const OFF = '\x1b[0m';

const LABEL: Record<ProductResult['status'], { text: string; colour: string }> = {
  'would-create': { text: 'WOULD CREATE', colour: BLUE },
  created: { text: 'CREATED', colour: GREEN },
  partial: { text: 'PARTIAL', colour: YELLOW },
  exists: { text: 'EXISTS', colour: DIM },
  skipped: { text: 'NOT READY', colour: DIM },
  invalid: { text: 'NEEDS FIXING', colour: RED },
  failed: { text: 'FAILED', colour: RED },
};

function parseLimit(): number | undefined {
  const at = process.argv.indexOf('--limit');
  if (at < 0) return undefined;

  const value = Number(process.argv[at + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('--limit needs a whole number, e.g. --limit 3');
  }
  return value;
}

/** Every `--sku`, in order. Undefined when there are none, meaning everything. */
function parseSkus(): string[] | undefined {
  const skus: string[] = [];
  process.argv.forEach((arg, at) => {
    if (arg !== '--sku') return;
    const value = process.argv[at + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('--sku needs a SKU after it, e.g. --sku SP-190-B');
    }
    skus.push(value);
  });
  return skus.length > 0 ? skus : undefined;
}

function printResult(result: ProductResult): void {
  const label = LABEL[result.status];
  console.log(
    `  ${label.colour}${label.text.padEnd(12)}${OFF} ${result.sku.padEnd(14)} ` +
      `${result.title ?? ''}`,
  );
  if (result.photos && result.status !== 'would-create') {
    console.log(`               ${DIM}${result.photos.ready}/${result.photos.total} photos${OFF}`);
  }
  if (result.adminUrl && (result.status === 'created' || result.status === 'partial')) {
    console.log(`               ${DIM}${result.adminUrl}${OFF}`);
  }
  if (result.detail && result.status !== 'skipped') {
    console.log(`               ${label.colour}${result.detail}${OFF}`);
  }
  for (const warning of result.warnings ?? []) {
    console.log(`               ${YELLOW}!${OFF} ${DIM}${warning}${OFF}`);
  }
}

function printSummary(report: RunReport): void {
  const counts = countByStatus(report);
  const parts: string[] = [];

  const add = (status: ProductResult['status']) => {
    if (counts[status] > 0) {
      parts.push(`${LABEL[status].colour}${counts[status]} ${LABEL[status].text.toLowerCase()}${OFF}`);
    }
  };
  (['created', 'would-create', 'partial', 'exists', 'failed', 'invalid', 'skipped'] as const).forEach(add);

  console.log(`\n${BOLD}Summary${OFF}  ${parts.join('  ·  ')}`);
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const limit = parseLimit();
  const skus = parseSkus();

  console.log(
    `\n${BOLD}${commit ? 'Creating products' : 'Preview'}${OFF}` +
      `${commit && skus ? ` ${DIM}(${skus.length} selected)${OFF}` : ''}` +
      `${limit ? ` ${DIM}(limited to ${limit})${OFF}` : ''}`,
  );
  if (!commit) console.log(`${DIM}Nothing will be written. Add --commit to create for real.${OFF}`);
  if (!commit && skus) console.log(`${DIM}--sku is ignored by a preview, which checks every row.${OFF}`);

  const report = await run({
    commit,
    limit,
    skus,
    onProgress: (result, done, total) => {
      process.stdout.write(`${DIM}  [${done}/${total}]${OFF} `);
      console.log(
        `${LABEL[result.status].colour}${LABEL[result.status].text}${OFF} ${result.sku}`,
      );
    },
  });

  console.log(
    `\n${DIM}${report.sheet.title} → ${report.sheet.tab} · ${report.sheet.rows} rows · ` +
      `${report.photos.matched} photos across ${report.photos.skus} SKUs${OFF}`,
  );
  const copy = report.descriptions;
  const coverage =
    copy.stonesWanted === 0
      ? ''
      : ` · ${copy.stonesMatched === copy.stonesWanted ? DIM : YELLOW}` +
        `${copy.stonesMatched}/${copy.stonesWanted} stones in this sheet have copy${OFF}`;
  console.log(
    `${DIM}copy inherited from ${copy.host} · ${copy.products} published products · ` +
      `${copy.stones} stones described${OFF}${coverage}\n`,
  );

  console.log(
    `${report.channels.names.length > 0 ? DIM : YELLOW}${report.channels.summary}` +
      `${commit ? ` · ${report.channels.fullyAvailable} reached all of them` : ''}${OFF}\n`,
  );

  if (report.selectedNotInSheet.length > 0) {
    console.log(
      `${YELLOW}Selected but not in the sheet:${OFF} ${report.selectedNotInSheet.join(', ')}\n` +
        `${DIM}Nothing was created for these. Run without --commit to preview the sheet as it is now.${OFF}\n`,
    );
  }

  const interesting = report.results.filter((r) => r.status !== 'skipped');
  for (const result of interesting) printResult(result);

  if (report.rejectedPhotos.length > 0) {
    console.log(`\n${YELLOW}Rejected photo files for SKUs in this sheet${OFF}`);
    for (const rejected of report.rejectedPhotos) {
      console.log(`  ${rejected.name.padEnd(30)} ${DIM}${rejected.reason}${OFF}`);
    }
  }

  printSummary(report);

  if (report.writeBack) {
    const wb = report.writeBack;
    if (wb.error) {
      console.log(
        `${YELLOW}Sheet not updated:${OFF} ${wb.error}\n` +
          `${DIM}The products were still created — Shopify is the source of truth.${OFF}`,
      );
    } else {
      const extras = [
        wb.addedColumns.length > 0 ? `added ${wb.addedColumns.join(', ')}` : '',
        wb.preserved > 0 ? `${wb.preserved} left alone (already recorded in Shopify)` : '',
        wb.notFound.length > 0 ? `${RED}${wb.notFound.length} SKUs no longer in the sheet${OFF}` : '',
      ].filter(Boolean);
      console.log(
        `${DIM}Sheet updated:${OFF} ${wb.updated} rows` +
          (extras.length > 0 ? ` ${DIM}·${OFF} ${extras.join(` ${DIM}·${OFF} `)}` : ''),
      );
    }
  }

  console.log(`${DIM}Report written to ${runsDir()}${OFF}\n`);

  if (hasFailures(report)) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`\n${RED}${error instanceof Error ? error.message : String(error)}${OFF}\n`);
  process.exit(1);
});
