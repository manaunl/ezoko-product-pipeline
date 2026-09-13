/**
 * Where state lives.
 *
 * Worth testing despite being short: every one of these functions decides where
 * somebody's credentials end up, and getting it wrong either puts them inside
 * the folder an update replaces or loses them outright.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adoptLegacyState,
  ensureStateDir,
  envPath,
  localDataPath,
  runsDir,
  stateDir,
  tokenPath,
} from '../src/paths.js';

let temp: string;
const originalOverride = process.env.EZOKO_STATE_DIR;

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezoko-paths-'));
  process.env.EZOKO_STATE_DIR = path.join(temp, 'state');
});

afterEach(() => {
  if (originalOverride === undefined) delete process.env.EZOKO_STATE_DIR;
  else process.env.EZOKO_STATE_DIR = originalOverride;
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('stateDir', () => {
  it('honours EZOKO_STATE_DIR', () => {
    expect(stateDir()).toBe(path.join(temp, 'state'));
  });

  it('resolves a relative override, so a stray working directory cannot move it', () => {
    process.env.EZOKO_STATE_DIR = 'some/relative/dir';
    expect(path.isAbsolute(stateDir())).toBe(true);
  });

  it('falls back to a per-user directory outside any checkout', () => {
    delete process.env.EZOKO_STATE_DIR;
    const fallback = stateDir();

    expect(path.isAbsolute(fallback)).toBe(true);
    expect(fallback.startsWith(os.homedir())).toBe(true);
    expect(fallback).toBe(
      process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'Ezoko')
        : path.join(os.homedir(), '.ezoko'),
    );
  });

  it('puts every file it owns inside itself', () => {
    for (const file of [envPath(), tokenPath(), runsDir(), localDataPath('stone-names.local.json')]) {
      expect(path.dirname(file)).toBe(stateDir());
    }
  });
});

describe('ensureStateDir', () => {
  it('creates the directory and is safe to call twice', () => {
    ensureStateDir();
    ensureStateDir();
    expect(fs.statSync(stateDir()).isDirectory()).toBe(true);
  });

  it('does not make it world-readable — it holds credentials', () => {
    ensureStateDir();
    expect(fs.statSync(stateDir()).mode & 0o077).toBe(0);
  });
});

describe('adoptLegacyState', () => {
  /**
   * The old layout kept state beside the code. These pin the properties that
   * make the move safe: the old install keeps working, a file already in the
   * new home is never overwritten by a stale one, and running it repeatedly —
   * which it will be, on every start — changes nothing after the first time.
   */
  let legacy: string;

  beforeEach(() => {
    legacy = path.join(temp, 'old-install');
    fs.mkdirSync(legacy, { recursive: true });
  });

  it('brings both files forward, renaming the token to something Finder shows', () => {
    fs.writeFileSync(path.join(legacy, '.env'), 'GOOGLE_SHEET_ID=abc\n');
    fs.writeFileSync(path.join(legacy, '.google-token.json'), '{"refresh_token":"r"}');

    const moved = adoptLegacyState(legacy);

    expect(moved).toHaveLength(2);
    expect(fs.readFileSync(envPath(), 'utf8')).toBe('GOOGLE_SHEET_ID=abc\n');
    expect(fs.readFileSync(tokenPath(), 'utf8')).toBe('{"refresh_token":"r"}');
    expect(path.basename(tokenPath())).toBe('google-token.json');
  });

  it('copies rather than moves, so the old folder is still the rollback', () => {
    fs.writeFileSync(path.join(legacy, '.env'), 'GOOGLE_SHEET_ID=abc\n');

    adoptLegacyState(legacy);

    expect(fs.existsSync(path.join(legacy, '.env'))).toBe(true);
  });

  it('never overwrites what is already there', () => {
    ensureStateDir();
    fs.writeFileSync(envPath(), 'GOOGLE_SHEET_ID=current\n');
    fs.writeFileSync(path.join(legacy, '.env'), 'GOOGLE_SHEET_ID=stale\n');

    const moved = adoptLegacyState(legacy);

    expect(moved).toEqual([]);
    expect(fs.readFileSync(envPath(), 'utf8')).toBe('GOOGLE_SHEET_ID=current\n');
  });

  it('is a no-op the second time, because it runs on every start', () => {
    fs.writeFileSync(path.join(legacy, '.env'), 'GOOGLE_SHEET_ID=abc\n');

    expect(adoptLegacyState(legacy)).toHaveLength(1);
    expect(adoptLegacyState(legacy)).toEqual([]);
  });

  it('says nothing when there is no old install', () => {
    expect(adoptLegacyState(path.join(temp, 'nowhere'))).toEqual([]);
  });

  it('does not widen permissions on a credential file', () => {
    fs.writeFileSync(path.join(legacy, '.env'), 'GOOGLE_SHEET_ID=abc\n', { mode: 0o644 });

    adoptLegacyState(legacy);

    expect(fs.statSync(envPath()).mode & 0o077).toBe(0);
  });
});
