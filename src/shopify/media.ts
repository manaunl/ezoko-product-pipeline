/**
 * Getting photos into Shopify.
 *
 * Three moves per batch:
 *   1. ask Shopify for signed upload targets (one call for all the photos)
 *   2. POST each file's bytes to its target
 *   3. hand the resulting resource URLs to productCreate as media
 *
 * Then the part that is easy to miss: attaching media is asynchronous. The
 * mutation returns success and Shopify processes the image afterwards, where it
 * can still fail — wrong format, corrupt file, too large. A product can report
 * "created fine" and show no images at all. So we poll every media item until
 * it is genuinely READY or FAILED before calling the product done.
 */

import { shopifyGraphql } from './client.js';

export interface StagedTarget {
  url: string;
  resourceUrl: string;
  parameters: { name: string; value: string }[];
}

const STAGED_UPLOADS_CREATE = `
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

export interface UploadRequest {
  filename: string;
  mimeType: string;
  fileSize: number;
}

export async function createStagedTargets(files: UploadRequest[]): Promise<StagedTarget[]> {
  const { data } = await shopifyGraphql<{
    stagedUploadsCreate: {
      stagedTargets: StagedTarget[];
      userErrors: { field: string[]; message: string }[];
    };
  }>(STAGED_UPLOADS_CREATE, {
    input: files.map((file) => ({
      filename: file.filename,
      mimeType: file.mimeType,
      resource: 'IMAGE',
      httpMethod: 'POST',
      fileSize: String(file.fileSize),
    })),
  });

  const errors = data.stagedUploadsCreate.userErrors;
  if (errors.length > 0) {
    throw new Error(`staged upload refused: ${errors.map((e) => e.message).join('; ')}`);
  }

  return data.stagedUploadsCreate.stagedTargets;
}

/** POSTs the bytes to the signed target. The parameters must come before the file. */
export async function uploadToTarget(
  target: StagedTarget,
  filename: string,
  mimeType: string,
  bytes: Buffer,
): Promise<void> {
  const form = new FormData();
  for (const parameter of target.parameters) {
    form.append(parameter.name, parameter.value);
  }
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);

  const response = await fetch(target.url, { method: 'POST', body: form });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`uploading ${filename} failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
}

const PRODUCT_MEDIA = `
  query productMedia($id: ID!) {
    product(id: $id) {
      media(first: 50) {
        nodes {
          ... on MediaImage {
            id
            status
            image { url }
            mediaErrors { code details message }
          }
        }
      }
    }
  }
`;

export interface MediaState {
  id: string;
  status: string;
  errors: string[];
}

export async function readMediaStatus(productId: string): Promise<MediaState[]> {
  const { data } = await shopifyGraphql<{
    product: {
      media: {
        nodes: {
          id?: string;
          status?: string;
          mediaErrors?: { message: string; details?: string }[];
        }[];
      };
    } | null;
  }>(PRODUCT_MEDIA, { id: productId });

  return (data.product?.media.nodes ?? [])
    .filter((node) => node.id)
    .map((node) => ({
      id: node.id!,
      status: node.status ?? 'UNKNOWN',
      errors: (node.mediaErrors ?? []).map((e) => e.details ?? e.message),
    }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for Shopify to finish processing every image on the product.
 *
 * Returns the final states rather than throwing, because a product with two of
 * three photos is a partial success worth reporting, not a failure worth
 * discarding.
 */
export async function waitForMedia(
  productId: string,
  expected: number,
  timeoutMs = 90_000,
): Promise<MediaState[]> {
  const deadline = Date.now() + timeoutMs;
  let states: MediaState[] = [];

  while (Date.now() < deadline) {
    states = await readMediaStatus(productId);

    const settled =
      states.length >= expected && states.every((s) => s.status === 'READY' || s.status === 'FAILED');
    if (settled) return states;

    await sleep(1500);
  }

  return states;
}
