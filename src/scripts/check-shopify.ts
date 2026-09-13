/**
 * Prove the Shopify credentials work, and report what the store looks like.
 *
 * Read-only: nothing is created, changed or deleted.
 *
 *   npx tsx src/scripts/check-shopify.ts
 */

import { API_VERSION, shopifyGraphql } from '../shopify/client.js';

const QUERY = `
  query storeCheck {
    shop {
      name
      myshopifyDomain
      currencyCode
      ianaTimezone
    }
    locations(first: 10) {
      nodes { id name isActive }
    }
    productsCount { count }
  }
`;

interface StoreCheck {
  shop: {
    name: string;
    myshopifyDomain: string;
    currencyCode: string;
    ianaTimezone: string;
  };
  locations: { nodes: { id: string; name: string; isActive: boolean }[] };
  productsCount: { count: number };
}

async function main(): Promise<void> {
  const { data, throttle } = await shopifyGraphql<StoreCheck>(QUERY);

  console.log(`\nConnected to Shopify  (Admin API ${API_VERSION})\n`);
  console.log(`  Store       ${data.shop.name}`);
  console.log(`  Domain      ${data.shop.myshopifyDomain}`);
  console.log(`  Currency    ${data.shop.currencyCode}`);
  console.log(`  Timezone    ${data.shop.ianaTimezone}`);
  console.log(`  Products    ${data.productsCount.count}`);

  console.log(`\n  Locations`);
  for (const location of data.locations.nodes) {
    console.log(
      `    ${location.name}${location.isActive ? '' : '  (inactive)'}\n      ${location.id}`,
    );
  }

  if (data.locations.nodes.length !== 1) {
    console.log(
      `\n  Note: ${data.locations.nodes.length} locations. Inventory needs an explicit target — ` +
        `add SHOPIFY_LOCATION_ID to .env.`,
    );
  }

  if (throttle) {
    console.log(
      `\n  Rate limit  ${throttle.currentlyAvailable}/${throttle.maximumAvailable} points, ` +
        `restoring ${throttle.restoreRate}/s`,
    );
  }

  if (data.shop.currencyCode !== 'HUF') {
    console.log(
      `\n  Warning: store currency is ${data.shop.currencyCode}, not HUF. Prices from the sheet ` +
        `are forints and would be published as ${data.shop.currencyCode}.`,
    );
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
