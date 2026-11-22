import {describe, expect, it, vi} from 'vitest';
import {createExternalHttpLinkHandler} from './externalLinks.mjs';
import {parseExternalHttpLink} from '../shared/externalUrl.mjs';

describe('opening external HTTP links', () => {
  it.each([
    '', '//example.test', 'https:///example.test', 'https://', 'https://x:bad',
    'file:///x', 'javascript:alert(1)', 'mailto:a@b.test', 'data:text/plain,x',
    'ms-settings:display', 'https://trusted.test@other.test/',
    'https://exa mple.test', 'https://example.test/\nnext', 'https://example.test\\next',
    null, 123,
  ])('rejects an unsafe or malformed address %s', target => {
    expect(parseExternalHttpLink(target)).toBeNull();
  });

  it('checks the main frame and only passes validated HTTP addresses to the OS', async () => {
    const accepted = {};
    const shell = {openExternal: vi.fn().mockResolvedValue(undefined)};
    const open = createExternalHttpLinkHandler({isMainFrame: event => event === accepted, shell});
    expect(await open({}, 'http://example.test/one')).toBe(false);
    expect(await open(accepted, 'file:///example.md')).toBe(false);
    expect(await open(accepted, 'http://example.test/one')).toBe(true);
    expect(await open(accepted, 'https://example.test/two?q=汉字#note')).toBe(true);
    expect(shell.openExternal.mock.calls).toEqual([
      ['http://example.test/one'],
      ['https://example.test/two?q=%E6%B1%89%E5%AD%97#note'],
    ]);
    shell.openExternal.mockRejectedValueOnce(new Error());
    expect(await open(accepted, 'https://example.test/')).toBe(false);
  });
});
