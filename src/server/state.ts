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
  limit: number | null;
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

export interface StartOptions {
  commit: boolean;
  limit: number | null;
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
    limit: options.limit,
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
        limit: options.limit ?? undefined,
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
