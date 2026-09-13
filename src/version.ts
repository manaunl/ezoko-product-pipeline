/**
 * Which version is running.
 *
 * Read from the `package.json` one directory up, which is true in a checkout
 * (`src/version.ts`) and in a built release (`dist/version.js`) alike — so there
 * is one answer and no build step has to stamp it anywhere.
 *
 * It is the first question of every support conversation, so it belongs in the
 * run report and on the page, not only in a file nobody opens.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };

export const VERSION: string = pkg.version ?? '0.0.0';
