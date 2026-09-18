/**
 * The state of the current run, mirrored to disk.
 *
 * The page never waits on a long request. Starting a run returns immediately;
 * the run continues in the background and writes its progress to
 * `runs/current.json`, which the page polls. Closing the tab, or reopening it
 * an hour later, changes nothing.
 *
 * The heartbeat is what makes a crash visible. If the process dies mid-run the
 * file is left saying "running" forever, so we record a timestamp every few
 * seconds and treat a stale one as a crash rather than leaving the UI wedged.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { run } from '../run/runner.js';
import type { ProductResult, RunReport } from '../run/report.js';
import { latestFinishedPreview, pictureSincePreview, type ReportTiming } from '../domain/selection.js';
import { runsDir } from '../paths.js';

const RUNS_DIR = runsDir();
const STATE_FILE = path.join(RUNS_DIR, 'current.json');
const HEARTBEAT_MS = 5_000;

/** A run whose heartbeat is older than this is assumed dead. */
export const STALE_AFTER_MS = 120_000;

export interface RunState {
  runId: string;
  mode: 'preview' | 'commit';
  status: 'running' | 'finished' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  heartbeat: string;
  done: number;
  total: number;
  /** The Selection a commit was started with; null on a preview. */
  skus: string[] | null;
  error: string | null;
  /** Results so far while running; the complete set once finished. */
  results: ProductResult[];
  report: RunReport | null;
}

let current: RunState | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

async function persist(): Promise<void> {
  if (!current) return;
  await fs.mkdir(RUNS_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(current, null, 2));
}

/** Reads from disk, so a state written by a process that has since died is still visible. */
export async function readState(): Promise<RunState | null> {
  if (current) return current;
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) as RunState;
  } catch {
    return null;
  }
}

export function isStale(state: RunState): boolean {
  return (
    state.status === 'running' && Date.now() - new Date(state.heartbeat).getTime() > STALE_AFTER_MS
  );
}

export async function isRunning(): Promise<boolean> {
  const state = await readState();
  return state !== null && state.status === 'running' && !isStale(state);
}

interface ReportSummary extends ReportTiming {
  file: string;
  startedAt: string;
}

/**
 * Each report's timing, parsed once and remembered until its file changes. The
 * page polls, and a report still being written changes with every product.
 */
const summaries = new Map<string, { mtimeMs: number; summary: ReportSummary | null }>();

async function summariseReports(): Promise<ReportSummary[]> {
  let names: string[];
  try {
    names = await fs.readdir(RUNS_DIR);
  } catch {
    return [];
  }

  const found: ReportSummary[] = [];
  // `current.json` is the page's run state, not a report.
  for (const name of names.filter((n) => n.endsWith('.json') && n !== 'current.json')) {
    const file = path.join(RUNS_DIR, name);
    try {
      const { mtimeMs } = await fs.stat(file);
      let cached = summaries.get(file);
      if (!cached || cached.mtimeMs !== mtimeMs) {
        const report = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<RunReport>;
        const summary =
          (report.mode === 'preview' || report.mode === 'commit') && report.startedAt
            ? { file, mode: report.mode, startedAt: report.startedAt, finishedAt: report.finishedAt ?? null }
            : null;
        cached = { mtimeMs, summary };
        summaries.set(file, cached);
      }
      if (cached.summary) found.push(cached.summary);
    } catch {
      // Half-written or unreadable: it tells us nothing, so it counts for nothing.
    }
  }
  return found;
}

export interface SincePreview {
  /** When the most recent finished preview finished; the Selection clock. */
  lastPreviewAt: string | null;
  /** That preview, with every commit since laid over it. Null with no preview. */
  results: ProductResult[] | null;
}

/**
 * The owner's picture of the sheet: the last finished preview and what has been
 * created from it since. Read from the run reports on disk, so neither
 * reloading the page nor restarting the app loses it. A commit still running,
 * or one that crashed, counts for what it did — its report is written after
 * every product.
 */
export async function sincePreview(): Promise<SincePreview> {
  const reports = await summariseReports();
  const at = latestFinishedPreview(reports);
  const preview = reports.find((r) => r.mode === 'preview' && r.finishedAt === at);
  if (!at || !preview) return { lastPreviewAt: null, results: null };

  const commits = reports
    .filter((r) => r.mode === 'commit' && Date.parse(r.startedAt) >= Date.parse(at))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  const resultsOf = async (r: ReportSummary): Promise<ProductResult[]> => {
    try {
      return (JSON.parse(await fs.readFile(r.file, 'utf8')) as RunReport).results ?? [];
    } catch {
      return [];
    }
  };

  return {
    lastPreviewAt: at,
    results: pictureSincePreview(
      await resultsOf(preview),
      await Promise.all(commits.map(resultsOf)),
    ),
  };
}

export interface StartOptions {
  commit: boolean;
  /** The Selection. Required for a commit; ignored by a preview. */
  skus: string[] | null;
}

/**
 * Starts a run in the background and returns as soon as it has begun.
 *
 * Refuses when one is already going: two concurrent runs would race on the same
 * SKUs, and the obvious way for that to happen is somebody hitting refresh on a
 * page that looks stuck.
 */
export async function startRun(options: StartOptions): Promise<RunState> {
  if (await isRunning()) throw new Error('a run is already in progress');

  current = {
    runId: randomUUID(),
    mode: options.commit ? 'commit' : 'preview',
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    heartbeat: new Date().toISOString(),
    done: 0,
    total: 0,
    skus: options.commit ? options.skus : null,
    error: null,
    results: [],
    report: null,
  };
  await persist();

  heartbeatTimer = setInterval(() => {
    if (current?.status === 'running') {
      current.heartbeat = new Date().toISOString();
      void persist();
    }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();

  // Deliberately not awaited: the HTTP request returns now, the work continues.
  void (async () => {
    try {
      const report = await run({
        commit: options.commit,
        // A preview ignores it; the runner sees to that.
        skus: options.skus ?? undefined,
        onProgress: (result, done, total) => {
          if (!current) return;
          current.results.push(result);
          current.done = done;
          current.total = total;
          current.heartbeat = new Date().toISOString();
          void persist();
        },
      });

      if (current) {
        current.report = report;
        current.results = report.results;
        current.status = 'finished';
        current.finishedAt = new Date().toISOString();
        current.heartbeat = new Date().toISOString();
      }
    } catch (error: unknown) {
      if (current) {
        current.status = 'failed';
        current.error = error instanceof Error ? error.message : String(error);
        current.finishedAt = new Date().toISOString();
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      await persist();
    }
  })();

  return current;
}
