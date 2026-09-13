#!/usr/bin/env node
/**
 * Does the built artifact actually run?
 *
 *   npm run build && npm run smoke
 *
 * Unpacks the tarball somewhere clean, points it at an empty state directory,
 * and starts it the way the owner's Mac will: plain `node`, no tsx, no repository
 * around it. Everything checked here is something a compiler cannot see —
 * whether the data tables are still reachable at their relative path, whether
 * the web page got copied, whether an unconfigured install starts at all
 * instead of crashing on a missing `.env`.
 *
 * Exits non-zero on the first failure, so CI can gate a release on it.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const PORT = 4598;

let failures = 0;

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const tarball = fs
    .readdirSync(BUILD)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => path.join(BUILD, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

  if (!tarball) throw new Error('no tarball in build/ — run `npm run build` first');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezoko-smoke-'));
  const app = path.join(temp, 'app');
  const state = path.join(temp, 'state');
  fs.mkdirSync(app);

  console.log(`\nSmoke test of ${path.basename(tarball)}\n`);

  // 1. Unpack, exactly as the updater will.
  execFileSync('tar', ['-xzf', tarball, '-C', app]);
  check('unpacks', fs.existsSync(path.join(app, 'dist/server/main.js')));

  // 2. The toolchain must not have come along. If tsx is in here, the build is
  //    shipping a devDependency the run path used to depend on.
  const modules = path.join(app, 'node_modules');
  check('no tsx in the release', !fs.existsSync(path.join(modules, 'tsx')));
  check('no typescript in the release', !fs.existsSync(path.join(modules, 'typescript')));
  check('no vitest in the release', !fs.existsSync(path.join(modules, 'vitest')));

  // 3. The web page, which tsc does not copy and nothing would notice missing
  //    until the browser showed "Cannot GET /".
  check('web page present', fs.existsSync(path.join(app, 'dist/server/public/index.html')));
  check('setup page present', fs.existsSync(path.join(app, 'dist/server/public/setup.html')));

  // 4. The pages' inline scripts must parse. A syntax error in there kills every
  //    button on the page and shows nothing at all — the server still serves it,
  //    the HTML still looks fine, and only the browser console says why.
  for (const page of ['index.html', 'setup.html']) {
    const html = fs.readFileSync(path.join(app, 'dist/server/public', page), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    let parsed = true;
    let why = '';
    for (const source of scripts) {
      const file = path.join(temp, `${page}.js`);
      fs.writeFileSync(file, source);
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      } catch (error) {
        parsed = false;
        why = String(error.stderr ?? '').split('\n').slice(0, 3).join(' ').trim();
      }
    }
    check(`${page} script parses`, scripts.length > 0 && parsed, parsed ? '' : `(${why})`);
  }

  // 5. The data tables, reached by a relative path from compiled code. This is
  //    the one the new layout is most likely to break.
  const stone = execFileSync(
    process.execPath,
    ['-e', "import('./dist/domain/stones.js').then(m => console.log(m.translateStone('achát').english))"],
    { cwd: app, encoding: 'utf8' },
  ).trim();
  check('stone-name table loads', stone === 'Agate', `("achát" → "${stone}")`);

  const version = execFileSync(
    process.execPath,
    ['-e', "import('./dist/version.js').then(m => console.log(m.VERSION))"],
    { cwd: app, encoding: 'utf8' },
  ).trim();
  check('reports its own version', /^\d+\.\d+\.\d+/.test(version), `(${version})`);

  // 5. Start it with no credentials at all. A fresh install has none, and it
  //    must still serve the setup page rather than dying on a missing .env.
  const server = spawn(process.execPath, ['dist/server/main.js'], {
    cwd: app,
    env: { ...process.env, EZOKO_STATE_DIR: state, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  server.stdout.on('data', (chunk) => (output += chunk));
  server.stderr.on('data', (chunk) => (output += chunk));

  try {
    let answered = false;
    for (let attempt = 0; attempt < 60 && !answered; attempt += 1) {
      await sleep(250);
      if (server.exitCode !== null) break;
      answered = await fetch(`http://127.0.0.1:${PORT}/`).then(
        (r) => r.ok,
        () => false,
      );
    }
    check('starts with no credentials', answered);

    if (answered) {
      const setupPage = await fetch(`http://127.0.0.1:${PORT}/setup.html`);
      check('serves the setup page', setupPage.status === 200);

      const setup = await fetch(`http://127.0.0.1:${PORT}/api/setup`).then((r) => r.json());
      check('uses the state directory it was given', setup.envPath === path.join(state, '.env'));
      check('reports no secrets stored yet', setup.secretsSet.SHOPIFY_CLIENT_SECRET === false);

      const status = await fetch(`http://127.0.0.1:${PORT}/api/status`).then((r) => r.json());
      check('reports no run in progress', status.status === 'idle');
    } else {
      console.log(`\n--- server output ---\n${output}`);
    }
  } finally {
    server.kill();
  }

  // 6. Starting it must not have written anything into the app folder — that is
  //    the whole point of the state directory, and the failure is silent.
  const strayEnv = fs.existsSync(path.join(app, '.env'));
  const strayRuns = fs.existsSync(path.join(app, 'runs'));
  check('writes nothing into the app folder', !strayEnv && !strayRuns);

  fs.rmSync(temp, { recursive: true, force: true });

  console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  process.exit(1);
});
