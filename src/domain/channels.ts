/**
 * Deciding what a run does with the store's sales channels.
 *
 * Pure: no network. The I/O boundary (`src/shopify/products.ts`) asks Shopify
 * for the store's publications and either gets a list back or an error; what
 * that error *means* — a missing scope the owner can fix in a dashboard, or
 * something else nobody can act on the same way — is decided here, where it
 * can be tested without a store to point at.
 *
 * Verified against the live dev store: querying `publications` without the
 * scope returns exactly "Access denied for publications field. Required
 * access: `read_publications` access scope."
 */

/** One of the store's sales channels, discovered fresh every run. */
export interface Channel {
  /** The Publication id — what `publishablePublish` is called with. */
  id: string;
  name: string;
}

export const REQUIRED_PUBLICATION_SCOPES = ['read_publications', 'write_publications'] as const;

/**
 * What to tell the owner when the run cannot even ask which channels exist.
 * Shared with the setup page's connection test, so the instructions read the
 * same wherever they show up.
 */
export const PUBLICATIONS_SETUP_MESSAGE =
  'This needs two more permissions on the Shopify app: read_publications and ' +
  'write_publications. Add them to the app\'s access scopes at ' +
  'dev.shopify.com/dashboard, then release that app version — skipping the ' +
  'release is the most common mistake.';

/** What asking Shopify for the store's publications actually returned. */
export type ChannelsProbe =
  | { kind: 'ok'; channels: Channel[] }
  | { kind: 'missing-scope' }
  | { kind: 'error'; message: string };

/**
 * Turns whatever `listPublications` threw into a `ChannelsProbe`.
 *
 * A missing-scope failure and every other kind of failure need different
 * advice — one is fixed by a checkbox in a dashboard, the other isn't — so
 * they are told apart here rather than left as one generic "could not reach
 * Shopify" message.
 */
export function classifyChannelsError(error: unknown): ChannelsProbe {
  const message = error instanceof Error ? error.message : String(error);
  if (/required access:\s*`?read_publications`?/i.test(message)) {
    return { kind: 'missing-scope' };
  }
  return { kind: 'error', message };
}

export type ChannelsDecision =
  | { proceed: true; channels: Channel[]; message: string }
  | { proceed: false; message: string };

/**
 * Whether the run proceeds, and what a preview or commit says about it.
 *
 * An empty channel list is a store fact, not a failure — some stores may
 * genuinely have none installed yet, and the run still creates products, just
 * without anything to make them available to.
 */
export function decideChannels(probe: ChannelsProbe): ChannelsDecision {
  if (probe.kind === 'missing-scope') {
    return { proceed: false, message: PUBLICATIONS_SETUP_MESSAGE };
  }
  if (probe.kind === 'error') {
    return {
      proceed: false,
      message: `Could not read the store's sales channels: ${probe.message}`,
    };
  }

  const names = probe.channels.map((channel) => channel.name);
  const message =
    names.length === 0
      ? "This store has no sales channels yet, so products will be created without any."
      : `All products will be made available to: ${names.join(', ')} (${names.length} channel${
          names.length === 1 ? '' : 's'
        })`;

  return { proceed: true, channels: probe.channels, message };
}

/**
 * The prefix on a per-product warning naming the channels it missed. Shared
 * between building that warning and recognising it later in the report, so a
 * run never mutates a second data structure just to count something it
 * already wrote into `warnings`.
 */
const CHANNEL_MISS_PREFIX = 'not made available to: ';

/**
 * The warning for one product, given the channels the run tried and which of
 * them it could not reach — or `null` when every channel succeeded, so
 * nothing is added to `warnings` for a product that needed no attention.
 */
export function describeChannelMiss(missedChannelNames: string[]): string | null {
  if (missedChannelNames.length === 0) return null;
  return `${CHANNEL_MISS_PREFIX}${missedChannelNames.join(', ')}`;
}

/** Whether a product's warnings say it missed at least one channel. */
export function reachedAllChannels(warnings: string[] | undefined): boolean {
  return !(warnings ?? []).some((warning) => warning.startsWith(CHANNEL_MISS_PREFIX));
}
