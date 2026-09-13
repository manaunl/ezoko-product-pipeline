/**
 * Where state lives.
 *
 * Code and state used to share a directory — `.env`, `.google-token.json` and
 * `runs/` all sat next to `src/`. That is fine until the day an update replaces
 * the code, because replacing the code would then take the credentials with it.
 * So state moves out, to a directory an update never touches:
 *
 *     ~/Library/Application Support/Ezoko/
 *
 * Everything that persists between runs is resolved through this file. Nothing
 * else should build a path by hand, and nothing should be resolved relative to
 * the current working directory — an app launched by double-clicking in Finder
 * does not have the working directory you expect.
 *
 * `EZOKO_STATE_DIR` overrides it, which is how tests and a second checkout stay
 * out of each other's way. The default is the safe one: if nothing sets the
 * variable, state still lands somewhere an update cannot destroy.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * The checkout — or installed version folder — this file was loaded from.
 * Used only to find state left behind by an older layout.
 */
const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The directory holding everything that outlives a version. */
export function stateDir(): string {
  const override = process.env.EZOKO_STATE_DIR?.trim();
  if (override) return path.resolve(override);

  const home = os.homedir();
  return process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Ezoko')
    : path.join(home, '.ezoko');
}

/** Credentials and settings, written by the setup page. */
export function envPath(): string {
  return path.join(stateDir(), '.env');
}

/**
 * The cached Google refresh token.
 *
 * Not hidden with a leading dot any more. It was hidden when it lived in the
 * repository, where a dotfile keeps clutter out of `ls`; here the whole folder
 * is ours, and a name Finder will actually show is worth more than tidiness.
 */
export function tokenPath(): string {
  return path.join(stateDir(), 'google-token.json');
}

/** Run reports — the support story, so they must survive an update. */
export function runsDir(): string {
  return path.join(stateDir(), 'runs');
}

/**
 * A data file the operator may edit, merged over the one shipped in `data/`.
 *
 * The shipped table stays code-owned so improvements keep arriving with each
 * release; this holds only what he changed. Copying the shipped file here
 * instead would freeze it at install time and silently cut him off from every
 * later fix.
 */
export function localDataPath(name: string): string {
  return path.join(stateDir(), name);
}

/**
 * The installation folder — the one holding `versions/`, `current` and
 * `start.command` — or null when this is a source checkout.
 *
 * Null is the honest answer in development, and the update UI says so rather
 * than offering a button that could only ever half-work. Detection is the
 * layout itself: installed code lives at `<app>/versions/<version>/`, so the
 * directory above this one being named `versions` is the whole test.
 */
export function installRoot(): string | null {
  const override = process.env.EZOKO_INSTALL_ROOT?.trim();
  if (override) return path.resolve(override);

  const parent = path.dirname(CODE_ROOT);
  return path.basename(parent) === 'versions' ? path.dirname(parent) : null;
}

/** Where unpacked versions live, inside the installation folder. */
export function versionsDir(root: string): string {
  return path.join(root, 'versions');
}

/**
 * Written immediately before exiting 75, naming the version to fall back to.
 * Its presence is what puts the next start on probation — see `start.command`.
 */
export function pendingMarker(root: string): string {
  return path.join(root, '.pending-version');
}

/** Left by the launcher when it undid an update, for the page to show. */
export function rollbackNote(root: string): string {
  return path.join(root, '.rollback-note');
}

/** Creates the state directory if it isn't there. Safe to call repeatedly. */
export function ensureStateDir(): string {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Brings forward state from the old layout, where it lived beside the code.
 *
 * Copies rather than moves: the old folder stays a working installation, which
 * is what makes it the rollback if this one turns out wrong. Never overwrites —
 * once the new location has a file, it is the only one that matters.
 *
 * Synchronous on purpose, so it can run before anything reads an environment
 * variable without dragging top-level `await` into every entry point.
 *
 * `legacyRoot` is a parameter only so this is testable against a directory that
 * isn't the one the test itself is running from.
 */
export function adoptLegacyState(legacyRoot: string = CODE_ROOT): string[] {
  const moved: string[] = [];

  const pairs: Array<[from: string, to: string]> = [
    [path.join(legacyRoot, '.env'), envPath()],
    [path.join(legacyRoot, '.google-token.json'), tokenPath()],
  ];

  for (const [from, to] of pairs) {
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    ensureStateDir();
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o600);
    moved.push(`${path.basename(from)} → ${to}`);
  }

  return moved;
}

/**
 * Loads `.env` from the state directory.
 *
 * Replaces `import 'dotenv/config'`, which reads `.env` from the current
 * working directory — the one thing we cannot rely on.
 */
export function loadEnv(): void {
  dotenv.config({ path: envPath() });
}
