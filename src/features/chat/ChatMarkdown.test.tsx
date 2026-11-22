import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it,vi} from 'vitest';
import {ChatMarkdown} from './ChatMarkdown';

const noop=vi.fn();
const render=(text:string,documentFile='')=>renderToStaticMarkup(<ChatMarkdown
  text={text} documentFile={documentFile} onOpenExternal={noop} onOpenDocument={noop}/>);

describe('chat Markdown',()=>{
  it('renders typical structures while keeping code characters literal',()=>{
    const html=render([
      '## 标题', '', '> **标注 1｜原文与备注**', '', '3. 第一条', '   - 第二层',
      '', '行内 `**不是粗体**` 和 [链接](https://example.com/read).',
      '', '~~~md', '<literal> & **内容**', '', '[1]', '~~~',
    ].join('\n'));
    expect(html).toContain('<h2> 标题</h2>');
    expect(html).toMatch(/<blockquote>\s*<p><strong>标注 1｜原文与备注<\/strong><\/p><\/blockquote>/);
    expect(html).toContain('<ol start="3">');
    expect(html).toContain('<ul>');
    expect(html).toContain('<code>**不是粗体**</code>');
    expect(html).toContain('href="https://example.com/read"');
    expect(html).toContain('<pre><code>&lt;literal&gt; &amp; **内容**\n\n[1]</code></pre>');
  });
  it('renders unfinished fences as escaped literal text and recovers once a block is complete',()=>{
    expect(render('~~~md\n**literal**\n<img src=x>')).toContain('<code>**literal**\n&lt;img src=x&gt;</code>');
    expect(render('**未闭')).toContain('**未闭');
    expect(render('**未闭**')).toContain('<strong>未闭</strong>');
  });
  it('excludes HTML, images and unsafe link destinations from active elements',()=>{
    const html=render([
      '<img src=x onerror="test()">', '', '<script>test()</script>', '',
      '[script](java&#x73;cript:alert(1)) [system](file:///C:/tmp/a.md) [remote](//x.test/a.md)',
      '[credentials](https://name:password@x.test/) [api](/api/secret.md)',
      '![beacon](https://x.test/pixel.png) ![script](x "x")',
      '[safe](https://example.com/visible) [local](../chapter.md)',
    ].join('\n'),'folder/note.md');
    expect(html).not.toMatch(/<(img|script)/i);
    expect(html).not.toMatch(/href="(javascript:|file:|\/\/|\/api)/i);
    expect(html).toContain('beacon');
    expect(html).toContain('href="https://example.com/visible"');
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html.match(/chat-document-link/g)).toHaveLength(1);
    expect(render('[local](./chapter.md)')).not.toContain('chat-document-link');
  });
  it('renders reference links without exposing their definitions',()=>{
    const html=render('[源文][page]\n\n[page]: https://example.com/source');
    expect(html).toContain('href="https://example.com/source"');
    expect(html).not.toContain('[page]');
  });
});
