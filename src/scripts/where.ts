/**
 * Where everything lives.
 *
 *   npx tsx src/scripts/where.ts
 *
 * The first question of any support conversation is "which files is it actually
 * using?", and the answer is no longer "the folder you unzipped" — state lives
 * outside the app so an update cannot destroy it. This prints the answer.
 */

import '../bootstrap.js';

import fs from 'node:fs';
import { envPath, runsDir, stateDir, tokenPath } from '../paths.js';
import { VERSION } from '../version.js';

function mark(file: string): string {
  return fs.existsSync(file) ? 'present' : 'missing';
}

console.log(`version           ${VERSION}`);
console.log(`state directory   ${stateDir()}`);
console.log(`  settings        ${envPath()}  (${mark(envPath())})`);
console.log(`  Google sign-in  ${tokenPath()}  (${mark(tokenPath())})`);
console.log(`  run reports     ${runsDir()}  (${mark(runsDir())})`);

if (process.env.EZOKO_STATE_DIR) {
  console.log(`\nEZOKO_STATE_DIR is set, which is what chose that directory.`);
}
