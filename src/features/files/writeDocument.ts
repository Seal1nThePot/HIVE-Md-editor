import type { ApiClient } from '../../shared/api';
import type { DiskFile } from '../../shared/fileTypes';

export type DocumentWrite = Pick<DiskFile, 'path' | 'text' | 'eol' | 'bom'> & {
  baseline: string | null;
};

export type DocumentWriteResult = {
  path: string;
  hash: string;
  warning?: string;
};

export function writeDocument(api: ApiClient, document: DocumentWrite) {
  return api<DocumentWriteResult>('/file', document);
}

export async function writeExternalDocument(document: DocumentWrite) {
  if (!window.hiveDesktop?.saveLocalMarkdown) throw new Error('请在 HIVE 桌面应用中保存仓库外文稿。');
  try {
    return await window.hiveDesktop.saveLocalMarkdown(document);
  } catch (error) {
    throw new Error(localDocumentError(error));
  }
}

export function localDocumentError(error: unknown) {
  return (error as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}
