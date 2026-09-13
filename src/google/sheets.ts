/**
 * Reading the spreadsheet.
 */

import { sheets as sheetsApi } from '@googleapis/sheets';
import type { OAuth2Client } from 'google-auth-library';
import { toRows, type ColumnMap } from '../sheets/rows.js';
import type { SheetRow } from '../domain/types.js';

export interface SheetData {
  title: string;
  tab: string;
  header: string[];
  columns: ColumnMap;
  rows: SheetRow[];
}

export async function readSheet(
  auth: OAuth2Client,
  spreadsheetId: string,
  tab: string,
): Promise<SheetData> {
  const sheets = sheetsApi({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const tabs = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? '');
  const resolvedTab = tab && tabs.includes(tab) ? tab : tabs[0];

  if (!resolvedTab) throw new Error('the spreadsheet has no tabs');
  if (tab && !tabs.includes(tab)) {
    throw new Error(`tab "${tab}" not found. Available tabs: ${tabs.join(', ')}`);
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${resolvedTab}!A:ZZ`,
    valueRenderOption: 'FORMATTED_VALUE',
  });

  const values = (res.data.values ?? []) as string[][];
  const { columns, rows } = toRows(values);

  return {
    title: meta.data.properties?.title ?? '(untitled)',
    tab: resolvedTab,
    header: values[0] ?? [],
    columns,
    rows,
  };
}
