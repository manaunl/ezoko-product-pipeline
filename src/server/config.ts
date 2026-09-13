/**
 * Reading and writing .env from the setup page.
 *
 * Editing rather than rewriting: the file keeps its comments and any keys we
 * don't know about, because someone may have put something there by hand and
 * silently dropping it would be worse than useless.
 *
 * Secrets are never sent to the browser. The page is told whether each one is
 * set, not what it is — a page that displays your credentials back to you is a
 * page that leaks them into screenshots and screen shares.
 */

import fs from 'node:fs/promises';
import { ensureStateDir, envPath } from '../paths.js';

const ENV_PATH = envPath();

/** Values safe to show the person filling in the form. */
export const VISIBLE_KEYS = [
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_CLIENT_ID',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_SHEET_ID',
  'GOOGLE_SHEET_TAB',
  'GOOGLE_DRIVE_FOLDER_ID',
  'EZOKO_STOREFRONT_URL',
] as const;

/** Never sent back to the browser — only whether they are present. */
export const SECRET_KEYS = ['SHOPIFY_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET'] as const;

export type ConfigKey = (typeof VISIBLE_KEYS)[number] | (typeof SECRET_KEYS)[number];

const ALL_KEYS: ConfigKey[] = [...VISIBLE_KEYS, ...SECRET_KEYS];

async function readFileOrEmpty(): Promise<string> {
  try {
    return await fs.readFile(ENV_PATH, 'utf8');
  } catch {
    return '';
  }
}

function parse(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (!match) continue;
    values.set(match[1]!, match[2]!.trim().replace(/^["']|["']$/g, ''));
  }
  return values;
}

/**
 * A Google Sheet or Drive folder is normally identified by pasting its URL, so
 * accept the whole thing and pull the id out. Asking someone to extract a
 * 44-character substring from a URL is asking for a typo.
 */
export function extractId(raw: string): string {
  const value = raw.trim();
  const sheet = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (sheet) return sheet[1]!;
  const folder = value.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folder) return folder[1]!;
  const drivePath = value.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (drivePath) return drivePath[1]!;
  return value;
}

/** Strips scheme and trailing slash so a pasted admin URL still works. */
export function normaliseDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}

export interface ConfigView {
  values: Record<string, string>;
  /** Which secrets already have a value stored. */
  secretsSet: Record<string, boolean>;
  envPath: string;
}

export async function readConfig(): Promise<ConfigView> {
  const stored = parse(await readFileOrEmpty());

  const values: Record<string, string> = {};
  for (const key of VISIBLE_KEYS) values[key] = stored.get(key) ?? '';

  const secretsSet: Record<string, boolean> = {};
  for (const key of SECRET_KEYS) {
    const value = stored.get(key) ?? '';
    secretsSet[key] = value !== '' && !value.startsWith('shpss_xxxx') && !value.startsWith('xxxx');
  }

  return { values, secretsSet, envPath: ENV_PATH };
}

/**
 * Writes the given keys, leaving everything else in the file untouched.
 *
 * A blank secret means "keep what is already there", so re-saving the form
 * after changing only the sheet tab doesn't wipe the credentials.
 */
export async function writeConfig(incoming: Partial<Record<ConfigKey, string>>): Promise<void> {
  const original = await readFileOrEmpty();
  const lines = original === '' ? [] : original.split('\n');

  const cleaned: Partial<Record<ConfigKey, string>> = {};
  for (const key of ALL_KEYS) {
    const raw = incoming[key];
    if (raw === undefined) continue;

    const value = raw.trim();
    if (value === '' && SECRET_KEYS.includes(key as (typeof SECRET_KEYS)[number])) continue;

    cleaned[key] =
      key === 'SHOPIFY_STORE_DOMAIN'
        ? normaliseDomain(value)
        : key === 'GOOGLE_SHEET_ID' || key === 'GOOGLE_DRIVE_FOLDER_ID'
          ? extractId(value)
          : value;
  }

  const written = new Set<string>();

  const updated = lines.map((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!match) return line;

    const key = match[1] as ConfigKey;
    if (!(key in cleaned)) return line;

    written.add(key);
    return `${key}=${cleaned[key]}`;
  });

  for (const [key, value] of Object.entries(cleaned)) {
    if (!written.has(key)) updated.push(`${key}=${value}`);
  }

  ensureStateDir();
  await fs.writeFile(ENV_PATH, `${updated.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
  await fs.chmod(ENV_PATH, 0o600);

  // Update the running process too, so saving takes effect without a restart.
  for (const [key, value] of Object.entries(cleaned)) process.env[key] = value;
}
