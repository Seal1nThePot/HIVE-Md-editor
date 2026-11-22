import {parseExternalHttpLink} from '../shared/externalUrl.mjs';

export function createExternalHttpLinkHandler({isMainFrame, shell}) {
  return async (event, target) => {
    if (!isMainFrame(event)) return false;
    const url = parseExternalHttpLink(target);
    if (!url) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  };
}
