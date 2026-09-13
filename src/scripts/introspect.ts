/**
 * Ask the store's own schema what a type looks like.
 *
 * More reliable than the docs for input objects, which change between API
 * versions and are often documented incompletely.
 *
 *   npx tsx src/scripts/introspect.ts InventorySetQuantitiesInput
 */

import { API_VERSION, shopifyGraphql } from '../shopify/client.js';

const QUERY = `
  query introspect($name: String!) {
    __type(name: $name) {
      name
      kind
      description
      inputFields {
        name
        description
        type { kind name ofType { kind name ofType { kind name } } }
      }
      enumValues { name }
    }
  }
`;

interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}

function render(type: TypeRef | null | undefined): string {
  if (!type) return '?';
  if (type.kind === 'NON_NULL') return `${render(type.ofType)}!`;
  if (type.kind === 'LIST') return `[${render(type.ofType)}]`;
  return type.name ?? '?';
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) throw new Error('Usage: npx tsx src/scripts/introspect.ts <TypeName>');

  const { data } = await shopifyGraphql<{
    __type: {
      name: string;
      kind: string;
      description: string | null;
      inputFields: { name: string; description: string | null; type: TypeRef }[] | null;
      enumValues: { name: string }[] | null;
    } | null;
  }>(QUERY, { name });

  if (!data.__type) throw new Error(`no type called "${name}" in API ${API_VERSION}`);

  console.log(`\n${data.__type.name}  (${data.__type.kind}, API ${API_VERSION})\n`);

  for (const field of data.__type.inputFields ?? []) {
    console.log(`  ${field.name.padEnd(26)} ${render(field.type)}`);
  }
  const values = data.__type.enumValues ?? [];
  if (values.length > 0) console.log(`  ${values.map((v) => v.name).join(', ')}`);
  console.log('');
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
