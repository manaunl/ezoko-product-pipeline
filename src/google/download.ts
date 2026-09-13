/**
 * Fetching photo bytes out of Drive.
 *
 * The bytes pass through this process on their way to Shopify's staged upload
 * target. The alternative — handing Shopify a public Drive link and letting it
 * fetch — means every photo must be world-readable and depends on Drive's
 * download endpoint behaving for a machine, which it frequently does not.
 */

import { drive as driveApi } from '@googleapis/drive';
import type { OAuth2Client } from 'google-auth-library';

export async function downloadFile(auth: OAuth2Client, fileId: string): Promise<Buffer> {
  const drive = driveApi({ version: 'v3', auth });

  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' },
  );

  return Buffer.from(response.data as ArrayBuffer);
}
