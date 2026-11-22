import {parseExternalHttpLink} from '../../shared/externalUrl.mjs';

export {parseExternalHttpLink};

export async function openExternalHttpLink(target: string): Promise<boolean> {
  const url = parseExternalHttpLink(target);
  if (!url) return false;
  try {
    if (window.hiveDesktop?.isDesktop) return await window.hiveDesktop.openExternalHttpLink?.(url) ?? false;
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  } catch {
    return false;
  }
}
