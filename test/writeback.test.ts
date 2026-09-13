import { describe, expect, it } from 'vitest';
import { decideWrite } from '../src/sheets/writeback.js';

describe('a record that the product is in Shopify is never overwritten', () => {
  it('keeps CREATED when a later run finds the row not ready', () => {
    // The real case: the product was created, then its photos were moved out of
    // the Drive folder. Without this the sheet would forget it exists.
    expect(decideWrite('CREATED', 'skipped')).toBe('preserve');
    expect(decideWrite('CREATED', 'invalid')).toBe('preserve');
    expect(decideWrite('CREATED', 'failed')).toBe('preserve');
  });

  it('keeps PARTIAL and EXISTS the same way', () => {
    expect(decideWrite('PARTIAL', 'skipped')).toBe('preserve');
    expect(decideWrite('EXISTS', 'skipped')).toBe('preserve');
  });

  it('allows one in-Shopify status to replace another', () => {
    // PARTIAL -> CREATED is a repair, and must be recorded.
    expect(decideWrite('PARTIAL', 'created')).toBe('write');
    expect(decideWrite('EXISTS', 'created')).toBe('write');
  });

  it('ignores case and whitespace, since a human may have typed the cell', () => {
    expect(decideWrite('  created ', 'skipped')).toBe('preserve');
  });
});

describe('unfinished rows are left blank', () => {
  it('writes nothing for a row that is merely not ready', () => {
    // 128 of the 144 real rows. A column that says something on every row says
    // nothing, and teaches people to skip past it.
    expect(decideWrite('', 'skipped')).toBe('ignore');
    expect(decideWrite('', 'would-create')).toBe('ignore');
  });

  it('clears a stale note once the row is no longer a problem', () => {
    // A row flagged NEEDS FIXING for a bad price, where the price has since
    // been replaced with "?" — the row is now simply unfinished, and the old
    // note would otherwise stay there misleading everyone.
    expect(decideWrite('NEEDS FIXING', 'skipped')).toBe('clear');
    expect(decideWrite('FAILED', 'skipped')).toBe('clear');
  });
});

describe('rows that need attention are always written', () => {
  it('writes over anything non-terminal', () => {
    for (const existing of ['', 'NOT READY', 'NEEDS FIXING', 'FAILED']) {
      expect(decideWrite(existing, 'created'), existing).toBe('write');
      expect(decideWrite(existing, 'invalid'), existing).toBe('write');
      expect(decideWrite(existing, 'failed'), existing).toBe('write');
    }
  });
});
