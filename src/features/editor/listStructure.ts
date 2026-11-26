import {getIndentUnit} from '@codemirror/language';
import {countColumn,type ChangeSpec,type Line,type Text,type EditorState,type StateCommand} from '@codemirror/state';
import type {SyntaxNode} from '@lezer/common';
import {markdownTree} from './markdownParse';

const markdownTabSize=4;

function quoteDepth(item:SyntaxNode){
  let depth=0;
  for(let parent=item.parent;parent;parent=parent.parent)if(parent.name==='Blockquote')depth++;
  return depth;
}

/** After the existing enclosing quote markers, including their optional separator. */
export function quotePrefixEnd(text:string,depth:number){
  let end=0;
  for(let quote=0;quote<depth;quote++){
    const prefix=/^[ \t]*>[ \t]?/.exec(text.slice(end));
    if(!prefix)break;
    end+=prefix[0].length;
  }
  return end;
}

export function orderedListMarkers(doc:Text,items:readonly SyntaxNode[]){
  const markers=items.flatMap(item=>{
    const mark=item.name==='ListItem'?item.getChild('ListMark'):null;
    return mark?[{item,mark,raw:doc.sliceString(mark.from,mark.to)}]:[];
  });
  const first=markers[0]?.raw;
  if(!first)return [];
  const start=Number(first.slice(0,-1)),delimiter=first.at(-1);
  return markers.map((value,index)=>({...value,label:String(start+index)+delimiter}));
}

export function listItemMarker(doc:Text,item:SyntaxNode,quotes=quoteDepth(item)){
  const mark=item.getChild('ListMark');
  if(!mark)return null;
  const line=doc.lineAt(mark.from),prefix=quotePrefixEnd(line.text,quotes);
  const start=mark.from-line.from,end=mark.to-line.from;
  const spacing=/^[ \t]*/.exec(line.text.slice(end))![0];
  const column=countColumn(line.text.slice(0,start),markdownTabSize);
  const markerEnd=countColumn(line.text.slice(0,end),markdownTabSize);
  const body=countColumn(line.text.slice(0,end+spacing.length),markdownTabSize);
  // CommonMark treats a blank marker line or 5+ following columns as one
  // separator column. Extra spaces in the latter case belong to its body.
  const contentColumn=end+spacing.length===line.text.length||body-markerEnd>4?markerEnd+1:body;
  return {mark,line,prefix,quotes,column,contentColumn,quoteColumn:countColumn(line.text.slice(0,prefix),markdownTabSize)};
}

function enclosingItem(node:SyntaxNode){
  for(let parent=node.parent;parent;parent=parent.parent)if(parent.name==='ListItem')return parent;
  return null;
}

function itemAtLine(state:EditorState,node:SyntaxNode,cursorOnly:boolean){
  for(let candidate:SyntaxNode|null=node;candidate;candidate=candidate.parent){
    if(cursorOnly&&(candidate.name==='FencedCode'||candidate.name==='CodeBlock'))return null;
    if(candidate.name!=='ListItem')continue;
    const marker=listItemMarker(state.doc,candidate);
    if(marker&&!marker.line.text.slice(marker.prefix,marker.mark.from-marker.line.from).trim())return candidate;
  }
  return null;
}

function selectedItems(state:EditorState){
  const tree=markdownTree(state),items=new Map<number,SyntaxNode>();
  for(const range of state.selection.ranges){
    for(let line=state.doc.lineAt(range.from);;line=state.doc.line(line.number+1)){
      const text=line.text.trimEnd();
      if(text.trim()){
        const item=itemAtLine(state,tree.resolveInner(line.from+text.length,-1),range.empty);
        if(!item)return [];
        items.set(item.from,item);
      }
      if(line.to>=range.to||line.to+1===range.to)break;
    }
  }
  const independent:SyntaxNode[]=[];
  for(const item of [...items.values()].sort((a,b)=>a.from-b.from||b.to-a.to)){
    if((independent.at(-1)?.to??-1)<item.to)independent.push(item);
  }
  return independent;
}

function indentationChange(line:Line,quotes:number,delta:number):ChangeSpec|null{
  const prefix=quotePrefixEnd(line.text,quotes),body=line.text.slice(prefix);
  if(!body.trim())return null;
  const whitespace=/^[ \t]*/.exec(body)![0],from=line.from+prefix;
  if(!whitespace.includes('\t'))return {from,insert:' '.repeat(delta)};
  const oldWidth=countColumn(line.text.slice(0,prefix+whitespace.length),markdownTabSize)
    -countColumn(line.text.slice(0,prefix),markdownTabSize);
  return {from,to:from+whitespace.length,insert:' '.repeat(oldWidth+delta)};
}

/** One transaction moves each selected item and its descendants. A contiguous
 * sibling selection uses the nearest untouched predecessor as its common parent.
 * With no predecessor, use the remaining legal indentation of that list level. */
export const indentMarkdownList:StateCommand=({state,dispatch})=>{
  if(state.readOnly)return false;
  const items=selectedItems(state);
  if(!items.length)return false;

  const anchors=new Map<number,SyntaxNode|null>(),changes:ChangeSpec[]=[];
  for(const item of items){
    const marker=listItemMarker(state.doc,item);
    if(!marker)continue;
    let previous=item.prevSibling;
    while(previous&&previous.name!=='ListItem')previous=previous.prevSibling;
    const anchor=previous?(anchors.has(previous.from)?anchors.get(previous.from)!:previous):null;
    anchors.set(item.from,anchor);
    const anchorMarker=anchor&&listItemMarker(state.doc,anchor);
    const parent=enclosingItem(item),parentMarker=parent&&listItemMarker(state.doc,parent);
    const base=Math.max(marker.quoteColumn,parentMarker?.contentColumn??0);
    const delta=anchorMarker?anchorMarker.contentColumn-marker.column:Math.min(getIndentUnit(state),base+3-marker.column);
    if(delta<=0)continue;
    const end=state.doc.lineAt(Math.max(item.from,item.to-1)).number;
    for(let number=marker.line.number;number<=end;number++){
      const change=indentationChange(state.doc.line(number),marker.quotes,delta);
      if(change)changes.push(change);
    }
  }

  if(changes.length){
    const changeSet=state.changes(changes);
    dispatch(state.update({changes:changeSet,selection:state.selection.map(changeSet,1),userEvent:'input.indent',scrollIntoView:true}));
  }
  return true;
};
