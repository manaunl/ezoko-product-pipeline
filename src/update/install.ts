/**
 * Fetching and installing a new version.
 *
 * The decisions all live in `src/domain/updates.ts`, where they are tested.
 * What is left here is the part that touches the network and the disk, kept as
 * thin as it can be:
 *
 *   1. ask GitHub for the newest release
 *   2. download the tarball and its checksum
 *   3. refuse unless the bytes hash to what the checksum says
 *   4. unpack into a new version folder
 *   5. write down the version to fall back to, repoint `current`, exit 75
 *
 * Nothing is swapped until step 4 has finished, so a download that dies halfway
 * leaves the running installation untouched. The launcher does the rest: if the
 * new version fails to start, it puts the old one back.
 *
 * No delete anywhere, in keeping with the rest of the codebase. Old versions
 * accumulate at about 20MB each and are pruned by nothing — being able to step
 * back is worth more than the disk.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  decideUpdate,
  parseChecksum,
  type AvailableUpdate,
  type Release,
  type UpdateDecision,
} from '../domain/updates.js';
import { installRoot, pendingMarker, rollbackNote, versionsDir } from '../paths.js';
import { VERSION } from '../version.js';

const run = promisify(execFile);

/**
 * Where releases are published. Not configurable by the operator: pointing the
 * updater at another repository is a way to run somebody else's code.
 * `EZOKO_UPDATE_REPO` exists for the tests, which serve a fake release locally.
 */
const REPO = process.env.EZOKO_UPDATE_REPO ?? 'manaunl/ezoko-product-pipeline';

/** The API base, overridable so tests never reach GitHub. */
const API = process.env.EZOKO_UPDATE_API ?? 'https://api.github.com';

/** Exit code the launcher reads as "restart me". */
export const RESTART_CODE = 75;

const CHECK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

/**
 * What the update is doing right now.
 *
 * An update takes minutes and ends by killing the process, so it cannot be one
 * HTTP request. The page starts it and then polls this — and on success the
 * poll fails, because the server has restarted, which is the signal to wait for
 * it to come back. A failure has to be visible here rather than thrown into a
 * request nobody is listening to any more.
 */
export type UpdateProgress =
  | { state: 'idle' }
  | { state: 'working'; step: string }
  | { state: 'failed'; error: string };

let progress: UpdateProgress = { state: 'idle' };

export function updateProgress(): UpdateProgress {
  return progress;
}

export interface UpdateStatus {
  /** What is running now. */
  version: string;
  /** Null when running from a source checkout, where updating makes no sense. */
  installRoot: string | null;
  decision: UpdateDecision;
  /** Set when the launcher undid an update since the last successful start. */
  rolledBack: { failed: string; running: string } | null;
  /** Other versions on disk, newest first — what "go back" can offer. */
  otherVersions: string[];
  /** Why the last check failed, if it did. Never fatal. */
  error: string | null;
  progress: UpdateProgress;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'ezoko-product-pipeline' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`);
  return response.json();
}

/** The newest published release, or null when the repository has none. */
async function latestRelease(): Promise<Release | null> {
  try {
    return (await fetchJson(`${API}/repos/${REPO}/releases/latest`, CHECK_TIMEOUT_MS)) as Release;
  } catch (error) {
    // A repository with no releases answers 404, which is not a problem.
    if (error instanceof Error && error.message.includes('404')) return null;
    throw error;
  }
}

async function readRollbackNote(root: string): Promise<UpdateStatus['rolledBack']> {
  try {
    const [failed, running] = (await fs.readFile(rollbackNote(root), 'utf8')).trim().split('|');
    return failed && running ? { failed, running } : null;
  } catch {
    return null;
  }
}

async function installedVersions(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(versionsDir(root), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * What the page needs to draw the banner.
 *
 * Never throws. An unreachable GitHub, a laptop with no wifi, a rate limit —
 * all of it comes back as `error` beside an otherwise complete answer, because
 * the update check must never be able to stop the tool from working.
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const root = installRoot();

  const status: UpdateStatus = {
    version: VERSION,
    installRoot: root,
    decision: { kind: 'up-to-date', version: VERSION },
    rolledBack: root ? await readRollbackNote(root) : null,
    otherVersions: root
      ? (await installedVersions(root)).filter((version) => version !== VERSION).sort().reverse()
      : [],
    error: null,
    progress,
  };

  if (!root) return status;

  try {
    status.decision = decideUpdate(VERSION, await latestRelease());
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
  }

  return status;
}

async function download(url: string, timeoutMs: number): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { 'user-agent': 'ezoko-product-pipeline' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`download failed: ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Downloads, verifies, unpacks and switches to a release, reporting progress.
 *
 * Never rejects: a failure is recorded in `progress` for the page to show,
 * because by the time this runs the request that asked for it has been answered
 * and nobody is waiting on the promise.
 */
export async function applyUpdate(update: AvailableUpdate): Promise<void> {
  progress = { state: 'working', step: `Downloading version ${update.version}…` };
  try {
    await install(update);
  } catch (error) {
    progress = { state: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

async function install(update: AvailableUpdate): Promise<never | void> {
  const root = installRoot();
  if (!root) throw new Error('this is a source checkout, not an installation — updates do not apply here');

  const target = path.join(versionsDir(root), update.version);
  if (await exists(target)) {
    throw new Error(`version ${update.version} is already unpacked — restart to use it`);
  }

  const expected = parseChecksum(await download(update.checksumUrl, CHECK_TIMEOUT_MS).then((b) => b.toString('utf8')));
  if (!expected) throw new Error('the published checksum could not be read, so the download cannot be trusted');

  const bytes = await download(update.url, DOWNLOAD_TIMEOUT_MS);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `the download does not match its published checksum, so it was not installed.\n` +
        `Expected ${expected}, got ${actual}. Try again; if it keeps happening the release is broken.`,
    );
  }

  progress = { state: 'working', step: `Unpacking version ${update.version}…` };

  // Unpack beside the target and move it into place, so an interrupted unpack
  // never leaves a half-written version folder that looks installed.
  const staging = await fs.mkdtemp(path.join(versionsDir(root), `.unpacking-${update.version}-`));
  const archive = path.join(os.tmpdir(), `ezoko-${update.version}-${process.pid}.tgz`);

  try {
    await fs.writeFile(archive, bytes);
    await run('tar', ['-xzf', archive, '-C', staging]);

    if (!(await exists(path.join(staging, 'dist/server/main.js')))) {
      throw new Error(`release ${update.version} does not contain a runnable app`);
    }

    await fs.rename(staging, target);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    await fs.rm(archive, { force: true });
  }

  // From here the launcher takes over. The marker is what puts the next start
  // on probation, so it must be written before `current` moves — a crash
  // between the two would otherwise leave a new version running unwatched.
  progress = { state: 'working', step: `Restarting into version ${update.version}…` };
  await fs.writeFile(pendingMarker(root), `${VERSION}\n`);
  await pointCurrentAt(root, update.version);

  process.exit(RESTART_CODE);
}

/** Switches back to a version already on disk. Same restart path as an update. */
export async function switchToVersion(version: string): Promise<void> {
  progress = { state: 'working', step: `Going back to version ${version}…` };
  try {
    await stepBack(version);
  } catch (error) {
    progress = { state: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

async function stepBack(version: string): Promise<never | void> {
  const root = installRoot();
  if (!root) throw new Error('this is a source checkout, not an installation');

  if (!(await exists(path.join(versionsDir(root), version, 'dist/server/main.js')))) {
    throw new Error(`version ${version} is not installed`);
  }

  // No pending marker: this is a deliberate move to a version that has run
  // before, so the launcher should not treat a later crash as a bad update.
  await fs.rm(pendingMarker(root), { force: true });
  await pointCurrentAt(root, version);

  process.exit(RESTART_CODE);
}

/**
 * Repoints `current`, atomically.
 *
 * `rename` over the existing symlink, via `mv -h` so that `mv` replaces the
 * link rather than following it into the directory it points at. The launcher
 * does the same thing for the same reason.
 */
async function pointCurrentAt(root: string, version: string): Promise<void> {
  const temporary = path.join(root, '.current.new');
  await fs.rm(temporary, { force: true });
  await fs.symlink(path.join('versions', version), temporary);
  await run('mv', ['-fh', temporary, path.join(root, 'current')]);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}
