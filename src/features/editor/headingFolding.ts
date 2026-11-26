import {StateEffect, StateField, type EditorState, type Extension, type Text} from '@codemirror/state';
import {codeFolding, foldEffect, unfoldEffect, foldedRanges} from '@codemirror/language';
import {Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet} from '@codemirror/view';
import {createUiIcon} from '../../shared/icons';
import {outlineTree} from './markdownParse';

export type HeadingFold = {from:number; to:number; lineFrom:number; level:number};
const headingPlans=new WeakMap<Text,{tree:ReturnType<typeof outlineTree>;ranges:readonly HeadingFold[]}>();

/** Use the Markdown parser so code blocks and frontmatter never become headings. */
export function headingFolds(state:EditorState):readonly HeadingFold[]{
  const tree=outlineTree(state),cached=headingPlans.get(state.doc);
  if(cached?.tree===tree)return cached.ranges;
  const headings:{lineFrom:number; end:number; level:number}[]=[];
  const cursor=tree.cursor();
  do {
    const match=/^(?:ATX|Setext)Heading([1-6])$/.exec(cursor.name);
    if(match){const line=state.doc.lineAt(cursor.from),end=state.doc.lineAt(Math.max(cursor.from,cursor.to-1));headings.push({lineFrom:line.from,end:end.to,level:Number(match[1])});}
  } while(cursor.next());
  const result:HeadingFold[]=[], stack:typeof headings=[];
  for(let index=headings.length-1;index>=0;index--){
    const heading=headings[index];while(stack.length&&stack[stack.length-1].level>heading.level)stack.pop();
    const next=stack.at(-1),to=next?Math.max(heading.end,next.lineFrom-1):state.doc.length;
    if(to>heading.end)result.push({from:heading.end,to,lineFrom:heading.lineFrom,level:heading.level});stack.push(heading);
  }
  const ranges=result.reverse();
  headingPlans.set(state.doc,{tree,ranges});
  return ranges;
}
export function foldingEffects(state:EditorState){
  const effects:StateEffect<unknown>[]=[];
  foldedRanges(state).between(0,state.doc.length,(from,to)=>{effects.push(foldEffect.of({from,to}));});
  return effects;
}
export function isFoldingEffect(effect:StateEffect<unknown>){return effect.is(foldEffect)||effect.is(unfoldEffect);}
class FoldButton extends WidgetType {
  constructor(readonly range:HeadingFold,readonly folded:boolean){super();}
  eq(other:FoldButton){return this.range.from===other.range.from&&this.range.to===other.range.to&&this.folded===other.folded;}
  toDOM(view:EditorView){
    const document=view.dom.ownerDocument;
    const button=document.createElement('button');button.type='button';button.className='cm-heading-fold';
    button.append(createUiIcon(document,this.folded?'disclosure.expand':'disclosure.collapse',12));button.setAttribute('aria-label',this.folded?'展开标题内容':'折叠标题内容');button.title=button.getAttribute('aria-label')!;
    button.addEventListener('mousedown',event=>event.preventDefault());
    button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();view.dispatch({effects:(this.folded?unfoldEffect:foldEffect).of({from:this.range.from,to:this.range.to})});});
    return button;
  }
  ignoreEvent(){return false;}
}
function firstHeadingAtOrAfter(headings:readonly HeadingFold[],position:number){
  let start=0,end=headings.length;
  while(start<end){
    const middle=start+Math.floor((end-start)/2);
    if(headings[middle].lineFrom<position)start=middle+1;
    else end=middle;
  }
  return start;
}

function decorations(view:EditorView):DecorationSet{
  const headings=headingFolds(view.state),folds=foldedRanges(view.state);
  const ranges=[];
  let next=0;
  for(const visible of view.visibleRanges){
    next=Math.max(next,firstHeadingAtOrAfter(headings,visible.from));
    const first=headings[next];
    if(!first||first.lineFrom>visible.to)continue;
    const fold=folds.iter(first.from);
    for(;next<headings.length&&headings[next].lineFrom<=visible.to;next++){
      const heading=headings[next];
      while(fold.value&&fold.from<heading.from)fold.next();
      const folded=!!fold.value&&fold.from===heading.from;
      const range=folded?{...heading,to:fold.to}:heading;
      ranges.push(Decoration.widget({widget:new FoldButton(range,folded),side:-1}).range(range.lineFrom));
    }
  }
  return Decoration.set(ranges,true);
}
export const foldingMarker=StateField.define({create:()=>true,update:value=>value});
export const headingFolding:Extension=[foldingMarker,codeFolding(),ViewPlugin.fromClass(class {
  decorations:DecorationSet;
  constructor(view:EditorView){this.decorations=decorations(view);}
  update(update:import('@codemirror/view').ViewUpdate){if(update.docChanged||update.viewportChanged||update.transactions.some(tr=>tr.effects.some(isFoldingEffect)))this.decorations=decorations(update.view);}
},{decorations:value=>value.decorations})];

