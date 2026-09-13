import { describe, expect, it } from 'vitest';
import { claimedSku, indexPhotos, normaliseSku, parsePhotoName } from '../src/domain/filenames.js';
import type { DriveFile } from '../src/domain/types.js';

const file = (name: string, mimeType = 'image/jpeg'): DriveFile => ({
  id: name,
  name,
  mimeType,
  size: 1000,
  folder: 'Spheres',
});

const parsed = (name: string) => {
  const result = parsePhotoName(name);
  if (!result.ok) throw new Error(`expected "${name}" to parse, got: ${result.reason}`);
  return result.parsed;
};

describe('the SKU is matched exactly, not by prefix', () => {
  it('splits on the last underscore', () => {
    // Real filenames from the Drive folder.
    expect(parsed('SP-190-B_01.jpg')).toEqual({ sku: 'SP-190-B', index: 1 });
    expect(parsed('CA-738-A1_01.jpg')).toEqual({ sku: 'CA-738-A1', index: 1 });
  });

  it('does not let one SKU steal another SKU\'s photos', () => {
    // This is the whole reason for splitting on the delimiter. A prefix match
    // would put CA-738-A11's photos on CA-738-A1.
    expect(parsed('CA-738-A1_01.jpg').sku).toBe('CA-738-A1');
    expect(parsed('CA-738-A11_01.jpg').sku).toBe('CA-738-A11');
  });

  it('survives a SKU that itself contains underscores', () => {
    expect(parsed('CA_738_A1_02.jpg')).toEqual({ sku: 'CA_738_A1', index: 2 });
  });
});

describe('what gets normalised silently', () => {
  it('ignores case and stray whitespace, on both sides of the join', () => {
    expect(parsed('sp-190-b_01.JPG').sku).toBe('SP-190-B');
    expect(normaliseSku('  sp-190-b ')).toBe('SP-190-B');
  });
});

describe('what gets refused', () => {
  const rejects = (name: string, expected: string) => {
    const result = parsePhotoName(name);
    expect(result.ok, `expected "${name}" to be refused`).toBe(false);
    if (!result.ok) expect(result.reason).toContain(expected);
  };

  it('refuses a file with no sequence number', () => {
    rejects('SP-190-B.jpg', 'missing the _NN number');
  });

  it('refuses a macOS or Drive duplicate copy', () => {
    rejects('SP-190-B_01 (1).jpg', 'not a plain number');
  });

  it('refuses extra tokens after the number', () => {
    rejects('SP-190-B_01_final.jpg', 'not a plain number');
  });

  it('explains what to do about HEIC instead of just failing', () => {
    rejects('SP-190-B_01.HEIC', 'export it as JPEG');
  });
});

describe('ordering', () => {
  it('sorts numerically, so _10 does not come before _2', () => {
    const { bySku } = indexPhotos([
      file('SP-190-B_10.jpg'),
      file('SP-190-B_2.jpg'),
      file('SP-190-B_1.jpg'),
    ]);
    expect(bySku.get('SP-190-B')?.map((p) => p.index)).toEqual([1, 2, 10]);
  });

  it('treats _1 and _01 as the same position', () => {
    const { bySku, rejected } = indexPhotos([file('SP-190-B_1.jpg'), file('SP-190-B_01.jpg')]);
    // Same position claimed twice — ambiguous, so both are refused rather than
    // one being picked arbitrarily as the featured image.
    expect(bySku.size).toBe(0);
    expect(rejected).toHaveLength(2);
    expect(rejected[0]!.reason).toContain('duplicate number');
  });
});

describe('folder noise', () => {
  it('ignores dotfiles and Google-native files without reporting them', () => {
    const { rejected } = indexPhotos([
      file('.DS_Store', 'application/octet-stream'),
      file('Notes', 'application/vnd.google-apps.document'),
    ]);
    expect(rejected).toHaveLength(0);
  });
});

describe('claimedSku — deciding whether a bad filename is worth reporting', () => {
  it('reads the SKU from a well-formed name', () => {
    expect(claimedSku('SP-190-B_01.jpg')).toBe('SP-190-B');
  });

  it('reads it from the malformed names the real folder is full of', () => {
    // 533 files end in a bare underscore, 96 have no number at all.
    expect(claimedSku('SMF-026_.jpg')).toBe('SMF-026');
    expect(claimedSku('CA-738-A1.jpg')).toBe('CA-738-A1');
    expect(claimedSku('TO-011_02.HEIC')).toBe('TO-011');
    expect(claimedSku('MA-007-A_03.mp4')).toBe('MA-007-A');
  });

  it('normalises the same way the join does, so scoping cannot drift', () => {
    expect(claimedSku('  sp-190-b_01.jpg  ')).toBe('SP-190-B');
  });

  it('splits on the last underscore, so a SKU containing one survives', () => {
    expect(claimedSku('SP_190_B_01.jpg')).toBe('SP_190_B');
  });

  it('returns an empty string for a name with nothing to claim', () => {
    expect(claimedSku('')).toBe('');
    expect(claimedSku('_01.jpg')).toBe('_01');
  });
});
