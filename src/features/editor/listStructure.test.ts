import {history,undo} from '@codemirror/commands';
import {EditorSelection,EditorState,type Transaction} from '@codemirror/state';
import {describe,expect,it} from 'vitest';
import {indentMarkdownList} from './listStructure';
import {markdownParseState,markdownTree} from './markdownParse';
import {previewPlan} from './markdownPresentation';

function editor(doc:string,anchor:string){
  let state=EditorState.create({doc,selection:{anchor:doc.indexOf(anchor)},extensions:[history(),markdownParseState]});
  return {
    get state(){return state;},
    select(anchor:number,head:number){state=state.update({selection:EditorSelection.range(anchor,head)}).state;},
    dispatch(tr:Transaction){state=tr.state;},
  };
}

function marks(state:EditorState){
  const result:{raw:string;parent:string|null}[]=[];
  markdownTree(state).iterate({enter(ref){
    if(ref.name!=='ListMark')return;
    let parent=ref.node.parent?.parent??null;
    while(parent&&parent.name!=='ListItem')parent=parent.parent;
    const marker=parent?.getChild('ListMark');
    result.push({raw:state.sliceDoc(ref.from,ref.to),parent:marker?state.sliceDoc(marker.from,marker.to):null});
  }});
  return result;
}

describe('Tab in live Markdown lists',()=>{
  it('moves a numbered item after a sibling with no separating blank line, including its explicit continuation and nested item',()=>{
    const source='1. first\n2. target and wrapped body\n   continuation\n   - child\n3. next';
    const expected='1. first\n   2. target and wrapped body\n      continuation\n      - child\n3. next';
    const view=editor(source,'target');
    const position=view.state.selection.main.head;
    expect(indentMarkdownList(view)).toBe(true);
    expect(view.state.sliceDoc()).toBe(expected);
    expect(view.state.selection.main.head).toBe(position+3);
    expect(marks(view.state)).toEqual([
      {raw:'1.',parent:null},{raw:'2.',parent:'1.'},{raw:'-',parent:'2.'},{raw:'3.',parent:null},
    ]);
    expect(undo(view)).toBe(true);
    expect(view.state.sliceDoc()).toBe(source);
  });

  it('uses the predecessor’s actual content column and shifts a group of selected siblings once',()=>{
    const source='12. parent\n8.   first selected\n     first continuation\n9. second selected\n10. untouched';
    const view=editor(source,'first selected');
    view.select(source.indexOf('10. untouched'),source.indexOf('8.   first'));
    expect(indentMarkdownList(view)).toBe(true);
    expect(view.state.sliceDoc()).toBe('12. parent\n    8.   first selected\n         first continuation\n    9. second selected\n10. untouched');
    expect(view.state.selection.main.anchor).toBeGreaterThan(view.state.selection.main.head);
    expect(marks(view.state)).toEqual([
      {raw:'12.',parent:null},{raw:'8.',parent:'12.'},{raw:'9.',parent:'12.'},{raw:'10.',parent:null},
    ]);
  });

  it('moves the first item visually within CommonMark’s legal indentation and keeps all descendants',()=>{
    const source='1. first\n   continuation\n   - child\n2. next';
    const view=editor(source,'first');
    expect(indentMarkdownList(view)).toBe(true);
    expect(view.state.sliceDoc()).toBe('  1. first\n     continuation\n     - child\n2. next');
    expect(marks(view.state)).toEqual([{raw:'1.',parent:null},{raw:'-',parent:'1.'},{raw:'2.',parent:null}]);
    const lines=previewPlan(view.state).styles.filter(style=>style.list);
    expect(lines.map(style=>style.list!.offset)).toEqual([2,2,2,0]);
    expect(indentMarkdownList(view)).toBe(true);
    expect(view.state.sliceDoc()).toBe('   1. first\n      continuation\n      - child\n2. next');
    const legal=view.state.doc;
    expect(indentMarkdownList(view)).toBe(true);
    expect(view.state.doc).toBe(legal);
  });

  it('keeps a quote prefix and reparses nested ordered markers and their continuation as a single child item',()=>{
    const source='> 7. parent\n> 8. target\n>    continuation\n> 9. next';
    const view=editor(source,'continuation');
    expect(indentMarkdownList(view)).toBe(true);
    expect(view.state.sliceDoc()).toBe('> 7. parent\n>    8. target\n>       continuation\n> 9. next');
    expect(marks(view.state)).toEqual([{raw:'7.',parent:null},{raw:'8.',parent:'7.'},{raw:'9.',parent:null}]);
  });

  it('leaves plain, mixed and code-body input to the standard editor command',()=>{
    const source='1. first\n2. second\n   ```js\n   code\n   ```\n\nplain';
    const view=editor(source,'code');
    expect(indentMarkdownList(view)).toBe(false);
    view.select(0,source.length);
    expect(indentMarkdownList(view)).toBe(false);
    view.select(source.indexOf('plain'),source.indexOf('plain'));
    expect(indentMarkdownList(view)).toBe(false);
    expect(view.state.sliceDoc()).toBe(source);
    view.select(source.indexOf('second'),source.indexOf('second'));
    expect(indentMarkdownList(view)).toBe(true);
    expect(view.state.sliceDoc()).toBe('1. first\n   2. second\n      ```js\n      code\n      ```\n\nplain');
  });
});
