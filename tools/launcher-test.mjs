#!/usr/bin/env node
/**
 * Does the launcher survive a bad update?
 *
 *   npm run build && npm run test:launcher
 *
 * `start.command` is the one piece with no unit tests behind it, and the one
 * piece whose failure means the owner's tool does not open at all. So it gets
 * exercised for real: a fake installation with several versions in it, one of
 * them deliberately broken, and an update staged exactly the way the updater
 * will stage it.
 *
 * Two things this learned the hard way, both of which made it lie:
 *
 *   - killing the launcher kills bash, not the `node` it started. The orphan
 *     keeps the port, and the next scenario then "passes" against a server from
 *     the previous one. Everything here runs in its own process group and the
 *     group gets killed.
 *   - asking "did something answer?" is not the same as "did the right version
 *     answer?". Each fake version carries its own version number, and the
 *     checks read it back off `/api/config`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, 'build', 'stage');
const PORT = 4597;

let failures = 0;

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The version currently answering on the port, or null if nothing is. */
async function servingVersion() {
  return fetch(`http://127.0.0.1:${PORT}/api/config`)
    .then((r) => r.json())
    .then((body) => body.version ?? null)
    .catch(() => null);
}

/** Waits for any server to answer, and reports which version it was. */
async function waitForVersion(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const version = await servingVersion();
    if (version) return version;
    await sleep(250);
  }
  // Nothing came up. What the launcher printed is the only evidence there is.
  console.log(`\n  --- launcher output ---\n${lastLogs.text || '(nothing)'}  -----------------------\n`);
  return null;
}

/**
 * Is anything at all listening?
 *
 * Not the same question as "does it answer /api/config". A half-dead server, or
 * an orphan from an earlier run, holds the port without answering — and then
 * every scenario here fails with EADDRINUSE and blames the launcher.
 */
function portIsBusy() {
  return new Promise((resolve) => {
    const socket = net
      .connect({ port: PORT, host: '127.0.0.1' })
      .on('connect', () => (socket.destroy(), resolve(true)))
      .on('error', () => resolve(false));
    socket.setTimeout(1000, () => (socket.destroy(), resolve(false)));
  });
}

async function waitForSilence(timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!(await portIsBusy())) return true;
    await sleep(200);
  }
  return false;
}

let running = null;
let lastLogs = { text: '' };

function startLauncher(app, state) {
  const child = spawn('./start.command', [], {
    cwd: app,
    env: { ...process.env, PORT: String(PORT), EZOKO_STATE_DIR: state, EZOKO_NO_BROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so stopping it stops the node it started too.
    detached: true,
  });

  const logs = { text: '' };
  child.stdout.on('data', (c) => (logs.text += c));
  child.stderr.on('data', (c) => (logs.text += c));

  running = child;
  lastLogs = logs;
  return { child, logs };
}

async function stopLauncher() {
  if (!running) return;
  try {
    process.kill(-running.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  running = null;
  await waitForSilence();
}

/** A copy of the built app, stamped with its own version number. */
function makeVersion(app, version, mainJs = null) {
  const dir = path.join(app, 'versions', version);
  fs.cpSync(STAGE, dir, { recursive: true });

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  pkg.version = version;
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  if (mainJs !== null) fs.writeFileSync(path.join(dir, 'dist/server/main.js'), mainJs);
  return dir;
}

async function main() {
  if (!fs.existsSync(STAGE)) throw new Error('run `npm run build` first');
  if (await portIsBusy()) {
    throw new Error(
      `something is already listening on port ${PORT} — probably an orphan from an\n` +
        `earlier run. Find it with:  lsof -ti tcp:${PORT}`,
    );
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezoko-launcher-'));
  const app = path.join(temp, 'Ezoko');
  const state = path.join(temp, 'state');
  fs.mkdirSync(app, { recursive: true });

  fs.copyFileSync(path.join(ROOT, 'start.command'), path.join(app, 'start.command'));
  fs.chmodSync(path.join(app, 'start.command'), 0o755);

  const current = path.join(app, 'current');
  const pending = path.join(app, '.pending-version');
  const note = path.join(app, '.rollback-note');
  const link = () => (fs.existsSync(current) ? fs.readlinkSync(current) : 'none');

  console.log('\nLauncher test\n');

  try {
    // --- 0. A source checkout ------------------------------------------------
    //
    // The repository downloaded as a ZIP has no `versions` folder, and for a
    // while the launcher refused to start in it — which broke the only way the
    // tool had ever been delivered. Run the real checkout, from its own root.
    const checkout = spawn('./start.command', [], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        EZOKO_STATE_DIR: path.join(temp, 'checkout-state'),
        EZOKO_NO_BROWSER: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    running = checkout;
    let checkoutSaid = '';
    checkout.stdout.on('data', (c) => (checkoutSaid += c));
    checkout.stderr.on('data', (c) => (checkoutSaid += c));

    const fromSource = await waitForVersion(40_000);
    check('starts from a source checkout, with no `versions` folder', fromSource !== null,
      fromSource ? `(${fromSource})` : `(${checkoutSaid.slice(0, 90)})`);
    check(
      'and offers no updates there, because a checkout is updated with git',
      (await fetch(`http://127.0.0.1:${PORT}/api/update`).then((r) => r.json())).installRoot === null,
    );
    await stopLauncher();

    // --- 1. A fresh install ships no symlink. The launcher must make one. ----
    makeVersion(app, '1.0.0');
    let started = await (startLauncher(app, state), waitForVersion(25_000));
    check('starts a fresh install that has no `current` link', started === '1.0.0', `(${started})`);
    check('created the link itself', link() === 'versions/1.0.0', `(→ ${link()})`);
    await stopLauncher();

    // --- 2. With two versions present, it picks the newer one ---------------
    makeVersion(app, '1.2.0');
    fs.rmSync(current, { force: true });

    started = await (startLauncher(app, state), waitForVersion(25_000));
    check('picks the newest version when the link is missing', started === '1.2.0', `(${started})`);
    await stopLauncher();

    // --- 3. A bad update, staged exactly as the updater will stage it -------
    makeVersion(app, '1.3.0', "throw new Error('deliberately broken release');\n");
    fs.writeFileSync(pending, '1.2.0\n');
    fs.rmSync(current, { force: true });
    fs.symlinkSync('versions/1.3.0', current);

    const { logs } = startLauncher(app, state);
    started = await waitForVersion(60_000);

    check('recovers from a version that will not start', started === '1.2.0', `(${started})`);
    check('puts `current` back to the previous version', link() === 'versions/1.2.0', `(→ ${link()})`);
    check('clears the pending marker', !fs.existsSync(pending));
    check(
      'leaves a note naming both versions',
      fs.existsSync(note) && fs.readFileSync(note, 'utf8').trim() === '1.3.0|1.2.0',
      fs.existsSync(note) ? `("${fs.readFileSync(note, 'utf8').trim()}")` : '(no note)',
    );
    check('says so on screen', /would not start/i.test(logs.text) && /1\.3\.0/.test(logs.text));
    check('keeps the broken version on disk', fs.existsSync(path.join(app, 'versions/1.3.0')));
    await stopLauncher();

    // --- 4. Exit 75 means "restart me" — how an update applies itself -------
    const marker = path.join(app, 'restarted-once');
    const restartOnce = makeVersion(app, '1.4.0');
    fs.copyFileSync(
      path.join(restartOnce, 'dist/server/main.js'),
      path.join(restartOnce, 'dist/server/main.real.js'),
    );
    fs.writeFileSync(
      path.join(restartOnce, 'dist/server/main.js'),
      `import fs from 'node:fs';
if (!fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, 'yes');
  process.exit(75);
}
await import('./main.real.js');
`,
    );
    fs.rmSync(current, { force: true });
    fs.symlinkSync('versions/1.4.0', current);

    startLauncher(app, state);
    started = await waitForVersion(40_000);
    check('restarts itself on exit code 75', started === '1.4.0', `(${started})`);
    check('and did restart rather than never exiting', fs.existsSync(marker));
    await stopLauncher();

    // --- 5. Double-clicked twice -------------------------------------------
    // The port is taken by the copy already running. That must read as "it is
    // already open", not as a crash, and must not disturb the running one.
    fs.rmSync(current, { force: true });
    fs.symlinkSync('versions/1.2.0', current);
    startLauncher(app, state);
    check('first copy is serving', (await waitForVersion(25_000)) === '1.2.0');

    const second = spawn('./start.command', [], {
      cwd: app,
      env: { ...process.env, PORT: String(PORT), EZOKO_STATE_DIR: state, EZOKO_NO_BROWSER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let secondSaid = '';
    second.stdout.on('data', (c) => (secondSaid += c));
    second.stderr.on('data', (c) => (secondSaid += c));

    const secondCode = await new Promise((resolve) => second.on('exit', resolve));
    check('a second copy exits quietly', secondCode === 0, `(code ${secondCode})`);
    check('and says it is already running', /already running/i.test(secondSaid));
    check('without disturbing the first', (await servingVersion()) === '1.2.0');
    await stopLauncher();

    // --- 6. Nothing leaked into the app folder ------------------------------
    check(
      'still writes nothing into the app folder',
      !fs.existsSync(path.join(app, '.env')) && !fs.existsSync(path.join(app, 'runs')),
    );
  } finally {
    await stopLauncher();
    fs.rmSync(temp, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAll good.\n' : `\n${failures} failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  await stopLauncher();
  console.error(`\n${error.message}\n`);
  process.exit(1);
});
