#!/usr/bin/env node
/**
 * Builds the release artifact.
 *
 *   npm run build
 *
 * The output is one gzipped tar holding everything needed to run, including
 * `node_modules`. Updating on the owner's Mac is then a file operation — unpack,
 * repoint a symlink — rather than an installation. No npm, no registry, no
 * PATH under a Finder-launched shell, and no way to end up half installed.
 *
 * What goes in:
 *
 *   package.json      production dependencies only; start script runs plain node
 *   dist/             compiled JS — no tsx, no typescript
 *   dist/server/public/   the web page, which tsc does not copy
 *   data/             stone names and aliases, at ../../data from dist/domain/
 *   node_modules/     installed with --omit=dev
 *
 * The checksum beside it is what makes a truncated download detectable before
 * anything is swapped into place.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const STAGE = path.join(BUILD, 'stage');

/** Scripts the release needs. Everything test- or build-related is left behind. */
const RELEASE_SCRIPTS = {
  start: 'node dist/server/main.js',
  login: 'node dist/google/login.js',
};

function run(command, args, cwd = ROOT) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function step(text) {
  console.log(`  ${text}`);
}

function directorySize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
  }
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}M`;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const { version } = pkg;
const tarball = path.join(BUILD, `ezoko-${version}.tgz`);

console.log(`\nBuilding ezoko ${version}\n`);

// 1. Start from nothing. A stale file left in the staging directory would ship.
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// 2. Compile. tsc emits straight into the staging directory.
step('compiling TypeScript');
run('npx', ['tsc', '-p', 'tsconfig.build.json']);

// 3. Things tsc does not carry: the web page, and the data tables.
step('copying the web page and data tables');
fs.cpSync(path.join(ROOT, 'src/server/public'), path.join(STAGE, 'dist/server/public'), {
  recursive: true,
});
fs.cpSync(path.join(ROOT, 'data'), path.join(STAGE, 'data'), { recursive: true });

// 4. A package.json with no devDependencies, so `npm ci --omit=dev` below can
//    never be talked into installing a toolchain, and nothing at runtime can
//    reach for tsx.
step('writing package.json');
fs.writeFileSync(
  path.join(STAGE, 'package.json'),
  `${JSON.stringify(
    {
      name: pkg.name,
      version,
      private: true,
      type: pkg.type,
      description: pkg.description,
      engines: pkg.engines,
      scripts: RELEASE_SCRIPTS,
      dependencies: pkg.dependencies,
    },
    null,
    2,
  )}\n`,
);
fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(STAGE, 'package-lock.json'));

// 5. Install exactly what the lockfile says, production only.
step('installing production dependencies');
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], STAGE);

// 6. One archive of the staging directory's contents, so it unpacks straight
//    into a version folder rather than nesting one.
step('packing');
run('tar', ['-czf', tarball, '-C', STAGE, '.']);

const bytes = fs.readFileSync(tarball);
const checksum = crypto.createHash('sha256').update(bytes).digest('hex');
fs.writeFileSync(`${tarball}.sha256`, `${checksum}  ${path.basename(tarball)}\n`);

// 7. The first-install archive: the launcher plus one version, in the layout
//    the launcher expects. No `current` symlink — zip archives carry those
//    unreliably, and the launcher creates it on first run anyway.
step('assembling the installer');
const install = path.join(BUILD, 'install');
const folder = path.join(install, 'Ezoko');
fs.mkdirSync(folder, { recursive: true });
fs.cpSync(STAGE, path.join(folder, 'versions', version), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'start.command'), path.join(folder, 'start.command'));
fs.chmodSync(path.join(folder, 'start.command'), 0o755);

const zip = path.join(BUILD, `Ezoko-${version}.zip`);
run('zip', ['-qry', zip, 'Ezoko'], install);

console.log(`\n  ${path.relative(ROOT, tarball)}`);
console.log(`  ${mb(bytes.length)} packed · ${mb(directorySize(STAGE))} unpacked`);
console.log(`  sha256 ${checksum}`);
console.log(`\n  ${path.relative(ROOT, zip)}`);
console.log(`  ${mb(fs.statSync(zip).size)} · what the owner downloads for a first install\n`);
