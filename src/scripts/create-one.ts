/**
 * Create one product, end to end, and report what happened.
 *
 * Deliberately one SKU at a time: the first real creations should be checked by
 * hand in the admin before anything runs in bulk.
 *
 *   npx tsx src/scripts/create-one.ts SP-190-B
 */

import '../bootstrap.js';

import { loadDescriptionAliases, toPlainText } from '../domain/descriptions.js';
import { indexPhotos, normaliseSku } from '../domain/filenames.js';
import { findDuplicateSkus, rowToOutcome } from '../domain/mapping.js';
import { formatHuf } from '../domain/numbers.js';
import { buildSpecParts } from '../domain/spec.js';
import { fetchDescriptionCatalogue } from '../storefront/feed.js';
import { downloadFile } from '../google/download.js';
import { listPhotoFiles } from '../google/drive.js';
import { readSheet } from '../google/sheets.js';
import { loadAuth } from '../google/auth.js';
import { storeDomain } from '../shopify/client.js';
import { createStagedTargets, uploadToTarget, waitForMedia } from '../shopify/media.js';
import { createProduct, findVariantBySku, primaryLocationId, setInventory } from '../shopify/products.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const OFF = '\x1b[0m';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

const step = (n: number, text: string) => console.log(`  ${DIM}${n}/6${OFF} ${text}`);

async function main(): Promise<void> {
  const wanted = normaliseSku(process.argv[2] ?? '');
  if (wanted === '') {
    throw new Error('Which SKU? Usage: npx tsx src/scripts/create-one.ts SP-190-B');
  }

  const auth = await loadAuth();
  const sheet = await readSheet(auth, required('GOOGLE_SHEET_ID'), process.env.GOOGLE_SHEET_TAB ?? '');
  const photos = indexPhotos(await listPhotoFiles(auth, required('GOOGLE_DRIVE_FOLDER_ID')));

  const row = sheet.rows.find((r) => normaliseSku(r.sku) === wanted);
  if (!row) throw new Error(`no row in the sheet has SKU ${wanted}`);

  const descriptions = await fetchDescriptionCatalogue();
  const outcome = rowToOutcome(row, photos, {
    duplicateSkus: findDuplicateSkus(sheet.rows),
    descriptions: descriptions.catalogue,
    descriptionAliases: loadDescriptionAliases(),
  });
  if (outcome.kind === 'skipped') {
    console.log(`\n${YELLOW}${wanted} is not ready:${OFF} ${outcome.reason}\n`);
    return;
  }
  if (outcome.kind === 'invalid') {
    console.log(`\n${RED}${wanted} needs fixing:${OFF}`);
    for (const problem of outcome.problems) console.log(`  · ${problem.message}`);
    console.log('');
    return;
  }

  const { draft } = outcome;
  console.log(`\n${BOLD}${draft.title}${OFF}`);
  console.log(`${DIM}${draft.displaySku} · ${formatHuf(draft.priceHuf)} · ${buildSpecParts(draft).join(' · ')}${OFF}`);
  const body = toPlainText(draft.descriptionHtml).replace(/\n+/g, ' ');
  console.log(
    body === ''
      ? `${YELLOW}no published copy for this stone — the description will be empty${OFF}\n`
      : `${DIM}${body.slice(0, 100)}…${OFF}\n`,
  );
  for (const warning of draft.warnings) console.log(`  ${YELLOW}!${OFF} ${DIM}${warning}${OFF}`);

  step(1, 'checking whether this SKU already exists in Shopify');
  const existing = await findVariantBySku(draft.displaySku);
  if (existing) {
    console.log(
      `\n${YELLOW}Already exists${OFF} — "${existing.product.title}" (${existing.product.status.toLowerCase()}).\n` +
        `${DIM}Nothing was created. Shopify is the source of truth, so re-running is always safe.${OFF}\n`,
    );
    return;
  }

  step(2, `downloading ${draft.photos.length} photos from Drive`);
  const files = await Promise.all(
    draft.photos.map(async (photo) => ({
      name: photo.file.name,
      mimeType: photo.file.mimeType,
      bytes: await downloadFile(auth, photo.file.id),
    })),
  );

  step(3, 'asking Shopify for upload targets');
  const targets = await createStagedTargets(
    files.map((file) => ({
      filename: file.name,
      mimeType: file.mimeType,
      fileSize: file.bytes.byteLength,
    })),
  );

  step(4, 'uploading the photos');
  for (const [i, file] of files.entries()) {
    const target = targets[i];
    if (!target) throw new Error(`Shopify returned no upload target for ${file.name}`);
    await uploadToTarget(target, file.name, file.mimeType, file.bytes);
  }

  step(5, 'creating the product as a draft');
  const product = await createProduct(
    draft,
    targets.map((target, i) => ({
      originalSource: target.resourceUrl,
      alt: `${draft.title} — photo ${i + 1}`,
    })),
  );
  await setInventory(product.inventoryItemId, await primaryLocationId(), 1);

  step(6, 'waiting for Shopify to finish processing the images');
  const media = await waitForMedia(product.id, files.length);
  const ready = media.filter((m) => m.status === 'READY');
  const failed = media.filter((m) => m.status === 'FAILED');

  const numericId = product.id.split('/').pop();
  console.log(`\n${GREEN}Created${OFF} as a draft`);
  console.log(`  ${ready.length}/${files.length} photos ready${failed.length ? `, ${failed.length} failed` : ''}`);
  for (const failure of failed) console.log(`  ${RED}·${OFF} ${failure.errors.join('; ') || 'image processing failed'}`);
  console.log(`\n  https://${storeDomain()}/admin/products/${numericId}\n`);
}

main().catch((error: unknown) => {
  console.error(`\n${RED}${error instanceof Error ? error.message : String(error)}${OFF}\n`);
  process.exit(1);
});
