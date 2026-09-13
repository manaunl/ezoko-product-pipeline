#!/usr/bin/env node
/**
 * Does an update actually install itself?
 *
 *   npm run build && npm run test:update
 *
 * A real installation, a real launcher, a real tarball — and a fake GitHub
 * served from localhost, so nothing here touches the network or depends on a
 * release existing. The update is driven the way the page drives it: POST to
 * /api/update, then poll until the server comes back on the new version.
 *
 * Covers the three endings that matter:
 *
 *   1. a good release installs and restarts into itself
 *   2. a tarball that does not match its checksum is refused, untouched
 *   3. a release that installs but will not start is rolled back by the launcher
 */

import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, 'build', 'stage');
const PORT = 4594;
const GITHUB_PORT = 4593;

let failures = 0;

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function portIsBusy(port) {
  return new Promise((resolve) => {
    const socket = net
      .connect({ port, host: '127.0.0.1' })
      .on('connect', () => (socket.destroy(), resolve(true)))
      .on('error', () => resolve(false));
    socket.setTimeout(1000, () => (socket.destroy(), resolve(false)));
  });
}

const api = (route) => fetch(`http://127.0.0.1:${PORT}${route}`).then((r) => r.json());

async function servingVersion() {
  return api('/api/config')
    .then((body) => body.version ?? null)
    .catch(() => null);
}

async function waitForVersion(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const version = await servingVersion();
    if (version) return version;
    await sleep(250);
  }
  return null;
}

/**
 * Waits for a *different* version to be serving.
 *
 * Asking "is something answering?" is not enough: the restart takes under a
 * second, so the old server is very often still answering when the question is
 * asked, and every check then passes against the version being replaced.
 */
async function waitForVersionOtherThan(previous, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const version = await servingVersion();
    if (version && version !== previous) return version;
    await sleep(250);
  }
  return await servingVersion();
}

/** Builds a release tarball from the staged build, stamped with a version. */
function makeRelease(dir, version, { breakIt = false, corrupt = false } = {}) {
  const work = path.join(dir, `src-${version}`);
  fs.cpSync(STAGE, work, { recursive: true });

  const pkg = JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8'));
  pkg.version = version;
  fs.writeFileSync(path.join(work, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  if (breakIt) {
    fs.writeFileSync(
      path.join(work, 'dist/server/main.js'),
      "throw new Error('this release does not start');\n",
    );
  }

  const tarball = path.join(dir, `ezoko-${version}.tgz`);
  execFileSync('tar', ['-czf', tarball, '-C', work, '.']);

  const real = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  const published = corrupt ? 'b'.repeat(64) : real;
  fs.writeFileSync(`${tarball}.sha256`, `${published}  ezoko-${version}.tgz\n`);

  fs.rmSync(work, { recursive: true, force: true });
  return { version, tarball };
}

/** A stand-in for GitHub's releases API and its asset downloads. */
function fakeGithub(dir) {
  let current = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${GITHUB_PORT}`);

    if (url.pathname.endsWith('/releases/latest')) {
      if (!current) {
        res.writeHead(404).end('{"message":"Not Found"}');
        return;
      }
      const base = `http://127.0.0.1:${GITHUB_PORT}/assets`;
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          tag_name: `v${current.version}`,
          body: 'Made the thing better.',
          html_url: 'http://example.test/release',
          draft: false,
          prerelease: false,
          assets: [
            {
              name: `ezoko-${current.version}.tgz`,
              browser_download_url: `${base}/ezoko-${current.version}.tgz`,
            },
            {
              name: `ezoko-${current.version}.tgz.sha256`,
              browser_download_url: `${base}/ezoko-${current.version}.tgz.sha256`,
            },
          ],
        }),
      );
      return;
    }

    if (url.pathname.startsWith('/assets/')) {
      const file = path.join(dir, path.basename(url.pathname));
      if (!fs.existsSync(file)) {
        res.writeHead(404).end('nope');
        return;
      }
      res.writeHead(200).end(fs.readFileSync(file));
      return;
    }

    res.writeHead(404).end('nope');
  });

  return {
    listen: () => new Promise((r) => server.listen(GITHUB_PORT, '127.0.0.1', r)),
    publish: (release) => (current = release),
    close: () => server.close(),
  };
}

let launcher = null;

function startLauncher(app, state) {
  launcher = spawn('./start.command', [], {
    cwd: app,
    env: {
      ...process.env,
      PORT: String(PORT),
      EZOKO_STATE_DIR: state,
      EZOKO_NO_BROWSER: '1',
      EZOKO_UPDATE_API: `http://127.0.0.1:${GITHUB_PORT}`,
      EZOKO_UPDATE_REPO: 'example/ezoko',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const logs = { text: '' };
  launcher.stdout.on('data', (c) => (logs.text += c));
  launcher.stderr.on('data', (c) => (logs.text += c));
  return logs;
}

async function stopLauncher() {
  if (!launcher) return;
  try {
    process.kill(-launcher.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  launcher = null;
  for (let i = 0; i < 40 && (await portIsBusy(PORT)); i += 1) await sleep(250);
}

/**
 * Presses "Update now" and follows it to one of its three endings.
 *
 * A restart is recognised by the served version changing, not by catching the
 * server while it is down — that window is well under a second and missing it
 * would make every later check compare against the version being replaced.
 */
async function pressUpdate(expected, timeoutMs = 150_000) {
  const started = await fetch(`http://127.0.0.1:${PORT}/api/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!started.ok) return { started: false, error: (await started.json()).error };

  const until = Date.now() + timeoutMs;

  while (Date.now() < until) {
    await sleep(400);
    const status = await api('/api/update').catch(() => null);
    if (!status) continue; // Mid-restart.

    // Installed and running.
    if (status.version === expected) return { started: true, restarted: true, version: expected };

    // Installed, would not start, and the launcher put the old one back. The
    // served version is the one we began on, so "the version changed" can never
    // detect this — the note is the only evidence.
    if (status.rolledBack?.failed === expected) {
      return { started: true, rolledBack: status.rolledBack };
    }

    if (status.progress?.state === 'failed') {
      return { started: true, restarted: false, error: status.progress.error };
    }
  }
  return { started: true, timedOut: true };
}

/** The launcher clears the pending marker only after a version survives probation. */
async function waitForMarkerCleared(file, timeoutMs = 25_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!fs.existsSync(file)) return true;
    await sleep(500);
  }
  return false;
}

async function main() {
  if (!fs.existsSync(STAGE)) throw new Error('run `npm run build` first');
  for (const port of [PORT, GITHUB_PORT]) {
    if (await portIsBusy(port)) throw new Error(`port ${port} is in use — lsof -ti tcp:${port}`);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezoko-update-'));
  const app = path.join(temp, 'Ezoko');
  const state = path.join(temp, 'state');
  const releases = path.join(temp, 'releases');
  fs.mkdirSync(path.join(app, 'versions'), { recursive: true });
  fs.mkdirSync(releases);

  // The installed 1.0.0.
  fs.cpSync(STAGE, path.join(app, 'versions/1.0.0'), { recursive: true });
  const installed = JSON.parse(
    fs.readFileSync(path.join(app, 'versions/1.0.0/package.json'), 'utf8'),
  );
  installed.version = '1.0.0';
  fs.writeFileSync(
    path.join(app, 'versions/1.0.0/package.json'),
    `${JSON.stringify(installed, null, 2)}\n`,
  );
  fs.copyFileSync(path.join(ROOT, 'start.command'), path.join(app, 'start.command'));
  fs.chmodSync(path.join(app, 'start.command'), 0o755);

  const github = fakeGithub(releases);
  await github.listen();

  console.log('\nUpdate test\n');

  try {
    // --- 1. No release published yet ----------------------------------------
    startLauncher(app, state);
    check('starts on the installed version', (await waitForVersion(25_000)) === '1.0.0');

    let status = await api('/api/update');
    check('knows it is an installation', status.installRoot !== null);
    check('offers nothing when there is no release', status.decision.kind === 'up-to-date');

    // --- 2. A release whose checksum does not match -------------------------
    github.publish(makeRelease(releases, '1.1.0', { corrupt: true }));
    status = await api('/api/update');
    check('sees the new release', status.decision.kind === 'available', `(${status.decision.kind})`);

    let result = await pressUpdate('1.1.0');
    check('refuses a download that fails its checksum', result.restarted === false);
    check(
      'and says why, in words',
      /checksum/i.test(result.error ?? ''),
      `("${(result.error ?? '').slice(0, 60)}…")`,
    );
    check(
      'without unpacking anything',
      !fs.existsSync(path.join(app, 'versions/1.1.0')),
    );
    check('and is still running the old version', (await servingVersion()) === '1.0.0');

    // --- 3. A good release --------------------------------------------------
    github.publish(makeRelease(releases, '1.2.0'));
    result = await pressUpdate('1.2.0');
    check('installs a good release', result.restarted === true);
    check('and restarts into it', (await waitForVersionOtherThan('1.0.0', 40_000)) === '1.2.0');
    check(
      'pointing `current` at the new version',
      fs.readlinkSync(path.join(app, 'current')) === 'versions/1.2.0',
      `(→ ${fs.readlinkSync(path.join(app, 'current'))})`,
    );
    check('keeping the old version on disk', fs.existsSync(path.join(app, 'versions/1.0.0')));
    check(
      'and clearing the pending marker once it survives probation',
      await waitForMarkerCleared(path.join(app, '.pending-version')),
    );

    status = await api('/api/update');
    check('now reports itself up to date', status.decision.kind === 'up-to-date');
    check('and offers the old version to step back to', status.otherVersions.includes('1.0.0'));

    // --- 4. A release that installs but will not start ----------------------
    github.publish(makeRelease(releases, '1.3.0', { breakIt: true }));
    result = await pressUpdate('1.3.0');
    check(
      'a release that will not start is undone',
      result.rolledBack?.failed === '1.3.0',
      result.rolledBack ? '' : `(${JSON.stringify(result).slice(0, 70)})`,
    );

    const after = await waitForVersionOtherThan('1.3.0', 60_000);
    check('leaving the previous version running', after === '1.2.0', `(${after})`);

    status = await api('/api/update');
    check(
      'and the page is told what happened',
      status.rolledBack?.failed === '1.3.0' && status.rolledBack?.running === '1.2.0',
      status.rolledBack ? `(${status.rolledBack.failed} → ${status.rolledBack.running})` : '(no note)',
    );

    // --- 5. Stepping back on purpose ---------------------------------------
    const back = await fetch(`http://127.0.0.1:${PORT}/api/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '1.0.0' }),
    });
    check('accepts a deliberate step back', back.ok);
    const stepped = await waitForVersionOtherThan('1.2.0', 45_000);
    check('and goes back to it', stepped === '1.0.0', `(${stepped})`);

    // --- 6. Nothing written into the app folder ----------------------------
    check(
      'still writes nothing into the app folder',
      !fs.existsSync(path.join(app, '.env')) && !fs.existsSync(path.join(app, 'runs')),
    );
  } finally {
    await stopLauncher();
    github.close();
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
