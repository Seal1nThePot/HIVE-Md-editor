import { createElement, Fragment, memo, type ReactNode } from 'react';
import type { SyntaxNode } from '@lezer/common';
import { GFM, parser } from '@lezer/markdown';
import { parseExternalHttpLink } from '../../shared/externalLinks';

const markdownParser = parser.configure(GFM);
const inlineTags = new Map([
  ['StrongEmphasis', 'strong'],
  ['Emphasis', 'em'],
  ['Strikethrough', 'del'],
]);
const blockTags = new Map([
  ['Paragraph', 'p'],
  ['Blockquote', 'blockquote'],
  ['BulletList', 'ul'],
  ['OrderedList', 'ol'],
  ['ListItem', 'li'],
  ['Task', 'p'],
]);
const entityValues: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
};

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] !== '#') return Object.hasOwn(entityValues, name) ? entityValues[name] : entity;
    const hex = name[1].toLowerCase() === 'x';
    const value = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return value > 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff)
      ? String.fromCodePoint(value)
      : '\uFFFD';
  });
}

function decodeDestination(value: string) {
  return decodeEntities(value.replace(/^<|>$/g, '').replace(/\\([!-/:-@\[-`{-~])/g, '$1'));
}

function chatDocumentLink(value: string) {
  const raw = decodeDestination(value);
  if (/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(raw) || /[\u0000-\u001f\u007f]/u.test(raw)) return;
  try {
    const path = decodeURIComponent(raw.split('#')[0]);
    if (!/\.md$/i.test(path) || /^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(path) || /[\\?\u0000-\u001f\u007f]/u.test(path)) return;
    return raw;
  } catch {
    // Invalid repository paths are displayed as text.
  }
}

type Props = {
  text: string;
  onOpenExternal?: (target: string) => void;
  documentFile?: string;
  onOpenDocument?: (file: string, target: string) => void;
};

export const ChatMarkdown = memo(function ChatMarkdown({ text, onOpenExternal, documentFile, onOpenDocument }: Props) {
  const tree = markdownParser.parse(text);
  const references = new Map<string, string>();
  const referenceKey = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();
  tree.iterate({
    enter(node) {
      if (node.name !== 'LinkReference') return;
      const label = node.node.getChild('LinkLabel'), url = node.node.getChild('URL');
      if (!label || !url) return;
      const key = referenceKey(text.slice(label.from + 1, label.to - 1));
      if (!references.has(key)) references.set(key, text.slice(url.from, url.to));
    },
  });

  function children(node: SyntaxNode, depth: number, start = node.from, end = node.to, inLink = false): ReactNode[] {
    const parts: ReactNode[] = [];
    let position = start;
    for (let child = node.firstChild; child && child.from < end; child = child.nextSibling) {
      if (child.from < start || child.to > end) continue;
      if (child.from > position) parts.push(text.slice(position, child.from));
      parts.push(<Fragment key={child.from + ':' + child.name}>{render(child, depth + 1, inLink)}</Fragment>);
      position = child.to;
    }
    if (position < end) parts.push(text.slice(position, end));
    return parts;
  }

  function link(value: string, label: ReactNode, inLink: boolean) {
    if (inLink) return label;
    const external = parseExternalHttpLink(decodeDestination(value));
    if (external && onOpenExternal) {
      return <a href={external} rel="noreferrer noopener" onClick={event => {
        event.preventDefault();
        onOpenExternal(external);
      }} onAuxClick={event => event.preventDefault()}>{label}</a>;
    }
    const documentLink = chatDocumentLink(value);
    if (documentLink && documentFile && onOpenDocument) {
      return <button type="button" className="chat-document-link" onClick={() => onOpenDocument(documentFile, documentLink)}>{label}</button>;
    }
    return label;
  }

  function render(node: SyntaxNode, depth: number, inLink = false): ReactNode {
    const raw = text.slice(node.from, node.to);
    if (depth > 48) return raw;
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
    if (heading) {
      const marks = node.getChildren('HeaderMark');
      const start = marks[0]?.from === node.from ? marks[0].to : node.from;
      const last = marks.at(-1);
      const end = last && last.from > start ? last.from : node.to;
      return createElement('h' + heading[1], null, children(node, depth, start, end));
    }
    const inlineTag = inlineTags.get(node.name);
    if (inlineTag) return createElement(inlineTag, null, children(node, depth, node.from, node.to, inLink));
    const blockTag = blockTags.get(node.name);
    if (blockTag) {
      const start = node.name === 'OrderedList' ? Number.parseInt(raw, 10) : undefined;
      return createElement(blockTag, start === undefined || start === 1 ? null : { start }, children(node, depth));
    }
    switch (node.name) {
      case 'Document':
        return children(node, depth);
      case 'InlineCode': {
        const marks = node.getChildren('CodeMark');
        const content = text.slice(marks[0].to, marks[1].from).replace(/\r?\n/g, ' ');
        return <code>{content.startsWith(' ') && content.endsWith(' ') && content.trim() ? content.slice(1, -1) : content}</code>;
      }
      case 'FencedCode':
      case 'CodeBlock':
        return <pre><code>{node.getChildren('CodeText').map(part => text.slice(part.from, part.to)).join('')}</code></pre>;
      case 'Link':
      case 'Image': {
        const [open, close] = node.getChildren('LinkMark');
        if (!open || !close) return raw;
        const label = children(node, depth, open.to, close.from, true);
        if (node.name === 'Image') return label;
        const url = node.getChild('URL'), ref = node.getChild('LinkLabel');
        const target = url ? text.slice(url.from, url.to) : references.get(referenceKey(
          ref && ref.to - ref.from > 2 ? text.slice(ref.from + 1, ref.to - 1) : text.slice(open.to, close.from),
        ));
        return target === undefined ? raw : link(target, label, inLink);
      }
      case 'Autolink': {
        const url = node.getChild('URL');
        if (!url) return raw;
        const value = text.slice(url.from, url.to);
        return link(value, value, inLink);
      }
      case 'URL':
        return link(raw, raw, inLink);
      case 'Escape':
        return raw.slice(1);
      case 'Entity':
        return decodeEntities(raw);
      case 'HardBreak':
        return <br/>;
      case 'HorizontalRule':
        return <hr/>;
      case 'TaskMarker':
        return <input type="checkbox" disabled checked={/x/i.test(raw)} aria-label="任务状态"/>;
      case 'Table': {
        const header = node.getChild('TableHeader');
        const rows = node.getChildren('TableRow');
        function cells(row: SyntaxNode, tag: 'th' | 'td') {
          return row.getChildren('TableCell').map(cell => createElement(tag, { key: cell.from }, children(cell, depth + 1)));
        }
        return <div className="chat-markdown-table"><table>
          {header && <thead><tr>{cells(header,'th')}</tr></thead>}
          <tbody>{rows.map(row => <tr key={row.from}>{cells(row,'td')}</tr>)}</tbody>
        </table></div>;
      }
      case 'LinkReference':
      case 'HeaderMark':
      case 'QuoteMark':
      case 'ListMark':
      case 'EmphasisMark':
      case 'StrikethroughMark':
        return null;
      default:
        return raw;
    }
  }

  return <div className="chat-markdown">{render(tree.topNode, 0)}</div>;
});
