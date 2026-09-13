/**
 * Deciding whether to offer an update.
 *
 * Pure: no network, no disk. Everything that could get a version comparison
 * wrong lives here, where it can be tested, rather than tangled up with
 * downloading.
 *
 * The bias throughout is towards saying nothing. A banner that appears when it
 * shouldn't teaches the operator to ignore banners, and the one that matters is
 * the one that says his version stops working in three weeks.
 */

/** What GitHub's releases API gives us, reduced to the parts we use. */
export interface Release {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  assets: { name: string; browser_download_url: string; size?: number }[];
}

export interface AvailableUpdate {
  kind: 'available';
  version: string;
  notes: string;
  /** The tarball to download. */
  url: string;
  /** The file holding its sha256, published beside the tarball. */
  checksumUrl: string;
  releaseUrl: string;
}

export type UpdateDecision =
  | { kind: 'up-to-date'; version: string }
  | AvailableUpdate
  /**
   * A newer release exists but cannot be installed. Said out loud rather than
   * swallowed: silence here looks identical to "you are up to date", and the
   * person who needs to know is whoever published the broken release.
   */
  | { kind: 'unusable'; version: string; reason: string };

/** `v1.2.3` and `1.2.3` are the same tag. */
export function normaliseVersion(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

/**
 * Compares two dotted numeric versions. Negative when `a` is older.
 *
 * Anything after a `-` is ignored, so `1.2.0-beta.1` compares equal to `1.2.0`.
 * Combined with skipping prereleases entirely, that means a prerelease tag can
 * never be offered as an upgrade over the matching final release.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (raw: string) =>
    normaliseVersion(raw)
      .split('-')[0]!
      .split('.')
      .map((piece) => Number.parseInt(piece, 10) || 0);

  const left = parts(a);
  const right = parts(b);

  for (let at = 0; at < Math.max(left.length, right.length); at += 1) {
    const difference = (left[at] ?? 0) - (right[at] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/** The tarball this build publishes, named from the version it holds. */
export function tarballName(version: string): string {
  return `ezoko-${normaliseVersion(version)}.tgz`;
}

/**
 * Trims release notes down to something that fits in a banner.
 *
 * Markdown is left as written — the page shows it as plain text. Nobody is
 * going to read a changelog in a strip across the top of a page, so it is
 * enough to hint at what changed and let the release page carry the rest.
 */
export function summariseNotes(body: string | null | undefined, limit = 400): string {
  const text = (body ?? '').replace(/\r\n/g, '\n').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).replace(/\s+\S*$/, '')}…`;
}

export function decideUpdate(currentVersion: string, release: Release | null): UpdateDecision {
  const current = normaliseVersion(currentVersion);
  if (!release) return { kind: 'up-to-date', version: current };

  // Drafts are invisible to an unauthenticated read anyway; prereleases are
  // published deliberately and must still never be offered to the operator.
  if (release.draft || release.prerelease) return { kind: 'up-to-date', version: current };

  const version = normaliseVersion(release.tag_name ?? '');
  if (version === '' || !isNewer(version, current)) return { kind: 'up-to-date', version: current };

  const wanted = tarballName(version);
  const tarball = release.assets.find((asset) => asset.name === wanted);
  const checksum = release.assets.find((asset) => asset.name === `${wanted}.sha256`);

  if (!tarball) {
    return {
      kind: 'unusable',
      version,
      reason: `release ${version} has no ${wanted} attached to it`,
    };
  }
  if (!checksum) {
    return {
      kind: 'unusable',
      version,
      reason: `release ${version} has no ${wanted}.sha256 attached to it, so the download cannot be verified`,
    };
  }

  return {
    kind: 'available',
    version,
    notes: summariseNotes(release.body),
    url: tarball.browser_download_url,
    checksumUrl: checksum.browser_download_url,
    releaseUrl: release.html_url ?? '',
  };
}

/**
 * Reads the checksum out of a `shasum`-style file: `<hex>  <filename>`.
 *
 * Returns null rather than throwing, so a mangled or HTML-error-page response
 * is refused by the caller in the same breath as a mismatch.
 */
export function parseChecksum(contents: string): string | null {
  const match = contents.trim().match(/^([0-9a-f]{64})\b/i);
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * Versions to keep on disk, newest first, given everything present.
 *
 * The running one and the one before it are the rollback path, so they are
 * never candidates for removal. Three is enough to step back twice and few
 * enough that a laptop does not fill up with 20MB copies.
 */
export function versionsToKeep(all: string[], running: string, keep = 3): string[] {
  const sorted = [...new Set([...all, running])].sort((a, b) => compareVersions(b, a));
  const kept = new Set(sorted.slice(0, keep));
  kept.add(normaliseVersion(running));
  return sorted.filter((version) => kept.has(version));
}
