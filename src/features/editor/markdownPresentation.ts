import {documentFrontmatter} from '../../shared/frontmatter';
import type {SyntaxNode} from '@lezer/common';
import {StateField,type ChangeDesc,type EditorSelection,type EditorState,type Text,type Transaction} from '@codemirror/state';
import {inspectFormatting} from './formatting';
import {markdownTree} from './markdownParse';
import {scanMath,mergeSourceSpans,outsideMath,type SourceSpan} from './mathSyntax';
import {paragraphTypographyStyles} from '../typography/paragraphTypography';

type Span={from:number;to:number};
type Node=SyntaxNode;
export type PreviewCell=Span&{text:string;virtual?:number;trailing?:boolean};
export type PreviewReplacement=Span&{reveal:Span;block?:boolean;kind?:'bullet'|'task'|'image'|'rule'|'table'|'properties'|'math'|'mermaid';text?:string;src?:string;rows?:PreviewCell[][];columns?:number;rowEnds?:{to:number;trailing:boolean}[];tableOrdinal?:number;list?:boolean};
export type PreviewStyle=Span&{className?:string;line?:boolean;align?:'left'|'center'|'right';title?:string;link?:string;linkReveal?:Span;list?:{depth:number;width:string}};
export type PreviewPlan={replacements:PreviewReplacement[];styles:PreviewStyle[];punctuation:Span[]};
const cache=new WeakMap<Text,PreviewPlan>();
function children(node:Node,name?:string){const items:Node[]=[];for(let item=node.firstChild;item;item=item.nextSibling)if(!name||item.name===name)items.push(item);return items;}

type LocalPreviewUpdate={previousDoc:Text;changes:ChangeDesc};
/** A canonical pipe-wrapped cell can change without changing its containing GFM block. */
export const localPreviewUpdate=StateField.define<LocalPreviewUpdate|null>({
  create:()=>null,
  update(_value,tr){return tr.docChanged&&patchTableCell(tr)?{previousDoc:tr.startState.doc,changes:tr.changes}:null;},
});
function safeCellText(text:string){
  if(/[\r\n]/.test(text))return false;
  for(let i=0;i<text.length;i++){
    if(text[i]==='|')return false;
    if(text[i]==='\\'&&++i===text.length)return false;
  }
  return true;
}
function patchTableCell(tr:Transaction){
  const old=cache.get(tr.startState.doc);if(!old)return false;
  let count=0,from=0,to=0;
  tr.changes.iterChangedRanges((fromA,toA)=>{count++;from=fromA;to=toA;});
  if(count!==1)return false;
  const table=old.replacements.find(item=>item.kind==='table'&&from>=item.from&&to<=item.to);
  if(!table?.rows?.length||!table.rowEnds)return false;
  let low=0,high=table.rowEnds.length-1;
  while(low<high){const middle=(low+high)>>1;if(table.rowEnds[middle].to<from)low=middle+1;else high=middle;}
  const cell=table.rows[low]?.find(cell=>cell.virtual===undefined&&from>=cell.from&&to<=cell.to);
  if(!cell)return false;
  const line=tr.startState.doc.lineAt(cell.from),rowText=line.text.trim();
  // Other row shapes, delimiter changes, line breaks, escapes across cell boundaries,
  // virtual-cell insertions and all structural changes use the full incremental parser.
  if(!rowText.startsWith('|')||!rowText.endsWith('|')||to>line.to)return false;
  const cellFrom=tr.changes.mapPos(cell.from,-1),cellTo=tr.changes.mapPos(cell.to,1),raw=tr.state.doc.sliceString(cellFrom,cellTo);
  if(!safeCellText(raw)||/<\/?(?:u|mark)>/.test(raw)||/<\/?(?:u|mark)>/.test(tr.startState.doc.sliceString(cell.from,cell.to)))return false;
  const position=(value:number,side:-1|1)=>tr.changes.mapPos(value,side);
  const span=<T extends Span>(item:T):T=>{const from=position(item.from,-1),to=position(item.to,1);return from===item.from&&to===item.to?item:{...item,from,to};};
  const replacements=old.replacements.map(item=>{
    const mapped=span(item),reveal=span(item.reveal);
    if(!item.rows)return mapped===item&&reveal===item.reveal?item:{...mapped,reveal};
    const rows=item.rows.map(row=>{
      const first=row[0],last=row.at(-1);if(item!==table&&first&&last&&last.to<from)return row;
      if(first&&last&&last.to<from)return row;
      return row.map(current=>{const mapped=span(current);return current===cell?{...mapped,text:raw.trim()}:mapped;});
    });
    const rowEnds=item.rowEnds?.map(end=>{const to=position(end.to,1);return to===end.to?end:{...end,to};});
    return {...mapped,reveal,rows,rowEnds};
  });
  const styles=old.styles.map(item=>item.linkReveal?{...span(item),linkReveal:span(item.linkReveal)}:span(item));
  cache.set(tr.state.doc,{replacements,styles,punctuation:old.punctuation.map(span)});return true;
}

export function previewPlan(state:EditorState):PreviewPlan{
  const existing=cache.get(state.doc);if(existing)return existing;
  let tableOrdinal=0;
  const doc=state.doc,text=doc.toString(),hasMath=text.includes('$'),replacements:PreviewReplacement[]=[],styles:PreviewStyle[]=[],mathExcluded:SourceSpan[]=[],punctuation:Span[]=[];
  // Reference definitions can occur after their use and are scoped to this document.
  const references=new Map<string,string>();
  const referenceKey=(value:string)=>value.replace(/\\([\\[\]])/g,'$1').trim().replace(/\s+/g,' ').toLowerCase();
  const collectReferences=(node:Node)=>{
    if(node.name==='LinkReference'){
      const label=node.getChild('LinkLabel'),url=node.getChild('URL');
      if(label&&url){const key=referenceKey(text.slice(label.from+1,label.to-1));if(!references.has(key))references.set(key,text.slice(url.from,url.to));}
      return;
    }
    for(const child of children(node))collectReferences(child);
  };
  collectReferences(markdownTree(state).topNode);
  const hide=(from:number,to:number,reveal:Span={from,to},extra:Partial<PreviewReplacement>={})=>{if(to>from)replacements.push({from,to,reveal:{from:reveal.from,to:reveal.to},...extra});};
  const lineStyles=(from:number,to:number,className:string,align?:PreviewStyle['align'])=>{
    for(let number=doc.lineAt(from).number;number<=doc.lineAt(Math.max(from,to-1)).number;number++){const line=doc.line(number);styles.push({from:line.from,to:line.from,line:true,className,align});}
  };
  const codeLines=(first:number,last:number)=>{
    for(let number=first;number<=last;number++){
      const from=doc.line(number).from;
      const className='cm-preview-code-line'+(number===first?' cm-preview-code-first':'')+(number===last?' cm-preview-code-last':'');
      styles.push({from,to:from,line:true,className});
    }
  };
  const hideLine=(pos:number,reveal?:Span)=>{const line=doc.lineAt(pos);hide(line.from,Math.min(doc.length,line.to+1),reveal||{from:line.from,to:line.to},{block:true});};
  const listDepth=(node:Node)=>{let level=0;for(let parent=node.parent;parent;parent=parent.parent)if(parent.name==='ListItem')level++;return level;};
  const listLine=(from:number,depth:number,width:string,first=false)=>{
    const line=doc.lineAt(from);
    styles.push({from:line.from,to:line.from,line:true,className:'cm-preview-list-line'+(first?' cm-preview-list-first':''),list:{depth,width}});
    return line;
  };
  const listPrefix=(from:number,to:number,reveal:Span)=>{
    const spaces=text.slice(from,to).match(/[ \t]+$/)?.[0].length||0;
    hide(to-spaces,to,reveal,{list:true});
  };
  const listWidth=(mark:Node)=>/^\d/.test(text[mark.from])?`max(1.4em, ${mark.to-mark.from+1}ch)`:'1.4em';
  function joinClosingPunctuation(from:number,to:number,after:number){
    const line=doc.lineAt(after);
    if(to<=from||to<line.from||after===line.to)return;
    const suffix=/^[，。！？、；：）》」』】〕］〉”’％…]+/.exec(text.slice(after,line.to));
    if(!suffix)return;
    const start=Math.max(from,line.from);
    const last=/\P{Mark}\p{Mark}*$/u.exec(text.slice(start,to).trimEnd());
    if(last)punctuation.push({from:start+last.index,to:after+suffix[0].length});
  }
  function linkStyle(from:number,to:number,link?:string,reveal?:Span){
    styles.push({from,to,className:'cm-preview-link',title:link,link,linkReveal:reveal});
    if(reveal)joinClosingPunctuation(from,to,reveal.to);
  }
  function walk(node:Node){
    const parts=children(node),span={from:node.from,to:node.to};
    if(node.name==='Paragraph')styles.push(...paragraphTypographyStyles(node,doc));
    if(node.name==='Paragraph'||node.name==='Task'){
      const item=node.parent,mark=item?.name==='ListItem'?item.getChild('ListMark'):null;
      if(item&&mark){
        const first=doc.lineAt(node.from),last=doc.lineAt(Math.max(node.from,node.to-1)),depth=listDepth(item),width=listWidth(mark);
        for(let number=first.number;number<=last.number;number++){
          if(number===doc.lineAt(mark.from).number)continue;
          const line=listLine(doc.line(number).from,depth,width);
          const leading=/^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(line.text)?.[0].length||0;
          listPrefix(line.from,line.from+leading,{from:line.from,to:line.to});
        }
      }
    }
    if(hasMath&&['FencedCode','CodeBlock','InlineCode','Table','Image','HTMLBlock','HTMLTag','Autolink','LinkReference','URL','LinkTitle'].includes(node.name))mathExcluded.push(span);
    if(hasMath&&node.name==='Link')for(const part of parts)if(part.name==='URL'||part.name==='LinkTitle')mathExcluded.push({from:part.from,to:part.to});
    const heading=/^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
    if(heading){
      lineStyles(node.from,node.to,`cm-preview-h${heading[1]}`);
      for(const mark of children(node,'HeaderMark')){
        if(node.name.startsWith('Setext'))hideLine(mark.from,span);
        else {let end=mark.to;if(mark.from===node.from)while(end<node.to&&/[ \t]/.test(text[end]))end++;hide(mark.from,end,span);}
      }
    }
    if(node.name==='FencedCode'){
      const info=parts.find(item=>item.name==='CodeInfo');
      if(info&&/^mermaid(?:\s|$)/i.test(text.slice(info.from,info.to))){hide(node.from,node.to,span,{kind:'mermaid',block:true,text:parts.find(item=>item.name==='CodeText')?text.slice(parts.find(item=>item.name==='CodeText')!.from,parts.find(item=>item.name==='CodeText')!.to):''});return;}
      const [opening,closing]=parts.filter(item=>item.name==='CodeMark');
      const openingLine=doc.lineAt(opening.from).number;
      const lastBodyLine=closing?doc.lineAt(closing.from).number-1:doc.lineAt(Math.max(node.from,node.to-1)).number;
      codeLines(openingLine+1,lastBodyLine);
      lineStyles(opening.from,opening.to,'cm-preview-code-line cm-preview-code-opening');
      hideLine(opening.from,span);
      if(closing){
        lineStyles(closing.from,closing.to,'cm-preview-code-line cm-preview-code-closing');
        hideLine(closing.from,span);
      }
      return;
    }
    if(node.name==='CodeBlock'){codeLines(doc.lineAt(node.from).number,doc.lineAt(Math.max(node.from,node.to-1)).number);return;}
    if(node.name==='InlineCode'){
      const marks=children(node,'CodeMark');if(marks.length===2){
        styles.push({from:marks[0].to,to:marks[1].from,className:'cm-preview-inline-code'});
        joinClosingPunctuation(marks[0].to,marks[1].from,node.to);
        for(const mark of marks)hide(mark.from,mark.to,span);
      }return;
    }
    if(node.name==='Table'){
      const rowNodes=parts.filter(item=>item.name==='TableHeader'||item.name==='TableRow');
      const rows=rowNodes.map(row=>{
        const cells:PreviewCell[]=[],delimiters=children(row,'TableDelimiter');let start=row.from;
        for(let index=0;index<delimiters.length;index++){const delimiter=delimiters[index];if(index||text.slice(start,delimiter.from).trim())cells.push({from:start,to:delimiter.from,text:text.slice(start,delimiter.from).trim()});start=delimiter.to;}
        if(start<row.to||!delimiters.length)cells.push({from:start,to:row.to,text:text.slice(start,row.to).trim()});
        return cells;
      });
      const columns=rows[0]?.length||0,rowEnds=rowNodes.map(row=>({to:row.to,trailing:text.slice(row.from,row.to).trimEnd().endsWith('|')}));
      // Keep pathological sparse tables proportional to their source, not rows × columns.
      rows.forEach((row,index)=>{if(rows.length*columns<=65536)while(row.length<columns)row.push({from:rowEnds[index].to,to:rowEnds[index].to,text:'',virtual:row.length,trailing:rowEnds[index].trailing});if(row.length>columns)row.length=columns;});
      hide(node.from,node.to,span,{kind:'table',block:true,rows,columns,rowEnds,tableOrdinal:tableOrdinal++});return;
    }
    if(node.name==='HorizontalRule'){hide(node.from,node.to,span,{kind:'rule',block:true});return;}
    if(node.name==='Blockquote')lineStyles(node.from,node.to,'cm-preview-quote');
    if(node.name==='StrongEmphasis'||node.name==='Emphasis'||node.name==='Strikethrough'){
      const marks=parts.filter(item=>item.name.endsWith('Mark'));
      if(marks.length>=2)styles.push({from:marks[0].to,to:marks.at(-1)!.from,className:node.name==='StrongEmphasis'?'cm-preview-strong':node.name==='Emphasis'?'cm-preview-emphasis':'cm-preview-strike'});
    }
    if(node.name==='EmphasisMark'||node.name==='StrikethroughMark'){hide(node.from,node.to,node.parent||span);return;}
    if(node.name==='ListMark'){
      const depth=listDepth(node.parent||node),line=listLine(node.from,depth,listWidth(node),true);
      const reveal={from:line.from,to:line.to};
      listPrefix(line.from,node.from,reveal);
      const task=node.parent?.getChild('Task')?.getChild('TaskMarker');
      if(task)hide(node.from,task.from,reveal,{list:true});
      else {
        let end=node.to;
        while(end<line.to&&/[ \t]/.test(text[end]))end++;
        hide(node.from,end,reveal,{kind:'bullet',text:/^\d/.test(text[node.from])?text.slice(node.from,node.to):['•','◦','▪'][Math.min(2,depth)],list:true});
      }
      return;
    }
    if(node.name==='TaskMarker'){
      const line=doc.lineAt(node.from);let end=node.to;
      while(end<line.to&&/[ \t]/.test(text[end]))end++;
      hide(node.from,node.to,span,{kind:'task',text:/[xX]/.test(text.slice(node.from,node.to))?'☑':'☐'});
      hide(node.to,end,{from:line.from,to:line.to},{list:true});
      return;
    }
    if(node.name==='QuoteMark'){let to=node.to;if(text[to]===' ')to++;hide(node.from,to,span);return;}
    if(node.name==='Escape'){hide(node.from,node.from+1,span);return;}
    if(node.name==='Image'){
      const raw=text.slice(node.from,node.to),wiki=/^!\[\[([^\]\n]+)\]\]$/.exec(raw);
      if(wiki){
        const [path,...options]=wiki[1].split('|'),src=path.trim(),label=options.join('|').trim();
        if(src){hide(node.from,node.to,span,{kind:'image',text:label||src,src});return;}
      }
    }
    if(node.name==='Link'||node.name==='Image'){
      const first=parts.find(item=>item.name==='LinkMark'),end=parts.find(item=>item.name==='LinkMark'&&text.slice(item.from,item.to)===']');
      if(first&&end){
        const url=parts.find(item=>item.name==='URL');
        if(node.name==='Image'){
          const alt=text.slice(first.to,end.from).replace(/\\([\\[\]])/g,'$1'),label=parts.find(item=>item.name==='LinkLabel');
          const reference=label?text.slice(label.from+1,label.to-1)||alt:alt;
          const src=url?text.slice(url.from,url.to):references.get(referenceKey(reference));
          hide(node.from,node.to,span,{kind:'image',text:alt||'图片',src});return;
        }
        const label=parts.find(item=>item.name==='LinkLabel');
        const fallback=text.slice(first.to,end.from),reference=label?text.slice(label.from+1,label.to-1)||fallback:fallback;
        const link=url?text.slice(url.from,url.to):references.get(referenceKey(reference));
        linkStyle(first.to,end.from,link,span);
        hide(node.from,first.to,span);hide(end.from,node.to,span);
        for(const part of parts)if(part.from>=first.to&&part.to<=end.from)walk(part);
        return;
      }
    }
    if(node.name==='Autolink'){
      const url=node.getChild('URL');
      if(url)linkStyle(url.from,url.to,text.slice(url.from,url.to),span);
      for(const mark of children(node,'LinkMark'))hide(mark.from,mark.to,span);
      return;
    }
    if(node.name==='URL'&&/^https?:\/\//i.test(text.slice(node.from,node.to)))linkStyle(node.from,node.to,text.slice(node.from,node.to),span);
    if(node.name==='HTMLTag'){hide(node.from,node.to,span);return;}
    if(node.name==='HTMLBlock'){
      for(const match of text.slice(node.from,node.to).matchAll(/<\/?[a-zA-Z][^>\n]*>|<!--[\s\S]*?-->/g))hide(node.from+match.index,node.from+match.index+match[0].length,span);
      return;
    }
    if(node.name==='LinkReference'){hide(node.from,node.to,span,{block:true});return;}
    for(const part of parts)walk(part);
  }
  const metadata=documentFrontmatter(doc);if(metadata)hide(metadata.from,metadata.to,{from:metadata.from,to:metadata.to},{kind:'properties',block:true,text:'笔记属性'});
  walk(markdownTree(state).topNode);
  if(text.includes('<mark>')||text.includes('<u>')||text.includes('<div style="text-align: ')){
    const {blocks,underlines,highlights}=inspectFormatting(state);
    for(const span of underlines)if(span.contentTo>span.contentFrom)styles.push({from:span.contentFrom,to:span.contentTo,className:'cm-format-underline'});
    for(const span of highlights)if(span.contentTo>span.contentFrom)styles.push({from:span.contentFrom,to:span.contentTo,className:'cm-format-highlight'});
    for(const block of blocks){
      lineStyles(block.contentFrom,block.contentTo,'cm-preview-aligned',block.alignment);
      hide(block.from,block.contentFrom,{from:block.from,to:block.openTo},{block:true});
      const closing=doc.lineAt(block.closeFrom),previous=closing.number>1?doc.line(closing.number-1):closing;
      hide(previous.text.trim()?closing.from:previous.from,Math.min(doc.length,closing.to+1),{from:closing.from,to:closing.to},{block:true});
    }
  }
  if(metadata)mathExcluded.push({from:metadata.from,to:metadata.to});
  const math=hasMath?scanMath(text,mathExcluded):{math:[],literal:[]},protectedSpans=mergeSourceSpans([...math.math,...math.literal]);
  const blockMathLines=mergeSourceSpans([...math.math.filter(item=>item.block),...math.literal].map(item=>({from:doc.lineAt(item.from).from,to:doc.lineAt(Math.max(item.from,item.to-1)).to+1})));
  const mathReplacements:PreviewReplacement[]=math.math.map(item=>({from:item.from,to:item.to,reveal:{from:item.from,to:item.to},block:item.block,kind:'math',text:item.status}));
  const plan={
    replacements:[...replacements.filter(item=>{
      if(metadata&&item.kind!=='properties'&&item.from<metadata.to)return false;
      if(!protectedSpans.length)return true;
      const pieces=outsideMath(item,protectedSpans);return pieces.length===1&&pieces[0].from===item.from&&pieces[0].to===item.to;
    }),...mathReplacements],
    styles:styles.filter(item=>(!metadata||item.from>=metadata.to)&&(!item.className?.startsWith('cm-typography-')||outsideMath({from:item.from,to:item.from+1},blockMathLines).length>0)).flatMap(item=>item.line?[item]:outsideMath(item,protectedSpans)),
    punctuation:punctuation.filter(item=>outsideMath(item,protectedSpans).some(piece=>piece.from===item.from&&piece.to===item.to)),
  };cache.set(doc,plan);return plan;
}

function intersectsSelection(item:PreviewReplacement,range:EditorState['selection']['ranges'][number]){
  if(!range.empty)return range.from<item.to&&range.to>item.from;
  return range.from<item.to&&(range.from>item.from||item.kind==='math'&&range.from===item.from);
}
const selectionReplacements={image:new WeakMap<Text,PreviewReplacement[]>(),math:new WeakMap<Text,PreviewReplacement[]>()};
/** Changes within the same replacement ranges can reuse the existing decorations. */
export function replacementSelectionSignature(state:EditorState,kind:keyof typeof selectionReplacements,selection:EditorSelection|null){
  if(!selection)return '';
  const cache=selectionReplacements[kind];
  let items=cache.get(state.doc);
  if(!items){items=previewPlan(state).replacements.filter(item=>item.kind===kind).sort((a,b)=>a.from-b.from);cache.set(state.doc,items);}
  const selected=new Set<number>();
  for(const range of selection.ranges){
    let low=0,high=items.length;
    while(low<high){const middle=(low+high)>>1;if(items[middle].to<=range.from)low=middle+1;else high=middle;}
    for(let index=low;index<items.length&&items[index].from<=range.to;index++)if(intersectsSelection(items[index],range))selected.add(index);
  }
  return [...selected].sort((a,b)=>a-b).join(',');
}
export function previewActiveLines(state:EditorState,selection:EditorSelection|null){
  return selection?selection.ranges.map(range=>{
    const end=range.to>range.from&&state.doc.lineAt(range.to).from===range.to?range.to-1:range.to;
    return {from:state.doc.lineAt(range.from).from,to:state.doc.lineAt(end).to};
  }):[];
}
export function visibleReplacements(state:EditorState,focused:boolean,selection:EditorSelection|null=state.selection,pointerMath:EditorSelection|null=null){
  const active=previewActiveLines(state,focused?selection:null);
  const filtered=previewPlan(state).replacements.filter(item=>{
    if(item.kind==='table'||item.kind==='task')return true;
    if(item.kind==='image')return !focused||!selection?.ranges.some(range=>intersectsSelection(item,range));
    if(item.kind==='math'&&pointerMath)return !focused||!pointerMath.ranges.some(range=>intersectsSelection(item,range));
    return !active.some(line=>item.reveal.from<=line.to&&item.reveal.to>line.from);
  });
  const result:PreviewReplacement[]=[];
  for(const item of filtered.sort((a,b)=>a.from-b.from||b.to-a.to)){
    const previous=result.at(-1);if(previous&&item.from<previous.to){if(item.to>previous.to&&!previous.kind&&!item.kind)result[result.length-1]={...previous,to:item.to,block:previous.block||item.block};continue;}
    result.push(item);
  }
  return result;
}
