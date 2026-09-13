/**
 * Core types shared across the pipeline.
 *
 * Everything in `src/domain` is pure: no network, no filesystem, no clock.
 * That is deliberate — these are the parts we can test exhaustively without
 * credentials, and they are where the expensive mistakes live (wrong photo on
 * wrong stone, misread price, a 37 mm sphere listed as 37 cm).
 */

import type { Measure } from './measure.js';

/** One row of the owner's spreadsheet, as raw text exactly as typed. */
export interface SheetRow {
  /** 1-based row number in the sheet. For human-readable messages only —
   *  never used to write results back. Results are located by SKU. */
  rowNumber: number;
  sku: string;
  stoneName: string;
  productType: string;
  price: string;
  weight: string;
  height: string;
  width: string;
  depth: string;
  photoStatus: string;
}

/** A file as Google Drive reports it. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  /** Subfolder it was found in, for reporting. Empty for the root. */
  folder: string;
}

/** A Drive file successfully attributed to a SKU. */
export interface MatchedPhoto {
  file: DriveFile;
  /** Normalised SKU (uppercase, trimmed). */
  sku: string;
  /** The numeric suffix, e.g. 1 for `SP-190-B_01.jpg`. Sorted on. */
  index: number;
}

/** A Drive file we refused to use, and why. */
export interface RejectedPhoto {
  file: DriveFile;
  reason: string;
}

/** The result of scanning the whole photo folder once. */
export interface PhotoIndex {
  /** Normalised SKU -> photos, already sorted by index ascending. */
  bySku: Map<string, MatchedPhoto[]>;
  rejected: RejectedPhoto[];
}

/** A validated, fully-resolved product ready to send to Shopify. */
export interface ProductDraft {
  /** Normalised SKU — the join key. */
  sku: string;
  /** SKU exactly as the owner typed it. */
  displaySku: string;
  title: string;
  descriptionHtml: string;
  /**
   * The storefront heading the description was copied from, or null when the
   * stone has no published copy. Reported as a coverage count, so pointing the
   * tool at the wrong locale shows up as "0 of 25 stones" rather than as a
   * warning scattered over every row.
   */
  descriptionFrom: string | null;
  productType: string;
  tags: string[];
  /** Whole forints. */
  priceHuf: number;
  weight: Measure | null;
  height: Measure | null;
  width: Measure | null;
  depth: Measure | null;
  photos: MatchedPhoto[];
  /** Non-fatal things worth telling a human about, e.g. an untranslated stone. */
  warnings: string[];
}

/** Why a row could not become a product. */
export interface RowProblem {
  field: string;
  message: string;
}

export type RowOutcome =
  | { kind: 'ready'; rowNumber: number; draft: ProductDraft }
  | { kind: 'invalid'; rowNumber: number; sku: string; problems: RowProblem[] }
  | { kind: 'skipped'; rowNumber: number; sku: string; reason: string };
