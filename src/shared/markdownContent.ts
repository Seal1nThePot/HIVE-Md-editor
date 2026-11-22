import {frontmatterBlock} from './frontmatter';
import {GFM,parser as markdownParser} from '@lezer/markdown';
const countParser=markdownParser.configure(GFM);
const proseParagraphNode = /^(Paragraph|Task|(ATX|Setext)Heading[1-6])$/;
const proseExcludedNode = /^(InlineCode|Image|URL|LinkLabel|Comment|ProcessingInstruction|Entity|Escape)$/;

// The optional callback receives the prose of each Markdown paragraph in document order.
export function markdownContent(text: string, collectProseParagraph?: (paragraph: string) => void) {
  const metadata=frontmatterBlock(text);if(metadata)text=text.slice(metadata.to);
  const hidden: { from: number; to: number }[] = [];
  let paragraphs=0;
  let prose: { from: number; to: number; cursor: number; parts: string[] } | undefined;
  countParser.parse(text).iterate({
    enter(node) {
      if(proseParagraphNode.test(node.name)){
        if(collectProseParagraph&&!prose)prose={from:node.from,to:node.to,cursor:node.from,parts:[]};
        let cursor=node.from,body='';
        for(let child=node.node.firstChild;child;child=child.nextSibling)if(child.name==='HeaderMark'||child.name==='TaskMarker'){body+=text.slice(cursor,child.from);cursor=child.to;}
        if((body+text.slice(cursor,node.to)).trim())paragraphs++;
      }
      const markup =
        /^(HeaderMark|EmphasisMark|StrikethroughMark|CodeMark|QuoteMark|ListMark|TaskMarker|TableDelimiter|LinkMark|LinkTitle|CodeInfo|HTMLTag)$/.test(
          node.name,
        ) ||
        (node.name === "URL" &&
          /^(Link|Image)$/.test(node.node.parent?.name || "")) ||
        (node.name === 'HTMLBlock' && /^(?:<div style="text-align: (?:left|center|right);">|<\/div>)$/.test(text.slice(node.from,node.to).trim()));
      if (markup) hidden.push({ from: node.from, to: node.to });
      if (node.name === "Escape")
        hidden.push({ from: node.from, to: node.from + 1 });
      if (prose && (markup || proseExcludedNode.test(node.name))) {
        const end = node.name === "Escape" ? node.from + 1 : node.to;
        if (node.from > prose.cursor) prose.parts.push(text.slice(prose.cursor, node.from));
        prose.cursor = Math.max(prose.cursor, end);
      }
    },
    leave(node) {
      if (prose && prose.from === node.from && prose.to === node.to && proseParagraphNode.test(node.name)) {
        prose.parts.push(text.slice(prose.cursor, node.to));
        collectProseParagraph?.(prose.parts.join(""));
        prose = undefined;
      }
    },
  });
  let cursor = 0,
    visible = "";
  for (const range of hidden.sort((a, b) => a.from - b.from)) {
    if (range.from >= cursor) {
      visible += text.slice(cursor, range.from);
      cursor = range.to;
    }
  }
  visible += text.slice(cursor);
  return {text:visible,paragraphs};
}
