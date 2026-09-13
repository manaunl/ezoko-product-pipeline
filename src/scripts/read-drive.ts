/**
 * Step 2: prove we can read the photo folder, and see the real filenames.
 *
 * Prints every file in the configured folder plus any subfolders, exactly as
 * Drive names them. No parsing — the filenames are the thing we most need to
 * look at before writing anything that depends on their shape.
 *
 *   npx tsx src/scripts/read-drive.ts
 */

import '../bootstrap.js';

import { drive as driveApi, type drive_v3 } from '@googleapis/drive';
import { loadAuth } from '../google/auth.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function listChildren(
  drive: drive_v3.Drive,
  folderId: string,
): Promise<drive_v3.Schema$File[]> {
  const files: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      pageSize: 1000,
      orderBy: 'name',
      pageToken,
    });
    files.push(...(res.data.files ?? []));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

function humanSize(bytes: string | null | undefined): string {
  if (!bytes) return '';
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function report(drive: drive_v3.Drive, folderId: string, label: string): Promise<void> {
  const children = await listChildren(drive, folderId);
  const folders = children.filter((f) => f.mimeType === FOLDER_MIME);
  const files = children.filter((f) => f.mimeType !== FOLDER_MIME);

  console.log(`\n${label}`);
  console.log(`  ${files.length} files, ${folders.length} subfolders\n`);

  for (const file of files) {
    const type = (file.mimeType ?? '').replace(/^image\//, '');
    console.log(
      `    ${(file.name ?? '').padEnd(38)} ${type.padEnd(12)} ${humanSize(file.size)}`,
    );
  }

  for (const folder of folders) {
    await report(drive, folder.id!, `  └─ subfolder: ${folder.name}`);
  }
}

async function main(): Promise<void> {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID is not set in .env');

  const drive = driveApi({ version: 'v3', auth: await loadAuth() });

  const meta = await drive.files.get({ fileId: folderId, fields: 'id, name, mimeType' });
  if (meta.data.mimeType !== FOLDER_MIME) {
    throw new Error(`GOOGLE_DRIVE_FOLDER_ID points at "${meta.data.name}", which is not a folder`);
  }

  await report(drive, folderId, `Folder: ${meta.data.name}`);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
