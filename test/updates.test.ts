/**
 * Deciding whether to offer an update.
 *
 * These rules run on a machine nobody can see, and the two ways they can be
 * wrong are both bad: offering an update that cannot install, or staying silent
 * about one that can. So the awkward cases are pinned here rather than
 * discovered later.
 */

import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  decideUpdate,
  isNewer,
  normaliseVersion,
  parseChecksum,
  summariseNotes,
  tarballName,
  versionsToKeep,
  type Release,
} from '../src/domain/updates.js';

function release(overrides: Partial<Release> = {}): Release {
  const version = normaliseVersion(overrides.tag_name ?? 'v1.1.0');
  return {
    tag_name: `v${version}`,
    body: 'Fixed a thing.',
    html_url: `https://github.com/example/ezoko/releases/tag/v${version}`,
    assets: [
      {
        name: `ezoko-${version}.tgz`,
        browser_download_url: `https://example.test/ezoko-${version}.tgz`,
      },
      {
        name: `ezoko-${version}.tgz.sha256`,
        browser_download_url: `https://example.test/ezoko-${version}.tgz.sha256`,
      },
    ],
    ...overrides,
  };
}

describe('compareVersions', () => {
  it('orders by number, not by string', () => {
    // The bug this pins: "10" sorts before "9" as text, so a string comparison
    // would stop offering updates at 1.9.0 and never say why.
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
  });

  it('treats a missing part as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('2', '1.9.9')).toBe(1);
  });

  it('ignores a leading v', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('ignores a prerelease suffix', () => {
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBe(0);
  });
});

describe('isNewer', () => {
  it('is false for the same version, so a reinstall is never offered', () => {
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
  });

  it('is false for an older release, so a rollback is never offered as an update', () => {
    expect(isNewer('0.9.0', '1.0.0')).toBe(false);
  });

  it('is true only going forwards', () => {
    expect(isNewer('1.0.1', '1.0.0')).toBe(true);
  });
});

describe('decideUpdate', () => {
  it('offers a newer release with both files attached', () => {
    const decision = decideUpdate('1.0.0', release({ tag_name: 'v1.1.0' }));

    expect(decision.kind).toBe('available');
    if (decision.kind !== 'available') return;
    expect(decision.version).toBe('1.1.0');
    expect(decision.url).toBe('https://example.test/ezoko-1.1.0.tgz');
    expect(decision.checksumUrl).toBe('https://example.test/ezoko-1.1.0.tgz.sha256');
  });

  it('says nothing when already current', () => {
    expect(decideUpdate('1.1.0', release({ tag_name: 'v1.1.0' })).kind).toBe('up-to-date');
  });

  it('says nothing when the release is older than what is installed', () => {
    expect(decideUpdate('2.0.0', release({ tag_name: 'v1.1.0' })).kind).toBe('up-to-date');
  });

  it('says nothing when there is no release at all', () => {
    expect(decideUpdate('1.0.0', null).kind).toBe('up-to-date');
  });

  it('never offers a prerelease', () => {
    const decision = decideUpdate('1.0.0', release({ tag_name: 'v1.1.0', prerelease: true }));
    expect(decision.kind).toBe('up-to-date');
  });

  it('never offers a draft', () => {
    const decision = decideUpdate('1.0.0', release({ tag_name: 'v1.1.0', draft: true }));
    expect(decision.kind).toBe('up-to-date');
  });

  it('complains out loud when the tarball is missing rather than going quiet', () => {
    const decision = decideUpdate('1.0.0', release({ tag_name: 'v1.1.0', assets: [] }));

    expect(decision.kind).toBe('unusable');
    if (decision.kind !== 'unusable') return;
    expect(decision.reason).toContain('ezoko-1.1.0.tgz');
  });

  it('refuses a release with no checksum, because the download could not be verified', () => {
    const partial = release({ tag_name: 'v1.1.0' });
    const decision = decideUpdate('1.0.0', {
      ...partial,
      assets: partial.assets.filter((asset) => !asset.name.endsWith('.sha256')),
    });

    expect(decision.kind).toBe('unusable');
    if (decision.kind !== 'unusable') return;
    expect(decision.reason).toContain('sha256');
  });

  it('matches the tarball by exact name, not by extension', () => {
    // A release carrying the installer zip and the tarball must not pick the
    // wrong one just because it came first.
    const decision = decideUpdate('1.0.0', {
      ...release({ tag_name: 'v1.1.0' }),
      assets: [
        { name: 'Ezoko-1.1.0.zip', browser_download_url: 'https://example.test/Ezoko-1.1.0.zip' },
        { name: 'ezoko-1.1.0.tgz', browser_download_url: 'https://example.test/right.tgz' },
        {
          name: 'ezoko-1.1.0.tgz.sha256',
          browser_download_url: 'https://example.test/right.tgz.sha256',
        },
      ],
    });

    expect(decision.kind).toBe('available');
    if (decision.kind !== 'available') return;
    expect(decision.url).toBe('https://example.test/right.tgz');
  });
});

describe('parseChecksum', () => {
  it('reads a shasum-style line', () => {
    const hex = 'a'.repeat(64);
    expect(parseChecksum(`${hex}  ezoko-1.1.0.tgz\n`)).toBe(hex);
  });

  it('lowercases, so a comparison never fails on case alone', () => {
    expect(parseChecksum('A'.repeat(64))).toBe('a'.repeat(64));
  });

  it('refuses anything that is not a hash — an error page, say', () => {
    expect(parseChecksum('<!DOCTYPE html><html>Not Found</html>')).toBeNull();
    expect(parseChecksum('')).toBeNull();
    expect(parseChecksum('abc123  ezoko.tgz')).toBeNull();
  });
});

describe('summariseNotes', () => {
  it('leaves short notes alone', () => {
    expect(summariseNotes('Fixed the sheet write-back.')).toBe('Fixed the sheet write-back.');
  });

  it('trims long notes at a word boundary', () => {
    const summary = summariseNotes('word '.repeat(200), 50);
    expect(summary.length).toBeLessThanOrEqual(51);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary).not.toContain('wor…');
  });

  it('copes with no notes at all', () => {
    expect(summariseNotes(null)).toBe('');
    expect(summariseNotes(undefined)).toBe('');
  });
});

describe('tarballName', () => {
  it('matches what the build publishes', () => {
    expect(tarballName('v1.2.3')).toBe('ezoko-1.2.3.tgz');
  });
});

describe('versionsToKeep', () => {
  it('keeps the newest few', () => {
    expect(versionsToKeep(['1.0.0', '1.1.0', '1.2.0', '1.3.0'], '1.3.0')).toEqual([
      '1.3.0',
      '1.2.0',
      '1.1.0',
    ]);
  });

  it('never drops the running version, however old it is', () => {
    // After a rollback the running version is not the newest on disk, and
    // deleting it would remove the only thing that works.
    expect(versionsToKeep(['1.0.0', '1.1.0', '1.2.0', '1.3.0'], '1.0.0')).toContain('1.0.0');
  });

  it('sorts numerically here too', () => {
    expect(versionsToKeep(['1.9.0', '1.10.0', '1.8.0'], '1.10.0')[0]).toBe('1.10.0');
  });

  it('keeps everything when there is little to keep', () => {
    expect(versionsToKeep(['1.0.0'], '1.0.0')).toEqual(['1.0.0']);
  });
});
