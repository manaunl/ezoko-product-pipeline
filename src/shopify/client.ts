/**
 * Shopify Admin API client.
 *
 * One endpoint, GraphQL only. REST is legacy for product management and we are
 * not building on a sunset path.
 *
 * The API version is pinned here and nowhere else. Shopify ships a new version
 * quarterly and retires each one after about a year, so this constant is a
 * maintenance obligation: unpinned or forgotten, this tool works beautifully
 * for a year and then breaks on an ordinary Tuesday.
 */


export const API_VERSION = '2026-07';

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ShopifyError';
  }
}

export function storeDomain(): string {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  if (!domain) throw new ShopifyError('SHOPIFY_STORE_DOMAIN is not set in .env');
  return domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/**
 * Access tokens.
 *
 * Two worlds, because Shopify changed the rules in January 2026:
 *
 *   - Apps created in the admin before then have a permanent `shpat_` token.
 *     The owner's live store may well have one; if SHOPIFY_ACCESS_TOKEN is set we
 *     just use it.
 *   - New apps come from the Dev Dashboard and issue no static token at all.
 *     We exchange the client ID and secret for one that lasts 24 hours, via the
 *     client credentials grant, and refresh it when it is close to expiring.
 *
 * The token is held in memory only — it is a short-lived secret and there is no
 * reason to write it to disk beside the long-lived one.
 */
let cached: { token: string; expiresAt: number } | null = null;

/** Called after the setup page changes the credentials, so the old token goes. */
export function resetTokenCache(): void {
  cached = null;
}

/** Refresh a minute early rather than racing the expiry. */
const EXPIRY_MARGIN_MS = 60_000;

async function requestToken(): Promise<{ token: string; expiresAt: number }> {
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new ShopifyError(
      'Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env.\n' +
        'Both are in the Shopify Dev Dashboard (dev.shopify.com/dashboard) under your app.\n' +
        'The secret starts with "shpss_"; the client ID is the long hex string beside it.',
    );
  }

  const response = await fetch(`https://${storeDomain()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ShopifyError(
      `Could not get an access token from Shopify (HTTP ${response.status}).\n` +
        `Shopify said: ${text.slice(0, 300)}\n` +
        'Check the client ID and secret, and that the app and the store are in the same ' +
        'Shopify organization — the client credentials grant only works within one org.',
    );
  }

  const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!body.access_token) {
    throw new ShopifyError('Shopify returned no access token', text.slice(0, 300));
  }

  return {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 86_399) * 1000,
  };
}

export async function accessToken(): Promise<string> {
  const legacy = process.env.SHOPIFY_ACCESS_TOKEN;
  if (legacy && legacy.startsWith('shpat_')) return legacy;

  if (legacy && legacy.startsWith('shpss_')) {
    throw new ShopifyError(
      'SHOPIFY_ACCESS_TOKEN holds a client secret (shpss_...), which is not an access token.\n' +
        'Move that value to SHOPIFY_CLIENT_SECRET, add SHOPIFY_CLIENT_ID beside it, and remove ' +
        'SHOPIFY_ACCESS_TOKEN.',
    );
  }

  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached.token;

  cached = await requestToken();
  return cached.token;
}

export interface GraphqlResult<T> {
  data: T;
  throttle: ThrottleStatus | null;
}

export async function shopifyGraphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GraphqlResult<T>> {
  const domain = storeDomain();
  const token = await accessToken();
  const url = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await response.text();

  if (response.status === 401 || response.status === 403) {
    throw new ShopifyError(
      `Shopify rejected the request (HTTP ${response.status}) for ${domain}.\n` +
        `Shopify said: ${text.slice(0, 300) || '(empty response)'}\n` +
        'Check SHOPIFY_ACCESS_TOKEN in .env, that the custom app is installed, and that its ' +
        'access scopes — read_products, write_products, read_inventory, write_inventory, ' +
        'read_locations, read_publications, write_publications — are set and the app version ' +
        'is released.',
    );
  }
  if (response.status === 404) {
    throw new ShopifyError(
      `No store at ${domain}. SHOPIFY_STORE_DOMAIN should look like your-store.myshopify.com`,
    );
  }
  if (!response.ok) {
    throw new ShopifyError(`Shopify returned HTTP ${response.status}`, text.slice(0, 500));
  }

  let body: {
    data?: T;
    errors?: { message: string }[];
    extensions?: { cost?: { throttleStatus?: ThrottleStatus } };
  };
  try {
    body = JSON.parse(text);
  } catch {
    throw new ShopifyError('Shopify returned a response that was not JSON', text.slice(0, 500));
  }

  if (body.errors?.length) {
    throw new ShopifyError(body.errors.map((e) => e.message).join('; '), body.errors);
  }
  if (!body.data) {
    throw new ShopifyError('Shopify returned no data', body);
  }

  return { data: body.data, throttle: body.extensions?.cost?.throttleStatus ?? null };
}
