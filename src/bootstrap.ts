/**
 * What every entry point does before anything else.
 *
 * Imported for its side effect, in place of `dotenv/config`, which reads `.env`
 * from the current working directory. Keep it as the first import in a script
 * so the environment is loaded before any module that reads it.
 */

import { adoptLegacyState, loadEnv, stateDir } from './paths.js';

const adopted = adoptLegacyState();
for (const line of adopted) {
  console.log(`Brought your existing settings forward: ${line}`);
}
if (adopted.length > 0) {
  console.log(`Settings now live in ${stateDir()} — the old folder is untouched.\n`);
}

loadEnv();
