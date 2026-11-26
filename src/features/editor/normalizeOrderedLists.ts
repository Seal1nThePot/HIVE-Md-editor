import {EditorState,countColumn,type ChangeSpec,type Text} from '@codemirror/state';
import type {SyntaxNode} from '@lezer/common';
import {markdownTree} from './markdownParse';
import {listItemMarker,orderedListMarkers,quotePrefixEnd} from './listStructure';

const markdownTabSize=4;
const maxMarkerLength=10; // CommonMark permits at most nine digits followed by a delimiter.
type Indent={from:number;to:number;width:number;delta:number};
export const listNormalizationEvent='input.shared-document.list-renumber';

function compensateIndent(doc:Text,item:SyntaxNode,delta:number,indents:Map<number,Indent>){
  const marker=listItemMarker(doc,item);
  if(!marker)return;
  const end=doc.lineAt(Math.max(item.from,item.to-1)).number;
  for(let number=marker.line.number+1;number<=end;number++){
    const line=doc.line(number),prefix=quotePrefixEnd(line.text,marker.quotes);
    const remainder=line.text.slice(prefix);
    if(!remainder.trim())continue;
    const spaces=/^[ \t]*/.exec(remainder)![0];
    const whitespaceColumn=countColumn(line.text.slice(0,prefix+spaces.length),markdownTabSize);
    if(whitespaceColumn<marker.contentColumn)continue; // Keep lazy paragraph continuations.
    const from=line.from+prefix,entry=indents.get(from);
    if(entry){entry.delta+=delta;continue;}
    const width=whitespaceColumn-countColumn(line.text.slice(0,prefix),markdownTabSize);
    indents.set(from,{from,to:from+spaces.length,width,delta});
  }
}

/** Save the same numbering shown in the preview. Keep indentation meaningful
 * when a marker crosses a digit boundary and preserve the parsed block structure. */
export function normalizeOrderedLists(state:EditorState){
  const doc=state.doc,tree=markdownTree(state);
  const stable:ChangeSpec[]=[],resized:ChangeSpec[]=[],indents=new Map<number,Indent>();
  let skipped=false;
  tree.iterate({enter(node){
    if(node.name!=='OrderedList')return;
    const markers=orderedListMarkers(doc,node.node.getChildren('ListItem'));
    if(markers.some(({label})=>label.length>maxMarkerLength)){skipped=true;return;}
    for(const {item,mark,raw,label} of markers){
      if(raw===label)continue;
      const change={from:mark.from,to:mark.to,insert:label};
      const delta=label.length-raw.length;
      if(!delta){stable.push(change);continue;}
      const line=doc.lineAt(mark.from),after=mark.to-line.from;
      const spaces=/^[ \t]*/.exec(line.text.slice(after))![0];
      if(spaces.includes('\t')){
        // Keep the separator width when moving a tab across a tab stop.
        const width=countColumn(line.text.slice(0,after+spaces.length),markdownTabSize)
          -countColumn(line.text.slice(0,after),markdownTabSize);
        resized.push({from:mark.from,to:mark.to+spaces.length,insert:label+' '.repeat(width)});
      }else resized.push(change);
      compensateIndent(doc,item,delta,indents);
    }
  }});
  if(!resized.length)return {changes:state.changes(stable),skipped};
  const corrections=[...indents.values()].flatMap(({from,to,width,delta})=>delta
    ?[{from,to,insert:' '.repeat(Math.max(0,width+delta))}]:[]);
  const changes=state.changes([...stable,...resized,...corrections]);
  const updated=EditorState.create({doc:changes.apply(doc)});
  if(markdownTree(updated).toString()===tree.toString())return {changes,skipped};
  // A parser-sensitive indent is safer left intact. Equal-width edits cannot
  // invalidate the surrounding continuation or code-block indentation.
  return {changes:state.changes(stable),skipped:true};
}
