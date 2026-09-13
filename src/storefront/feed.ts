/**
 * Reading published product copy from the live storefront.
 *
 * `/products.json` is the shop's own public feed — no credentials, no scopes,
 * no app. That is the whole reason this reads the storefront rather than the
 * Admin API: the builder has no access to the owner's production store, so an
 * Admin-API version of this could only ever be tested by the owner. This one runs
 * identically from anybody's laptop and is independent of which store `.env`
 * points at, so the dev store sees the same 2,550 descriptions production does.
 *
 * The cost is that only *published* products are visible. Drafts are not, which
 * means copy written on a draft is not inherited until it goes live. That is a
 * real limitation and it is written down in README.md rather than worked around.
 *
 * Nothing here parses HTML or chooses between bodies — that is
 * `src/domain/descriptions.ts`, kept pure so the rules are testable.
 */

import {
  buildCatalogue,
  countDescribedStones,
  type DescriptionCatalogue,
  type FeedProduct,
} from '../domain/descriptions.js';
import { englishStoneNames } from '../domain/stones.js';

/** Shopify's hard cap for this endpoint. */
const PAGE_SIZE = 250;

/**
 * A stop so a misbehaving endpoint cannot loop forever. The live shop is 11
 * pages; 200 is 50,000 products, far beyond anything plausible.
 */
const MAX_PAGES = 200;

/**
 * **The `/en` matters.** The unprefixed URL serves the shop's default market,
 * which is Hungarian, so `ezoko.shop/products.json` returns bodies headed
 * "Szerpentin" and "Rózsakvarc". The tool looks stones up by their English
 * name, so against that feed every single lookup silently misses and every
 * product is created with an empty description.
 *
 * English is also the right side to inherit for a second reason: it is the side
 * the owner writes. The Hungarian bodies are Translate & Adapt output — they still
 * contain "Copper carbonate hydroxide" and "Democratic Republic of the Congo"
 * untranslated mid-sentence. Copying Hungarian machine output into the field he
 * authors in would feed a translation back through the translator.
 */
const DEFAULT_HOST = 'https://ezoko.shop/en';

/**
 * Which storefront to inherit copy from. Configurable because the shop's domain
 * is not the tool's business to hard-code, and because pointing it at a
 * development storefront is how you test a change safely. Include the locale
 * prefix — see DEFAULT_HOST above for what happens if you don't.
 */
export function storefrontUrl(): string {
  const raw = (process.env.EZOKO_STOREFRONT_URL ?? DEFAULT_HOST).trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

interface RawProduct {
  title?: string;
  body_html?: string | null;
}

/**
 * Fetches every page of the feed.
 *
 * Any page failing throws, and the caller abandons the run. A partial
 * catalogue is the dangerous outcome: stones would silently vanish and their
 * rows would be created with an empty body, looking exactly like the rows whose
 * copy genuinely does not exist yet. Better to create nothing and say why.
 */
export async function fetchFeedProducts(host = storefrontUrl()): Promise<FeedProduct[]> {
  const products: FeedProduct[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${host}/products.json?limit=${PAGE_SIZE}&page=${page}`;
    const batch = await fetchPage(url, page, host);
    if (batch.length === 0) return products;

    products.push(...batch);
    if (batch.length < PAGE_SIZE) return products;
  }

  throw new Error(
    `${host}/products.json returned more than ${MAX_PAGES} pages of products, which is not ` +
      `plausible — refusing to keep asking. Check EZOKO_STOREFRONT_URL points at the shop.`,
  );
}

async function fetchPage(url: string, page: number, host: string): Promise<FeedProduct[]> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error: unknown) {
    throw new Error(
      `Could not reach ${host} to read the product descriptions (page ${page}: ` +
        `${error instanceof Error ? error.message : String(error)}). Nothing was created. ` +
        `Check you are online and that the shop is up, then run this again.`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Could not read the product descriptions from ${host} ` +
        `(HTTP ${response.status} on page ${page}). Nothing was created. ` +
        `Check the shop is up, then run this again.`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      `${host}/products.json did not return JSON on page ${page}. Nothing was created. ` +
        `If EZOKO_STOREFRONT_URL was changed, check it points at a Shopify storefront.`,
    );
  }

  const raw = (payload as { products?: unknown })?.products;
  if (!Array.isArray(raw)) {
    throw new Error(
      `${host}/products.json returned no "products" list on page ${page}. Nothing was created. ` +
        `The endpoint may have changed shape — this needs a developer.`,
    );
  }

  return (raw as RawProduct[]).map((product) => ({
    title: String(product.title ?? ''),
    bodyHtml: String(product.body_html ?? ''),
  }));
}

/** The published catalogue, grouped by stone and reduced to one body each. */
export async function fetchDescriptionCatalogue(
  host = storefrontUrl(),
): Promise<{ catalogue: DescriptionCatalogue; products: number; host: string }> {
  const products = await fetchFeedProducts(host);

  if (products.length === 0) {
    throw new Error(
      `${host} published no products, so there is no description to inherit for any stone. ` +
        `Nothing was created. Check EZOKO_STOREFRONT_URL points at the right shop.`,
    );
  }

  const catalogue = buildCatalogue(products);
  assertEnglish(catalogue, host);

  return { catalogue, products: products.length, host };
}

/**
 * Refuses a catalogue that is not in English.
 *
 * Reading the wrong locale is the one failure that does not announce itself:
 * the unprefixed URL returns a healthy-looking 276 stones, every English lookup
 * misses, and 73 products get created with empty descriptions. Counting how
 * many stone names we recognise separates the two cleanly — 47 against 3 on the
 * real shop — so a quarter of the table is a threshold neither case comes near.
 */
function assertEnglish(catalogue: DescriptionCatalogue, host: string): void {
  if (catalogue.size === 0) {
    throw new Error(
      `Read the products from ${host} but found no stone descriptions at all. Nothing was ` +
        `created. Descriptions are taken from the heading at the top of each product's ` +
        `description, so check EZOKO_STOREFRONT_URL points at the shop itself.`,
    );
  }

  const names = englishStoneNames();
  const known = countDescribedStones(catalogue, names);

  if (known * 4 < names.length) {
    throw new Error(
      `${host} describes ${catalogue.size} stones, but only ${known} of the ${names.length} ` +
        `stone names this tool knows — which means the descriptions are not in English. ` +
        `Nothing was created. The address needs the language in it: use ` +
        `${host.replace(/\/[a-z]{2}$/i, '')}/en rather than ${host}.`,
    );
  }
}
