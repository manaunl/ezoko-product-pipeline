import { describe, expect, it } from 'vitest';
import { chooseRowsToAttempt, latestFinishedPreview } from '../src/domain/selection.js';

/** A creatable row, reduced to what the choice looks at. */
const row = (rowNumber: number, sku: string) => ({ rowNumber, draft: { sku } });

const creatable = [row(3, 'SP-190-B'), row(5, 'CA-738-A1'), row(9, 'TW-012')];
const sheetSkus = ['SP-190-B', 'CA-738-A1', 'TW-012'];

const rowNumbers = (rows: { rowNumber: number }[]) => rows.map((r) => r.rowNumber);

describe('choosing which rows to attempt', () => {
  it('attempts every creatable row when there is no limit and no Selection', () => {
    const choice = chooseRowsToAttempt(creatable, { sheetSkus });

    expect(rowNumbers(choice.attempt)).toEqual([3, 5, 9]);
    expect(choice.notAttempted).toEqual([]);
    expect(choice.missingFromSheet).toEqual([]);
  });

  it('attempts the first N with a limit and reports the rest as limited', () => {
    const choice = chooseRowsToAttempt(creatable, { limit: 1, sheetSkus });

    expect(rowNumbers(choice.attempt)).toEqual([3]);
    expect(choice.notAttempted.map((r) => [r.rowNumber, r.reason])).toEqual([
      [5, 'not attempted — the run was limited to 1 products'],
      [9, 'not attempted — the run was limited to 1 products'],
    ]);
  });

  it('attempts exactly the selected rows, in row order, and reports the rest as not selected', () => {
    const choice = chooseRowsToAttempt(creatable, { skus: ['TW-012', 'SP-190-B'], sheetSkus });

    expect(rowNumbers(choice.attempt)).toEqual([3, 9]);
    expect(choice.notAttempted.map((r) => [r.rowNumber, r.reason])).toEqual([[5, 'not selected']]);
    expect(choice.missingFromSheet).toEqual([]);
  });

  it('matches a lowercase or padded SKU after normalisation', () => {
    const choice = chooseRowsToAttempt(creatable, { skus: ['  sp-190-b '], sheetSkus });

    expect(rowNumbers(choice.attempt)).toEqual([3]);
    expect(choice.missingFromSheet).toEqual([]);
  });

  it('reports a selected SKU that is not in the sheet at all', () => {
    const choice = chooseRowsToAttempt(creatable, { skus: ['SP-190-B', 'gone-1'], sheetSkus });

    expect(rowNumbers(choice.attempt)).toEqual([3]);
    expect(choice.missingFromSheet).toEqual(['gone-1']);
  });

  it('neither attempts nor reports missing a selected SKU whose row is invalid or not ready', () => {
    // RQ-001 is in the sheet but not creatable — its row already has a result.
    const choice = chooseRowsToAttempt(creatable, {
      skus: ['rq-001'],
      sheetSkus: [...sheetSkus, 'RQ-001'],
    });

    expect(choice.attempt).toEqual([]);
    expect(choice.missingFromSheet).toEqual([]);
  });

  it('applies a limit to the Selection, not to the whole sheet', () => {
    const choice = chooseRowsToAttempt(creatable, {
      skus: ['CA-738-A1', 'TW-012'],
      limit: 1,
      sheetSkus,
    });

    expect(rowNumbers(choice.attempt)).toEqual([5]);
    expect(choice.notAttempted.map((r) => [r.rowNumber, r.reason])).toEqual([
      [3, 'not selected'],
      [9, 'not attempted — the run was limited to 1 products'],
    ]);
  });

  it('attempts nothing for an empty Selection', () => {
    const choice = chooseRowsToAttempt(creatable, { skus: [], sheetSkus });

    expect(choice.attempt).toEqual([]);
    expect(choice.notAttempted.map((r) => r.reason)).toEqual([
      'not selected',
      'not selected',
      'not selected',
    ]);
  });
});

describe('the latest finished preview', () => {
  it('is nothing when there are no reports', () => {
    expect(latestFinishedPreview([])).toBeNull();
  });

  it('is the latest of several finished previews, whatever order they come in', () => {
    expect(
      latestFinishedPreview([
        { mode: 'preview', finishedAt: '2026-09-18T09:00:00.000Z' },
        { mode: 'preview', finishedAt: '2026-09-18T11:30:00.000Z' },
        { mode: 'preview', finishedAt: '2026-09-18T10:00:00.000Z' },
      ]),
    ).toBe('2026-09-18T11:30:00.000Z');
  });

  it('is nothing when every report is a commit', () => {
    expect(latestFinishedPreview([{ mode: 'commit', finishedAt: '2026-09-18T09:00:00.000Z' }])).toBeNull();
  });

  it('is not moved by a commit that finished after the preview', () => {
    expect(
      latestFinishedPreview([
        { mode: 'preview', finishedAt: '2026-09-18T09:00:00.000Z' },
        { mode: 'commit', finishedAt: '2026-09-18T12:00:00.000Z' },
      ]),
    ).toBe('2026-09-18T09:00:00.000Z');
  });

  it('ignores a preview that crashed or is still running', () => {
    expect(
      latestFinishedPreview([
        { mode: 'preview', finishedAt: '2026-09-18T09:00:00.000Z' },
        { mode: 'preview', finishedAt: null },
      ]),
    ).toBe('2026-09-18T09:00:00.000Z');
  });
});
