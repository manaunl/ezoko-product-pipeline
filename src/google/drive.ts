/**
 * Reading the photo folder.
 *
 * Photos are organised into subfolders by product type (Photos/Spheres/...),
 * so the scan is recursive. The folder a file came from is kept only for
 * reporting — SKUs are matched from the filename, so the folder structure can
 * change without breaking anything.
 *
 * ## Why this is breadth-first and batched
 *
 * The owner's real folder is 13,049 files in 266 subfolders. Walking it one folder
 * at a time cost 267 sequential round trips and **104 seconds** — and it was
 * blamed on his laptop, which was wrong: the whole run spends about three
 * seconds on CPU. It was 267 waits.
 *
 * Drive has no "list a whole subtree" call, but one query can name several
 * parents at once — `('a' in parents or 'b' in parents ...)` — and the levels of
 * the tree can be fetched concurrently. Same 13,049 files, 37 requests,
 * **8.7 seconds**. Measured against the real folder, not estimated.
 *
 * Nothing is cached between runs. 8.7 seconds does not justify a staleness bug
 * that only shows up on somebody else's machine.
 */

import { drive as driveApi, type drive_v3 } from '@googleapis/drive';
import type { OAuth2Client } from 'google-auth-library';
import type { DriveFile } from '../domain/types.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * Parents per query. Drive limits query length rather than clause count, and 25
 * ids is a comfortable ~1.2 KB — well clear of the limit, while cutting the
 * request count by the factor that matters.
 */
const PARENTS_PER_QUERY = 25;

/** Drive's maximum, and the right value: the folders average 49 files each. */
const PAGE_SIZE = 1000;

interface Listing {
  files: drive_v3.Schema$File[];
}

/**
 * Lists the direct children of up to `PARENTS_PER_QUERY` folders in one query.
 *
 * `parents` is requested so each file can still be attributed to the folder it
 * came from — the one thing the per-folder walk gave us for free.
 */
async function listChildrenOf(
  drive: drive_v3.Drive,
  folderIds: string[],
): Promise<Listing> {
  const q = `(${folderIds.map((id) => `'${id}' in parents`).join(' or ')}) and trashed = false`;
  const files: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q,
      fields: 'nextPageToken, files(id, name, mimeType, size, parents)',
      pageSize: PAGE_SIZE,
      orderBy: 'name',
      pageToken,
    });
    files.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { files };
}

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let at = 0; at < items.length; at += size) groups.push(items.slice(at, at + size));
  return groups;
}

export async function listPhotoFiles(
  auth: OAuth2Client,
  folderId: string,
): Promise<DriveFile[]> {
  const drive = driveApi({ version: 'v3', auth });
  const collected: DriveFile[] = [];

  // Folder id -> path from the root, built up as each level is discovered. The
  // root itself is '' so top-level files report no folder, as before.
  const pathOf = new Map<string, string>([[folderId, '']]);

  // Guards against a folder reachable by two routes, which Drive permits.
  // Without it, a shortcut loop would walk forever.
  const visited = new Set<string>([folderId]);

  let frontier = [folderId];

  while (frontier.length > 0) {
    const listings = await Promise.all(
      chunk(frontier, PARENTS_PER_QUERY).map((group) => listChildrenOf(drive, group)),
    );

    const next: string[] = [];

    for (const listing of listings) {
      for (const child of listing.files) {
        const id = child.id;
        if (!id) continue;

        // A file can have several parents; the one we walked in from is the one
        // whose path we know.
        const parent = (child.parents ?? []).find((p) => pathOf.has(p));
        const parentPath = parent === undefined ? '' : (pathOf.get(parent) ?? '');
        const name = child.name ?? '';

        if (child.mimeType === FOLDER_MIME) {
          if (visited.has(id)) continue;
          visited.add(id);
          pathOf.set(id, parentPath ? `${parentPath}/${name}` : name);
          next.push(id);
          continue;
        }

        collected.push({
          id,
          name,
          mimeType: child.mimeType ?? '',
          size: child.size == null ? null : Number(child.size),
          folder: parentPath,
        });
      }
    }

    frontier = next;
  }

  return collected;
}
