/**
 * Attributing photo files to SKUs.
 *
 * The convention is `SKU_NN.ext`, for example `CA-738-A1_01.jpg`. We split on
 * the LAST underscore, which gives us an exact SKU match rather than a prefix
 * match — that is what stops `CA-738-A1` from stealing `CA-738-A11`'s photos.
 * It also means a SKU containing underscores still works.
 *
 * The policy throughout is: normalise what has exactly one possible meaning,
 * refuse what has two. Case and stray whitespace are silently fixed. Anything
 * genuinely ambiguous is rejected with a reason a human can act on, because a
 * best-effort guess here puts the wrong photo on the wrong stone, and nobody
 * notices until a customer does.
 */

import type { DriveFile, MatchedPhoto, PhotoIndex, RejectedPhoto } from './types.js';

/** Extensions Shopify reliably accepts for product images. */
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

/** Extensions we recognise but cannot use, so we can say something useful. */
const KNOWN_UNUSABLE: Record<string, string> = {
  heic: 'HEIC is not supported by Shopify — export it as JPEG',
  heif: 'HEIF is not supported by Shopify — export it as JPEG',
  tif: 'TIFF is not supported by Shopify — export it as JPEG',
  tiff: 'TIFF is not supported by Shopify — export it as JPEG',
  raw: 'RAW files cannot be uploaded — export it as JPEG',
  cr2: 'RAW files cannot be uploaded — export it as JPEG',
  nef: 'RAW files cannot be uploaded — export it as JPEG',
  dng: 'RAW files cannot be uploaded — export it as JPEG',
  psd: 'Photoshop files cannot be uploaded — export it as JPEG',
  pdf: 'not an image',
  mp4: 'video is out of scope for now',
  mov: 'video is out of scope for now',
};

/**
 * The single normalisation used on BOTH sides of the join — filenames and
 * spreadsheet cells. If these two ever diverge, photos silently stop matching,
 * so there is exactly one function and everybody calls it.
 */
export function normaliseSku(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * The SKU a filename *claims*, even when it is too malformed to use.
 *
 * Needed to decide whether a rejected file is worth reporting. A rejection only
 * matters if it costs a row in the sheet a photo: the folder holds photos for
 * thousands of other pieces, and `SMF-026_.jpg` being badly named is not this
 * run's problem unless SMF-026 is a row somebody is trying to create.
 *
 * Deliberately more forgiving than `parsePhotoName` — that one must be exact
 * because it decides which photo goes on which stone. This one only decides
 * whether to print a line, so guessing wide is the safe direction: the cost of
 * a false positive is one extra line of output.
 */
export function claimedSku(filename: string): string {
  const name = filename.trim();
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;

  const underscore = stem.lastIndexOf('_');
  const claimed = underscore > 0 ? stem.slice(0, underscore) : stem;
  return normaliseSku(claimed);
}

interface ParsedName {
  sku: string;
  index: number;
}

export type NameParse =
  | { ok: true; parsed: ParsedName }
  | { ok: false; reason: string };

/** Splits `CA-738-A1_01.jpg` into SKU `CA-738-A1` and index `1`. */
export function parsePhotoName(filename: string): NameParse {
  const name = filename.trim();

  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return { ok: false, reason: 'no file extension' };
  }

  const extension = name.slice(dot + 1).trim().toLowerCase();
  const stem = name.slice(0, dot).trim();

  if (!ALLOWED_EXTENSIONS.has(extension)) {
    const known = KNOWN_UNUSABLE[extension];
    return { ok: false, reason: known ?? `unsupported file type ".${extension}"` };
  }

  const underscore = stem.lastIndexOf('_');
  if (underscore < 0) {
    return {
      ok: false,
      reason: 'missing the _NN number at the end — expected something like CA-738-A1_01.jpg',
    };
  }

  const skuPart = stem.slice(0, underscore).trim();
  const indexPart = stem.slice(underscore + 1).trim();

  if (skuPart === '') {
    return { ok: false, reason: 'no SKU before the underscore' };
  }
  if (!/^\d+$/.test(indexPart)) {
    return {
      ok: false,
      reason: `"${indexPart}" after the underscore is not a plain number — expected something like _01`,
    };
  }

  return { ok: true, parsed: { sku: normaliseSku(skuPart), index: Number(indexPart) } };
}

/**
 * Scans a whole folder listing once and returns photos grouped by SKU.
 *
 * Two files claiming the same SKU and the same index are BOTH rejected: we
 * cannot tell which one is the real `_01`, and picking arbitrarily is exactly
 * the silent-wrong-photo failure this whole module exists to prevent.
 */
export function indexPhotos(files: DriveFile[]): PhotoIndex {
  const rejected: RejectedPhoto[] = [];
  const candidates: MatchedPhoto[] = [];

  for (const file of files) {
    // Folders and Google-native files are not photos and are not worth
    // reporting as problems — they are just noise in the folder.
    if (file.mimeType.startsWith('application/vnd.google-apps')) continue;
    if (file.name.startsWith('.')) continue;

    const parse = parsePhotoName(file.name);
    if (!parse.ok) {
      rejected.push({ file, reason: parse.reason });
      continue;
    }
    candidates.push({ file, sku: parse.parsed.sku, index: parse.parsed.index });
  }

  // Detect duplicate (sku, index) pairs before grouping.
  const seen = new Map<string, MatchedPhoto[]>();
  for (const photo of candidates) {
    const key = `${photo.sku}#${photo.index}`;
    const bucket = seen.get(key);
    if (bucket) bucket.push(photo);
    else seen.set(key, [photo]);
  }

  const bySku = new Map<string, MatchedPhoto[]>();
  for (const [, group] of seen) {
    if (group.length > 1) {
      const names = group.map((p) => p.file.name).join(', ');
      for (const photo of group) {
        rejected.push({
          file: photo.file,
          reason: `duplicate number for this SKU — ${names} all claim the same position`,
        });
      }
      continue;
    }
    const photo = group[0]!;
    const bucket = bySku.get(photo.sku);
    if (bucket) bucket.push(photo);
    else bySku.set(photo.sku, [photo]);
  }

  // Numeric sort, so _1 / _2 / _10 order correctly where text sorting would
  // give _1 / _10 / _2 and make the wrong photo the featured image.
  for (const photos of bySku.values()) {
    photos.sort((a, b) => a.index - b.index);
  }

  return { bySku, rejected };
}
