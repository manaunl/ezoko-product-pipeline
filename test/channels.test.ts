import { describe, expect, it } from 'vitest';
import {
  classifyChannelsError,
  decideChannels,
  describeChannelMiss,
  reachedAllChannels,
  type Channel,
} from '../src/domain/channels.js';

const channels: Channel[] = [
  { id: 'gid://shopify/Publication/1', name: 'Online Store' },
  { id: 'gid://shopify/Publication/2', name: 'Shop' },
];

describe('classifyChannelsError', () => {
  it('recognises the exact message the live store returns for a missing scope', () => {
    // Verified against the dev store: this is the real text, byte for byte.
    const error = new Error(
      'Access denied for publications field. Required access: `read_publications` access scope.',
    );
    expect(classifyChannelsError(error)).toEqual({ kind: 'missing-scope' });
  });

  it('treats every other failure as unrelated to permissions', () => {
    const error = new Error('fetch failed');
    expect(classifyChannelsError(error)).toEqual({ kind: 'error', message: 'fetch failed' });
  });

  it('does not mistake a message that merely mentions scopes for a missing one', () => {
    const error = new Error('Shopify returned HTTP 500');
    expect(classifyChannelsError(error)).toEqual({ kind: 'error', message: 'Shopify returned HTTP 500' });
  });

  it('handles a thrown value that is not an Error', () => {
    expect(classifyChannelsError('boom')).toEqual({ kind: 'error', message: 'boom' });
  });
});

describe('decideChannels', () => {
  it('lets the run proceed and names every channel it found', () => {
    const decision = decideChannels({ kind: 'ok', channels });
    expect(decision.proceed).toBe(true);
    expect(decision).toMatchObject({ channels });
    expect(decision.message).toContain('Online Store');
    expect(decision.message).toContain('Shop');
    expect(decision.message).toContain('2 channels');
  });

  it('uses the singular for exactly one channel', () => {
    const decision = decideChannels({ kind: 'ok', channels: [channels[0]!] });
    expect(decision.message).toContain('1 channel)');
    expect(decision.message).not.toContain('1 channels');
  });

  it('is not an error when the store has no sales channels at all', () => {
    const decision = decideChannels({ kind: 'ok', channels: [] });
    expect(decision.proceed).toBe(true);
    expect(decision.message).not.toMatch(/error|fail/i);
  });

  it('stops the run and names both scopes and the release step when the scope is missing', () => {
    const decision = decideChannels({ kind: 'missing-scope' });
    expect(decision.proceed).toBe(false);
    expect(decision.message).toContain('read_publications');
    expect(decision.message).toContain('write_publications');
    expect(decision.message).toMatch(/release/i);
  });

  it('stops the run for an unrelated failure too, but without the scope instructions', () => {
    const decision = decideChannels({ kind: 'error', message: 'network timeout' });
    expect(decision.proceed).toBe(false);
    expect(decision.message).toContain('network timeout');
    expect(decision.message).not.toContain('read_publications');
  });
});

describe('describeChannelMiss', () => {
  it('is silent when every channel succeeded', () => {
    expect(describeChannelMiss([])).toBeNull();
  });

  it('names exactly the channels that were missed', () => {
    expect(describeChannelMiss(['TikTok'])).toBe('not made available to: TikTok');
    expect(describeChannelMiss(['TikTok', 'Meta'])).toBe('not made available to: TikTok, Meta');
  });
});

describe('reachedAllChannels', () => {
  it('is true with no warnings at all', () => {
    expect(reachedAllChannels(undefined)).toBe(true);
    expect(reachedAllChannels([])).toBe(true);
  });

  it('is true when the warnings are about something else entirely', () => {
    expect(reachedAllChannels(['an untranslated stone name'])).toBe(true);
  });

  it('is false once a channel-miss warning is present', () => {
    expect(reachedAllChannels(['not made available to: TikTok'])).toBe(false);
  });
});
