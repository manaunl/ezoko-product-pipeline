/**
 * Google sign-in.
 *
 * Uses the OAuth "desktop app" flow: we start a throwaway web server on
 * localhost, send you to Google in a browser, and catch the redirect back.
 * The resulting refresh token is cached in the state directory so you only
 * sign in once (until it expires — see README).
 */

import '../bootstrap.js';

import http from 'node:http';
import fs from 'node:fs/promises';
import { OAuth2Client } from 'google-auth-library';
import { ensureStateDir, envPath, tokenPath } from '../paths.js';

const TOKEN_PATH = tokenPath();

/** Read the sheet, write our own status columns, read the photo folder. */
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
];

/** Where the token lives, so the setup page can report whether we are signed in. */
export const TOKEN_PATH_FOR_DISPLAY = TOKEN_PATH;

export async function isSignedIn(): Promise<boolean> {
  try {
    const raw = await fs.readFile(TOKEN_PATH, 'utf8');
    return typeof (JSON.parse(raw) as { refresh_token?: string }).refresh_token === 'string';
  } catch {
    return false;
  }
}

/**
 * The browser-based half of sign-in, for the setup page: the caller sends the
 * person to this URL and handles the redirect back itself. The CLI flow below
 * runs its own throwaway server instead.
 */
export function authUrlFor(redirectUri: string): string {
  return createClient(redirectUri).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

export async function exchangeAndSave(code: string, redirectUri: string): Promise<void> {
  const { tokens } = await createClient(redirectUri).getToken(code);
  ensureStateDir();
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function createClient(redirectUri: string): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing.\n' +
        `Fill them in on the setup page, or add them to ${envPath()} — see README step 1.`,
    );
  }
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

/** Interactive sign-in. Opens a browser, waits for the redirect, saves the token. */
export async function signIn(): Promise<void> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('could not start the local sign-in server');
  }
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  const client = createClient(redirectUri);

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('\nOpen this link in your browser and approve access:\n');
  console.log(`  ${url}\n`);

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out after 5 minutes')), 5 * 60_000);

    server.on('request', (req, res) => {
      const requestUrl = new URL(req.url ?? '/', redirectUri);
      const returned = requestUrl.searchParams.get('code');
      const error = requestUrl.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        returned
          ? '<p style="font:16px system-ui">Signed in. You can close this tab.</p>'
          : `<p style="font:16px system-ui">Sign-in failed: ${error ?? 'no code returned'}</p>`,
      );

      clearTimeout(timer);
      if (returned) resolve(returned);
      else reject(new Error(error ?? 'no code returned'));
    });
  }).finally(() => server.close());

  const { tokens } = await client.getToken(code);
  ensureStateDir();
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log(`Saved to ${TOKEN_PATH}`);
}

/** Load the cached token for normal use. */
export async function loadAuth(): Promise<OAuth2Client> {
  let raw: string;
  try {
    raw = await fs.readFile(TOKEN_PATH, 'utf8');
  } catch {
    throw new Error('Not signed in yet. Run:  npm run login');
  }

  const client = createClient('http://127.0.0.1/callback');
  client.setCredentials(JSON.parse(raw));
  return client;
}
