/**
 * Does Google still answer, on every call shape we use?
 *
 *   npx tsx src/scripts/check-google.ts
 *
 * Reads only — writes nothing anywhere. It exists because a preview run never
 * downloads a photo, so swapping the Google client libraries can leave the
 * download path broken in a way nothing notices until a commit run is halfway
 * through creating products.
 */

import '../bootstrap.js';

import { loadAuth } from '../google/auth.js';
import { downloadFile } from '../google/download.js';
import { listPhotoFiles } from '../google/drive.js';
import { readSheet } from '../google/sheets.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — fill it in on the setup page`);
  return value;
}

async function main(): Promise<void> {
  const auth = await loadAuth();
  console.log('auth      OAuth2 client built and token loaded');

  const sheet = await readSheet(auth, required('GOOGLE_SHEET_ID'), process.env.GOOGLE_SHEET_TAB ?? '');
  console.log(`sheets    ${sheet.rows.length} rows from "${sheet.tab}"`);

  const started = Date.now();
  const files = await listPhotoFiles(auth, required('GOOGLE_DRIVE_FOLDER_ID'));
  console.log(`drive     ${files.length} files in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const photo = files.find((file) => file.mimeType?.startsWith('image/'));
  if (!photo) throw new Error('no image found in the photo folder, so the download is untested');

  const bytes = await downloadFile(auth, photo.id);
  console.log(`download  ${photo.name} — ${(bytes.length / 1024).toFixed(0)} KB`);

  // A truncated or error-page response would still be a Buffer, so check it is
  // actually a JPEG or PNG rather than trusting the byte count.
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  if (!jpeg && !png) throw new Error(`downloaded bytes are not an image: ${bytes.subarray(0, 8).toString('hex')}`);
  console.log(`          valid ${jpeg ? 'JPEG' : 'PNG'} header — the bytes are real\n`);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
