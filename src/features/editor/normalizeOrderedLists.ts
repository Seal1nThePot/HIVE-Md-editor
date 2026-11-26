import {EditorState,countColumn,type ChangeSpec,type Text} from '@codemirror/state';
import type {SyntaxNode} from '@lezer/common';
import {markdownTree} from './markdownParse';
import {listItemMarker,orderedListMarkers,quotePrefixEnd} from './listStructure';

const markdownTabSize=4;
const maxMarkerLength=10; // CommonMark permits at most nine digits followed by a delimiter.
type Indent={from:number;to:number;width:number;delta:number};
type OrderedMarker=ReturnType<typeof orderedListMarkers>[number];
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

function resizeMarkers(state:EditorState,stable:ChangeSpec[],markers:OrderedMarker[],preserveColumns:boolean){
  const doc=state.doc,edits:ChangeSpec[]=[...stable],indents=new Map<number,Indent>();
  for(const {item,mark,raw,label} of markers){
    const line=doc.lineAt(mark.from),after=mark.to-line.from;
    const spacing=/^[ \t]*/.exec(line.text.slice(after))![0];
    const width=countColumn(line.text.slice(0,after+spacing.length),markdownTabSize)
      -countColumn(line.text.slice(0,after),markdownTabSize);
    const delta=label.length-raw.length;
    const usesSeparator=width>=1&&width<=4&&after+spacing.length<line.length;
    const separator=preserveColumns&&usesSeparator?Math.max(1,Math.min(4,width-delta)):width;
    const adjustSpacing=spacing.includes('\t')||separator!==width;
    edits.push({
      from:mark.from,to:mark.to+(adjustSpacing?spacing.length:0),
      insert:label+(adjustSpacing?' '.repeat(separator):''),
    });
    const contentDelta=delta+separator-width;
    if(contentDelta)compensateIndent(doc,item,contentDelta,indents);
  }
  for(const {from,to,width,delta} of indents.values()){
    if(delta)edits.push({from,to,insert:' '.repeat(Math.max(0,width+delta))});
  }
  return state.changes(edits);
}

/** Save the same numbering shown in the preview. Keep indentation meaningful
 * when a marker crosses a digit boundary and preserve the parsed block structure. */
export function normalizeOrderedLists(state:EditorState){
  const doc=state.doc,tree=markdownTree(state);
  const stable:ChangeSpec[]=[],resized:OrderedMarker[]=[];
  let skipped=false;
  tree.iterate({enter(node){
    if(node.name!=='OrderedList')return;
    const markers=orderedListMarkers(doc,node.node.getChildren('ListItem'));
    if(markers.some(({label})=>label.length>maxMarkerLength)){skipped=true;return;}
    for(const marker of markers){
      const {mark,raw,label}=marker;
      if(raw===label)continue;
      if(raw.length===label.length)stable.push({from:mark.from,to:mark.to,insert:label});
      else resized.push(marker);
    }
  }});
  if(!resized.length)return {changes:state.changes(stable),skipped};
  const structure=tree.toString();
  for(const preserveColumns of [false,true]){
    // A shrinking marker can otherwise absorb a nearby root block. Try
    // keeping the old content column with padding after the delimiter.
    const changes=resizeMarkers(state,stable,resized,preserveColumns);
    const updated=EditorState.create({doc:changes.apply(doc)});
    if(markdownTree(updated).toString()===structure)return {changes,skipped};
  }
  // A parser-sensitive indent is safer left intact. Equal-width edits cannot
  // invalidate the surrounding continuation or code-block indentation.
  return {changes:state.changes(stable),skipped:true};
}
