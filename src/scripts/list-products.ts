/**
 * List what is actually in the store, with the fields this tool sets.
 *
 * Read-only. For checking a run by eye without clicking through the admin.
 *
 *   npx tsx src/scripts/list-products.ts
 */

import { shopifyGraphql, storeDomain } from '../shopify/client.js';

const QUERY = `
  query listProducts($cursor: String) {
    products(first: 50, after: $cursor, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        status
        totalInventory
        productType
        tags
        descriptionHtml
        media(first: 20) { nodes { ... on MediaImage { status } } }
        variants(first: 1) {
          nodes { id sku price inventoryItem { measurement { weight { value unit } } } }
        }
      }
    }
  }
`;

interface Product {
  id: string;
  title: string;
  status: string;
  totalInventory: number;
  productType: string;
  tags: string[];
  descriptionHtml: string;
  media: { nodes: { status?: string }[] };
  variants: {
    nodes: {
      sku: string | null;
      price: string;
      inventoryItem: { measurement: { weight: { value: number; unit: string } | null } | null };
    }[];
  };
}

async function main(): Promise<void> {
  const products: Product[] = [];
  let cursor: string | null = null;

  do {
    type Page = {
      products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Product[] };
    };
    const { data }: { data: Page } = await shopifyGraphql<Page>(QUERY, { cursor });
    products.push(...data.products.nodes);
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  console.log(`\n${products.length} products in ${storeDomain()}\n`);

  for (const product of products) {
    const variant = product.variants.nodes[0];
    const ready = product.media.nodes.filter((m) => m.status === 'READY').length;
    const weight = variant?.inventoryItem?.measurement?.weight;

    console.log(`  ${product.title}`);
    console.log(
      `      sku ${variant?.sku || '\x1b[31m(none)\x1b[0m'}   price ${variant?.price ?? '-'}   ` +
        `qty ${product.totalInventory}   weight ${weight ? `${weight.value} ${weight.unit}` : '-'}`,
    );
    console.log(
      `      ${product.status.toLowerCase()}   ${ready}/${product.media.nodes.length} images ready   ` +
        `type ${product.productType || '-'}   tags ${product.tags.join(', ') || '-'}`,
    );
    console.log(`      \x1b[2m${product.descriptionHtml || '(no description)'}\x1b[0m`);
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
