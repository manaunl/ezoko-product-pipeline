/**
 * The local web page.
 *
 * Bound to 127.0.0.1 only — never 0.0.0.0. This process holds a live Shopify
 * write token, and there is no reason for it to be reachable from the café wifi.
 *
 *   npm start
 */

import '../bootstrap.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { isRunning, isStale, readState, sincePreview, startRun } from './state.js';
import { applyUpdate, checkForUpdate, switchToVersion } from '../update/install.js';
import { readConfig, writeConfig } from './config.js';
import { authUrlFor, exchangeAndSave, isSignedIn, loadAuth } from '../google/auth.js';
import { listPhotoFiles } from '../google/drive.js';
import { readSheet } from '../google/sheets.js';
import { decideChannels } from '../domain/channels.js';
import { resetTokenCache, shopifyGraphql, storeDomain } from '../shopify/client.js';
import { probeChannels } from '../shopify/products.js';
import { fetchDescriptionCatalogue } from '../storefront/feed.js';
import { VERSION } from '../version.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4517);

/**
 * Where Google sends the person back to. Always loopback — Google accepts any
 * loopback port for a desktop client, so this needs no registration.
 */
const REDIRECT_URI = `http://127.0.0.1:${PORT}/auth/google/callback`;

const app = express();
app.use(express.json());
app.use(express.static(path.join(HERE, 'public')));

app.get('/api/config', (_req, res) => {
  let store = '(not configured)';
  try {
    store = storeDomain();
  } catch {
    // Shown in the UI rather than crashing the server on a bad .env.
  }
  res.json({ store, sheetTab: process.env.GOOGLE_SHEET_TAB ?? '', version: VERSION });
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

app.get('/api/setup', async (_req, res) => {
  const config = await readConfig();
  res.json({ ...config, googleSignedIn: await isSignedIn() });
});

app.post('/api/setup', async (req, res) => {
  try {
    await writeConfig(req.body ?? {});
    // The credentials may have changed, so any token minted from the old ones
    // must go rather than being used until it expires.
    resetTokenCache();
    res.json({ ok: true, ...(await readConfig()) });
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Sends the person to Google, and comes back to the callback below. */
app.get('/auth/google', (req, res) => {
  try {
    res.redirect(authUrlFor(REDIRECT_URI));
  } catch (error: unknown) {
    res.status(400).send(
      `<p style="font:16px system-ui;padding:24px">${
        error instanceof Error ? error.message : String(error)
      }</p>`,
    );
  }
});

app.get('/auth/google/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const failure = typeof req.query.error === 'string' ? req.query.error : null;

  if (!code) {
    res.redirect(`/setup.html?google=${encodeURIComponent(failure ?? 'no code returned')}`);
    return;
  }

  try {
    await exchangeAndSave(code, REDIRECT_URI);
    res.redirect('/setup.html?google=ok');
  } catch (error: unknown) {
    res.redirect(
      `/setup.html?google=${encodeURIComponent(error instanceof Error ? error.message : String(error))}`,
    );
  }
});

/** Read-only checks so the page can say "this works" rather than "saved". */
app.post('/api/setup/test', async (_req, res) => {
  const result: Record<string, { ok: boolean; message: string }> = {};

  try {
    const { data } = await shopifyGraphql<{ shop: { name: string; currencyCode: string } }>(
      `query { shop { name currencyCode } }`,
    );
    result.shopify = {
      ok: true,
      message: `Connected to ${data.shop.name} (${data.shop.currencyCode})`,
    };
  } catch (error: unknown) {
    result.shopify = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  try {
    const auth = await loadAuth();
    const sheet = await readSheet(
      auth,
      process.env.GOOGLE_SHEET_ID ?? '',
      process.env.GOOGLE_SHEET_TAB ?? '',
    );
    const missing = sheet.columns.missingRequired;
    result.sheet = missing.length
      ? { ok: false, message: `Found the sheet, but these columns are missing: ${missing.join(', ')}` }
      : { ok: true, message: `${sheet.rows.length} rows in "${sheet.tab}"` };
  } catch (error: unknown) {
    result.sheet = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  try {
    const files = await listPhotoFiles(await loadAuth(), process.env.GOOGLE_DRIVE_FOLDER_ID ?? '');
    result.drive = { ok: true, message: `${files.length} files in the photo folder` };
  } catch (error: unknown) {
    result.drive = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  // The shop's own published copy, which every new product's description is
  // taken from. A run refuses to start if this is unreachable, so it belongs
  // in the same check as the other three.
  try {
    const copy = await fetchDescriptionCatalogue();
    result.storefront = {
      ok: true,
      message: `${copy.catalogue.size} stones described, from ${copy.products} products on ${copy.host}`,
    };
  } catch (error: unknown) {
    result.storefront = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // The channels every created product will be made available to. A run
  // refuses to start without these, so this doubles as the first place
  // anyone working on this tool can see the store's actual channel names.
  // See ADR-0009.
  const channelsDecision = decideChannels(await probeChannels());
  result.channels = { ok: channelsDecision.proceed, message: channelsDecision.message };

  res.json(result);
});

app.get('/api/status', async (_req, res) => {
  // The page measures a Selection's four hours from `lastPreviewAt`, and shows
  // `picture` — the preview with what has been created since — once no preview
  // is running. The server does no age check of its own; see the page.
  const { lastPreviewAt, results: picture } = await sincePreview();
  const state = await readState();
  if (!state) {
    res.json({ status: 'idle', lastPreviewAt, picture });
    return;
  }
  res.json({ ...state, stale: isStale(state), lastPreviewAt, picture });
});

app.post('/api/start', async (req, res) => {
  const commit = req.body?.commit === true;
  const rawSkus: unknown = req.body?.skus;
  const skus = Array.isArray(rawSkus)
    ? rawSkus.filter((sku): sku is string => typeof sku === 'string' && sku.trim() !== '')
    : [];

  // The page only ever creates what was ticked. Without this, a commit with no
  // SKUs would mean "everything", as it does on the command line.
  if (commit && skus.length === 0) {
    res.status(400).json({ error: 'Tick at least one product to create.' });
    return;
  }

  try {
    const state = await startRun({ commit, skus });
    res.json(state);
  } catch (error: unknown) {
    res.status(409).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

app.get('/api/update', async (_req, res) => {
  res.json(await checkForUpdate());
});

/**
 * Applies an update, or steps back to a version already installed.
 *
 * Both end the same way: the process exits 75 and the launcher starts what
 * `current` now points at. The response goes out first, so the page knows to
 * start waiting for the server to come back rather than seeing a dropped
 * connection and calling it an error.
 */
app.post('/api/update', async (req, res) => {
  // Never mid-run. Restarting during a commit would strand a run partway
  // through creating products — recoverable, since Shopify is the source of
  // truth, but it would look like a crash nobody caused.
  if (await isRunning()) {
    res.status(409).json({
      error: 'A run is in progress. Wait for it to finish, then update.',
    });
    return;
  }

  const goBackTo = typeof req.body?.version === 'string' ? req.body.version.trim() : '';

  if (goBackTo !== '') {
    res.json({ started: true, version: goBackTo });
    setTimeout(() => void switchToVersion(goBackTo), 50);
    return;
  }

  const status = await checkForUpdate();
  if (status.decision.kind !== 'available') {
    res.status(409).json({ error: 'There is no update to install.' });
    return;
  }

  const update = status.decision;
  res.json({ started: true, version: update.version });
  // After the response, and never awaited: it ends by killing this process.
  // Anything that goes wrong is reported through GET /api/update instead.
  setTimeout(() => void applyUpdate(update), 50);
});

/**
 * Exit code meaning "the port is taken, so it is probably already running".
 * The launcher opens the browser and stops quietly rather than reporting a
 * crash — double-clicking the app twice is the normal way to reach this.
 */
const ALREADY_RUNNING = 3;

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Ezoko product pipeline\n`);
  console.log(`  Open  http://127.0.0.1:${PORT}\n`);
  console.log(`  Press Ctrl+C to stop.\n`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.log(`\n  The uploader is already running.\n`);
    console.log(`  Open  http://127.0.0.1:${PORT}\n`);
    process.exit(ALREADY_RUNNING);
  }

  console.error(`\n  Could not start: ${error.message}\n`);
  process.exit(1);
});
