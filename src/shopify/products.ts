/**
 * Creating a product.
 *
 * The sequence, and why it is more than one call:
 *
 *   1. look the SKU up — Shopify, not the sheet, decides what already exists
 *   2. productCreate, with the already-uploaded media attached
 *   3. update the auto-created default variant (SKU, price, weight, tracking) —
 *      variants cannot be set inline on create in current API versions
 *   4. set inventory to 1 at the location
 *
 * Nothing here deletes. There is no delete mutation anywhere in this codebase,
 * which is what makes it safe to point at a live store you cannot test against:
 * the worst case is a draft product that needs tidying, never a lost one.
 */

import { createHash } from 'node:crypto';
import { shopifyGraphql } from './client.js';
import { classifyChannelsError, type Channel, type ChannelsProbe } from '../domain/channels.js';
import type { Measure } from '../domain/measure.js';
import { toGrams } from '../domain/measure.js';
import type { ProductDraft } from '../domain/types.js';

const VARIANT_BY_SKU = `
  query variantBySku($query: String!) {
    productVariants(first: 5, query: $query) {
      nodes {
        id
        sku
        product { id title handle status }
      }
    }
  }
`;

export interface ExistingVariant {
  id: string;
  sku: string;
  product: { id: string; title: string; handle: string; status: string };
}

/** The idempotency guard. Exists → we skip, and a re-run is always safe. */
export async function findVariantBySku(sku: string): Promise<ExistingVariant | null> {
  const { data } = await shopifyGraphql<{ productVariants: { nodes: ExistingVariant[] } }>(
    VARIANT_BY_SKU,
    { query: `sku:'${sku.replace(/'/g, "\\'")}'` },
  );

  // The query is a search, not an exact match, so confirm the SKU really is the
  // one we asked for before treating it as already created.
  return data.productVariants.nodes.find((node) => node.sku === sku) ?? null;
}

const PRODUCT_CREATE = `
  mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product {
        id
        title
        handle
        status
        variants(first: 1) {
          nodes { id inventoryItem { id } }
        }
      }
      userErrors { field message }
    }
  }
`;

const VARIANTS_UPDATE = `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku price }
      userErrors { field message }
    }
  }
`;

/**
 * Since API 2026-04 inventory mutations must carry an idempotency key. We
 * derive it from what is being set rather than using a random UUID, so that a
 * retry after an ambiguous failure — a timeout on a call that actually
 * succeeded — returns the original result instead of colliding with the
 * quantity it already wrote.
 */
const INVENTORY_SET = `
  mutation inventorySetQuantities($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) {
      inventoryAdjustmentGroup { createdAt }
      userErrors { field message }
    }
  }
`;

function idempotencyKey(...parts: (string | number)[]): string {
  const hash = createHash('sha256').update(parts.join('|')).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

export interface CreatedProduct {
  id: string;
  title: string;
  handle: string;
  variantId: string;
  inventoryItemId: string;
}

function fail(step: string, errors: { field?: string[] | null; message: string }[]): never {
  throw new Error(
    `${step} failed: ${errors.map((e) => `${e.field?.join('.') ?? ''} ${e.message}`.trim()).join('; ')}`,
  );
}

function weightInput(weight: Measure | null): Record<string, unknown> | undefined {
  if (!weight) return undefined;
  const grams = toGrams(weight);
  if (grams === null) return undefined;
  // Weight lives under `measurement`, not directly on the inventory item.
  return { measurement: { weight: { value: grams, unit: 'GRAMS' } } };
}

/**
 * `mediaSources` are resource URLs from an already-completed staged upload,
 * in the order the photos should appear. The first becomes the featured image.
 */
export async function createProduct(
  draft: ProductDraft,
  mediaSources: { originalSource: string; alt: string }[],
): Promise<CreatedProduct> {
  const { data: created } = await shopifyGraphql<{
    productCreate: {
      product: {
        id: string;
        title: string;
        handle: string;
        variants: { nodes: { id: string; inventoryItem: { id: string } }[] };
      } | null;
      userErrors: { field: string[]; message: string }[];
    };
  }>(PRODUCT_CREATE, {
    product: {
      title: draft.title,
      descriptionHtml: draft.descriptionHtml,
      productType: draft.productType,
      tags: draft.tags,
      templateSuffix: draft.template,
      // Draft, always. Nothing this tool creates is ever visible to a customer
      // until a human publishes it in the admin.
      status: 'DRAFT',
    },
    media: mediaSources.map((source) => ({
      originalSource: source.originalSource,
      alt: source.alt,
      mediaContentType: 'IMAGE',
    })),
  });

  if (created.productCreate.userErrors.length > 0) {
    fail('productCreate', created.productCreate.userErrors);
  }
  const product = created.productCreate.product;
  if (!product) throw new Error('productCreate returned no product');

  const variant = product.variants.nodes[0];
  if (!variant) throw new Error('productCreate returned no default variant');

  const { data: updated } = await shopifyGraphql<{
    productVariantsBulkUpdate: {
      userErrors: { field: string[]; message: string }[];
    };
  }>(VARIANTS_UPDATE, {
    productId: product.id,
    variants: [
      {
        id: variant.id,
        price: String(draft.priceHuf),
        inventoryItem: {
          sku: draft.displaySku,
          tracked: true,
          ...weightInput(draft.weight),
        },
      },
    ],
  });

  if (updated.productVariantsBulkUpdate.userErrors.length > 0) {
    fail('productVariantsBulkUpdate', updated.productVariantsBulkUpdate.userErrors);
  }

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    variantId: variant.id,
    inventoryItemId: variant.inventoryItem.id,
  };
}

const INVENTORY_LEVEL = `
  query inventoryLevel($itemId: ID!, $locationId: ID!) {
    inventoryItem(id: $itemId) {
      inventoryLevel(locationId: $locationId) {
        quantities(names: ["available"]) { name quantity }
      }
    }
  }
`;

/** Available quantity at the location right now, or 0 if not stocked there. */
async function currentQuantity(inventoryItemId: string, locationId: string): Promise<number> {
  const { data } = await shopifyGraphql<{
    inventoryItem: {
      inventoryLevel: { quantities: { name: string; quantity: number }[] } | null;
    } | null;
  }>(INVENTORY_LEVEL, { itemId: inventoryItemId, locationId });

  const available = data.inventoryItem?.inventoryLevel?.quantities.find(
    (q) => q.name === 'available',
  );
  return available?.quantity ?? 0;
}

/**
 * Each stone is a unique physical piece, so the quantity is always 1.
 *
 * The mutation requires `changeFromQuantity` — the value we believe is there
 * now — and rejects the call if it is wrong. Assuming 0 works for a fresh
 * product but breaks on any re-run over a product that was created but whose
 * inventory step failed, which is precisely the partial-failure case we expect.
 * So we read the current value first, and do nothing at all when it already
 * matches.
 */
export async function setInventory(
  inventoryItemId: string,
  locationId: string,
  quantity = 1,
): Promise<void> {
  const current = await currentQuantity(inventoryItemId, locationId);
  if (current === quantity) return;
  const { data } = await shopifyGraphql<{
    inventorySetQuantities: { userErrors: { field: string[]; message: string }[] };
  }>(INVENTORY_SET, {
    input: {
      name: 'available',
      reason: 'correction',
      // `changeFromQuantity` is the optimistic-lock check: the quantity we
      // believe is there now. The schema marks it optional but the API rejects
      // the call without it. This only ever runs on a product we just created,
      // so the current quantity is always 0.
      quantities: [{ inventoryItemId, locationId, quantity, changeFromQuantity: current }],
    },
    key: idempotencyKey('inventory', inventoryItemId, locationId, quantity, current),
  });

  if (data.inventorySetQuantities.userErrors.length > 0) {
    fail('inventorySetQuantities', data.inventorySetQuantities.userErrors);
  }
}

const PRIMARY_LOCATION = `
  query primaryLocation {
    locations(first: 1, query: "active:true") { nodes { id name } }
  }
`;

export async function primaryLocationId(): Promise<string> {
  const explicit = process.env.SHOPIFY_LOCATION_ID;
  if (explicit) return explicit;

  const { data } = await shopifyGraphql<{ locations: { nodes: { id: string }[] } }>(
    PRIMARY_LOCATION,
  );
  const location = data.locations.nodes[0];
  if (!location) throw new Error('the store has no active location to hold inventory');
  return location.id;
}

const PUBLICATIONS = `
  query publications($first: Int!) {
    publications(first: $first) {
      nodes {
        id
        channels(first: 5) { nodes { name } }
      }
    }
  }
`;

/**
 * The store's sales channels, discovered fresh every run — never configured,
 * so a seventh channel added next year needs no code change.
 *
 * Requires the `read_publications` scope. Verified against the live dev
 * store: without it, this throws with a message naming that scope exactly,
 * which is what `classifyChannelsError` in `domain/channels.ts` recognises.
 *
 * A Publication's own display name lives on the Channel(s) it wraps, not on
 * the Publication itself — for the ordinary sales-channel case that is one
 * channel per publication, so its name is used directly.
 */
export async function listPublications(): Promise<Channel[]> {
  const { data } = await shopifyGraphql<{
    publications: { nodes: { id: string; channels: { nodes: { name: string }[] } }[] };
  }>(PUBLICATIONS, { first: 50 });

  return data.publications.nodes.map((node) => ({
    id: node.id,
    name: node.channels.nodes.map((channel) => channel.name).join(', ') || node.id,
  }));
}

/**
 * `listPublications`, with the failure already classified — shared by the
 * run's preflight gate and the setup page's connection test, so telling a
 * missing scope apart from anything else Shopify could say only happens once.
 */
export async function probeChannels(): Promise<ChannelsProbe> {
  try {
    return { kind: 'ok', channels: await listPublications() };
  } catch (error: unknown) {
    return classifyChannelsError(error);
  }
}

const PUBLISHABLE_PUBLISH = `
  mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      userErrors { field message }
    }
  }
`;

/** Channels a `publishablePublish` call could not reach, and why. */
export interface ChannelPublishOutcome {
  missed: { channel: Channel; message: string }[];
}

/**
 * Makes a product available to every given channel, in one call. Requires the
 * `write_publications` scope.
 *
 * `userErrors` names a failing entry by its index in `input` (`field: ["input",
 * "2"]`), which is how a partial failure is turned back into the channels it
 * actually names rather than a bare list of messages.
 */
export async function publishToChannels(
  productId: string,
  channels: Channel[],
): Promise<ChannelPublishOutcome> {
  if (channels.length === 0) return { missed: [] };

  const { data } = await shopifyGraphql<{
    publishablePublish: { userErrors: { field?: string[] | null; message: string }[] };
  }>(PUBLISHABLE_PUBLISH, {
    id: productId,
    input: channels.map((channel) => ({ publicationId: channel.id })),
  });

  const missed = data.publishablePublish.userErrors.map((error) => {
    const channel = channels[Number(error.field?.[1])];
    // Not verified against real data — no store has returned a partial
    // failure here yet. If Shopify's index ever doesn't line up with `input`,
    // this throws, and the caller in `run/create.ts` already treats any
    // failure here as every channel missed rather than trusting a guess.
    if (!channel) throw new Error(`publishablePublish named a channel we didn't ask for: ${error.message}`);
    return { channel, message: error.message };
  });
  return { missed };
}
