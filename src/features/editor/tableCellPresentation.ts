import {parser,GFM} from '@lezer/markdown';
import type {SyntaxNode} from '@lezer/common';
import {quotedStrong} from './quotedStrong';

const inlineParser=parser.configure([GFM,quotedStrong]);
const sourceRanges=new WeakMap<Node,{from:number;to:number}>();

/** Map a caret in rendered cell text to the cell's Markdown source. */
export function tableCellSourceOffset(target:HTMLElement,x:number,y:number){
  const document=target.ownerDocument,caret=document.caretPositionFromPoint?.(x,y);
  const range=caret?null:document.caretRangeFromPoint?.(x,y);
  const node=caret?.offsetNode??range?.startContainer,offset=caret?.offset??range?.startOffset;
  if(!node||offset===undefined||!target.contains(node))return;
  const span=sourceRanges.get(node),length=node.textContent?.length||0;
  if(span&&length)return span.from+Math.round(offset*(span.to-span.from)/length);
}

/** Render known inline nodes and the literal br and mark tags. */
export function renderTableCell(target:HTMLElement,source:string){
  source='x '+source;
  const doc=target.ownerDocument,tree=inlineParser.parse(source),paragraph=tree.topNode.firstChild;
  target.replaceChildren();
  const text=(parent:Node,value:string,from:number,to:number)=>{
    if(!value)return;
    const node=doc.createTextNode(value);
    sourceRanges.set(node,{from:from-2,to:to-2});
    parent.appendChild(node);
  };
  const renderRange=(parent:Node,from:number,to:number,first:SyntaxNode|null)=>{
    let pos=from;
    for(let node=first;node&&node.from<to;node=node.nextSibling){
      if(node.from<from||node.to>to)continue;
      text(parent,source.slice(pos,node.from),pos,node.from);
      if(node.name==='HTMLTag'&&source.slice(node.from,node.to)==='<mark>'){
        let close=node.nextSibling,depth=1;
        for(;close&&close.to<=to;close=close.nextSibling){
          if(close.name!=='HTMLTag')continue;
          const tag=source.slice(close.from,close.to);
          if(tag==='<mark>')depth++;
          if(tag==='</mark>'&&!--depth)break;
        }
        if(close&&depth===0){
          const mark=doc.createElement('mark');mark.className='cm-format-highlight';
          renderRange(mark,node.to,close.from,node.nextSibling);parent.appendChild(mark);
          pos=close.to;node=close;continue;
        }
      }
      renderNode(parent,node);pos=node.to;
    }
    text(parent,source.slice(pos,to),pos,to);
  };
  const renderNode=(parent:Node,node:SyntaxNode)=>{
    const raw=source.slice(node.from,node.to),name=node.name;
    if(name==='Escape'){text(parent,raw.slice(1),node.from,node.to);return;}
    if(name==='Entity') {const decoder=doc.createElement('textarea');decoder.innerHTML=raw;text(parent,decoder.value,node.from,node.to);return;}
    if(name==='HTMLTag'&&/^<br\s*\/?\s*>$/i.test(raw)){parent.appendChild(doc.createElement('br'));return;}
    if(name==='InlineCode') {
      const first=node.firstChild,last=node.lastChild;
      if(first&&last){
        const el=doc.createElement('code');
        let from=first.to,to=last.from,value=source.slice(from,to).replace(/\n/g,' ');
        if(/^ .+ $/.test(value)&&/[^ ]/.test(value)){value=value.slice(1,-1);from++;to--;}
        text(el,value,from,to);parent.appendChild(el);return;
      }
    }
    const tag=name==='StrongEmphasis'?'strong':name==='Emphasis'?'em':name==='Strikethrough'?'del':null;
    if(tag){const first=node.firstChild,last=node.lastChild;if(first&&last){const el=doc.createElement(tag);renderRange(el,first.to,last.from,first.nextSibling);parent.appendChild(el);return;}}
    if(name==='Link'){const children:SyntaxNode[]=[];for(let child=node.firstChild;child;child=child.nextSibling)children.push(child);const close=children.find((n,i)=>i>0&&n.name==='LinkMark'),url=children.find(n=>n.name==='URL');if(close){const el=doc.createElement('a'),destination=url?source.slice(url.from,url.to):'';if(destination)el.dataset.hiveLink=destination;renderRange(el,children[0].to,close.from,children[0].nextSibling);parent.appendChild(el);return;}}
    text(parent,raw,node.from,node.to);
  };
  if(paragraph?.name==='Paragraph')renderRange(target,2,source.length,paragraph.firstChild);else text(target,source.slice(2),2,source.length);
}
