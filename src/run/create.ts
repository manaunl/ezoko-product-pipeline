/**
 * Creating one product, as a single step that always returns a result rather
 * than throwing.
 *
 * A failure here is data for the report, not an exception that aborts the run:
 * one bad row must not stop the other seventy-six.
 */

import type { OAuth2Client } from 'google-auth-library';
import { downloadFile } from '../google/download.js';
import { describeChannelMiss, type Channel } from '../domain/channels.js';
import { storeDomain } from '../shopify/client.js';
import { createStagedTargets, uploadToTarget, waitForMedia } from '../shopify/media.js';
import {
  createProduct,
  findVariantBySku,
  publishToChannels,
  setInventory,
} from '../shopify/products.js';
import type { ProductDraft } from '../domain/types.js';
import type { ProductResult } from './report.js';

export function adminUrl(productId: string): string {
  return `https://${storeDomain()}/admin/products/${productId.split('/').pop()}`;
}

export async function createOne(
  auth: OAuth2Client,
  draft: ProductDraft,
  rowNumber: number,
  locationId: string,
  channels: Channel[],
): Promise<ProductResult> {
  const base = { rowNumber, sku: draft.displaySku, title: draft.title };

  try {
    // Shopify, not the sheet, decides what already exists. This is what makes
    // any run safely repeatable.
    const existing = await findVariantBySku(draft.displaySku);
    if (existing) {
      return {
        ...base,
        status: 'exists',
        title: existing.product.title,
        productId: existing.product.id,
        adminUrl: adminUrl(existing.product.id),
        detail: `already in Shopify as a ${existing.product.status.toLowerCase()} product`,
      };
    }

    const files = await Promise.all(
      draft.photos.map(async (photo) => ({
        name: photo.file.name,
        mimeType: photo.file.mimeType,
        bytes: await downloadFile(auth, photo.file.id),
      })),
    );

    const targets = await createStagedTargets(
      files.map((file) => ({
        filename: file.name,
        mimeType: file.mimeType,
        fileSize: file.bytes.byteLength,
      })),
    );

    for (const [i, file] of files.entries()) {
      const target = targets[i];
      if (!target) throw new Error(`Shopify returned no upload target for ${file.name}`);
      await uploadToTarget(target, file.name, file.mimeType, file.bytes);
    }

    const product = await createProduct(
      draft,
      targets.map((target, i) => ({
        originalSource: target.resourceUrl,
        alt: `${draft.title} — photo ${i + 1}`,
      })),
    );

    await setInventory(product.inventoryItemId, locationId, 1);

    // Attaching media is asynchronous: the mutation succeeds and Shopify can
    // still fail to process the image afterwards. Without this wait a product
    // reports "created fine" and shows no pictures.
    const media = await waitForMedia(product.id, files.length);
    const ready = media.filter((m) => m.status === 'READY').length;
    const failed = media.filter((m) => m.status === 'FAILED');

    // Set last, after photos, price, weight and stock are all in place, so a
    // channel is never offered a half-built product. A failure here — a
    // partial `userErrors` list, or the call throwing outright — never turns
    // this into anything but `created`/`partial`: the product already exists,
    // and reporting otherwise would put a lie in the sheet. See ADR-0009.
    let missedChannelNames: string[] = [];
    if (channels.length > 0) {
      try {
        const outcome = await publishToChannels(product.id, channels);
        missedChannelNames = outcome.missed.map((m) => m.channel.name);
      } catch {
        missedChannelNames = channels.map((channel) => channel.name);
      }
    }
    const channelWarning = describeChannelMiss(missedChannelNames);

    return {
      ...base,
      status: failed.length > 0 || ready < files.length ? 'partial' : 'created',
      productId: product.id,
      adminUrl: adminUrl(product.id),
      photos: { total: files.length, ready, failed: failed.length },
      warnings: channelWarning ? [...draft.warnings, channelWarning] : draft.warnings,
      detail:
        failed.length > 0
          ? failed.map((f) => f.errors.join('; ') || 'image processing failed').join(' | ')
          : undefined,
    };
  } catch (error: unknown) {
    return {
      ...base,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
