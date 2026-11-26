import {describe,it,expect} from 'vitest';
import {EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {history,undo} from '@codemirror/commands';
import {markdownDisplayExtensions,displayModeField,finishPreviewPointer,markdownPreview,setDisplayMode,setPreviewFocus} from './markdownDisplay';
import {previewPlan,visibleReplacements} from './markdownPresentation';
import {MathWidget} from './mathWidget';
import {detailsBlocks} from './detailsBlocks';
import {visibleCount} from '../../shared/core';

const create=(doc:string)=>EditorState.create({doc,extensions:markdownDisplayExtensions});
const hidden=(state:EditorState,focused=false)=>visibleReplacements(state,focused).map(item=>state.sliceDoc(item.from,item.to));
describe('live Markdown display',()=>{
  it('ignores fold markup inside fences and treats real details bodies as block replacements',()=>{
    const block='<details>\n<summary>标题</summary>\n\n**折叠正文**\n\n</details>';
    const state=create('```md\n'+block+'\n```\n\n'+block+'\n\n结尾');
    const [details]=detailsBlocks(state);
    expect(detailsBlocks(state)).toHaveLength(1);
    expect(details.from).toBe(state.sliceDoc().lastIndexOf('<details>'));
    let collapsed=false;
    state.field(markdownPreview).between(details.from,details.to,(from,to,decoration)=>{
      if(from===details.from&&to===details.to&&decoration.spec.widget?.expanded===false)collapsed=true;
    });
    expect(collapsed).toBe(true);
    expect(state.update({effects:setDisplayMode.of('source')}).state.field(markdownPreview).size).toBe(0);
  });
  it('renders stored highlights without executing markup or decorating inline code',()=>{
    const state=create('一段 <mark>高亮文字</mark>。与 `<mark>代码</mark>`。');
    expect(hidden(state)).toEqual(expect.arrayContaining(['<mark>','</mark>']));
    expect(previewPlan(state).styles.filter(style=>style.className==='cm-format-highlight').map(style=>state.sliceDoc(style.from,style.to))).toEqual(['高亮文字']);
  });
  it('defaults to rendered text with Markdown markers hidden without changing the source',()=>{
    const doc='# 标题\n\n**粗体** 和 *斜体*、~~删除线~~、`代码`。',state=create(doc);
    expect(state.field(displayModeField)).toBe('live');expect(state.doc.toString()).toBe(doc);
    const text=hidden(state);expect(text).toContain('# ');expect(text.filter(value=>value==='**')).toHaveLength(2);expect(text.filter(value=>value==='~~')).toHaveLength(2);expect(text.filter(value=>value==='`')).toHaveLength(2);
    expect(previewPlan(state).styles.map(style=>style.className)).toEqual(expect.arrayContaining(['cm-preview-h1','cm-preview-strong','cm-preview-emphasis','cm-preview-strike','cm-preview-inline-code']));
  });
  it('joins code with closing punctuation and retains its last grapheme when it wraps',()=>{
    const state=create('字段 `P_cache_read`、链接 [维护记录](docs.md)。');
    const joins=previewPlan(state).punctuation.map(range=>[state.sliceDoc(range.from,range.to),!!range.codeGroup]);
    expect(joins).toEqual([['P_cache_read`、',true],['d`、',false],['录](docs.md)。',false]]);
  });
  it('reveals only the edited line while keeping its formatting effects and other lines rendered',()=>{
    let state=create('# 标题\n\n**当前文字**\n\n## 另一标题');
    state=state.update({effects:setPreviewFocus.of(true),selection:{anchor:10}}).state;
    expect(hidden(state,true)).not.toContain('**');expect(hidden(state,true)).toEqual(expect.arrayContaining(['# ','## ']));
    expect(previewPlan(state).styles.some(style=>style.className==='cm-preview-strong')).toBe(true);
    state=state.update({selection:{anchor:0}}).state;
    expect(hidden(state,true)).not.toContain('# ');expect(hidden(state,true).filter(value=>value==='**')).toHaveLength(2);
  });
  it('hides the current line markers again on blur',()=>{
    let state=create('**文字**');state=state.update({effects:setPreviewFocus.of(true)}).state;
    const inlineCount=(state:EditorState)=>{let count=0;state.field(markdownPreview).between(0,state.doc.length,(_from,_to,decoration)=>{if(!decoration.spec.class?.startsWith('cm-typography-'))count++;});return count;};
    expect(inlineCount(state)).toBe(1);
    state=state.update({effects:setPreviewFocus.of(false)}).state;expect(inlineCount(state)).toBe(3);
  });
  it('switches to all-source mode and back without changing the text or selection',()=>{
    const initial=create('# 标题\n\n<u>文字</u>'),source=initial.update({effects:setDisplayMode.of('source')});
    expect(source.state.field(markdownPreview).size).toBe(0);expect(source.docChanged).toBe(false);expect(source.newSelection).toEqual(initial.selection);
    const live=source.state.update({effects:setDisplayMode.of('live')}).state;expect(live.field(markdownPreview).size).toBeGreaterThan(0);expect(live.doc.eq(initial.doc)).toBe(true);
  });
  it('keeps pointer coordinates stable across a drag over formatted lines',()=>{
    const doc='# 标题\n\n以及**"AI 建议先审阅"**的闭环\n\n后文';
    let state=create(doc);
    const initial=state.field(markdownPreview);
    state=state.update({selection:{anchor:doc.indexOf('建议')},userEvent:'select.pointer'}).state;
    expect(state.field(markdownPreview)).toBe(initial);
    state=state.update({selection:{anchor:doc.indexOf('建议'),head:doc.indexOf('后文')},userEvent:'select.pointer'}).state;
    expect(state.field(markdownPreview)).toBe(initial);
    state=state.update({selection:{anchor:doc.indexOf('建议')},userEvent:'select.keyboard'}).state;
    expect(state.field(markdownPreview)).not.toBe(initial);
    expect(state.sliceDoc()).toBe(doc);
  });
  it('restores list bullets and strong markers immediately when the mouse selection finishes',()=>{
    const doc='- 第一项\n- 第二项\n\n**粗体**\n\n普通段落';
    const marker=(state:EditorState,from:number,to:number)=>{
      let hidden=false;
      state.field(markdownPreview).between(from,to,(start,end,decoration)=>{
        if(start===from&&end===to&&decoration.point)hidden=true;
      });
      return hidden;
    };
    const bullet=doc.indexOf('- 第二项'),strong=doc.indexOf('**'),ordinary=doc.indexOf('普通段落');
    let state=create(doc).update({effects:setPreviewFocus.of(true),selection:{anchor:bullet+2}}).state;
    expect(marker(state,bullet,bullet+2)).toBe(false);
    const before=state.field(markdownPreview);
    state=state.update({selection:{anchor:strong+2},userEvent:'select.pointer'}).state;
    expect(state.field(markdownPreview)).toBe(before);
    state=state.update({effects:finishPreviewPointer.of(null)}).state;
    expect(marker(state,bullet,bullet+2)).toBe(true);
    expect(marker(state,strong,strong+2)).toBe(false);
    state=state.update({selection:{anchor:ordinary},userEvent:'select.pointer'}).state;
    state=state.update({effects:finishPreviewPointer.of(null)}).state;
    expect(marker(state,strong,strong+2)).toBe(true);
    const after=state.field(markdownPreview);
    expect(state.update({effects:finishPreviewPointer.of(null)}).state.field(markdownPreview)).toBe(after);
    expect(state.update({}).state.field(markdownPreview)).toBe(after);
  });
  it('updates the math source only after mouse release and uses the actual selection range',()=>{
    const doc='$$\n\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}\n$$\n\n$x^2$ followed by ordinary text';
    let state=create(doc);
    const formulas=()=>{
      const rendered=[] as string[];
      state.field(markdownPreview).between(0,state.doc.length,(from,to,decoration)=>{
        if(decoration.spec.widget instanceof MathWidget)rendered.push(state.sliceDoc(from,to));
      });
      return rendered;
    };
    for(const raw of [doc.slice(0,doc.indexOf('\n\n')),'$x^2$']){
      const from=doc.indexOf(raw),to=from+raw.length;
      state=state.update({selection:{anchor:from},userEvent:'select.widget'}).state;
      expect(formulas()).not.toContain(raw);
      state=state.update({selection:{anchor:to-1,head:from+1},userEvent:'select.pointer'}).state;
      state=state.update({effects:finishPreviewPointer.of(null)}).state;
      expect(formulas()).not.toContain(raw);
      const before=state.field(markdownPreview),outside=doc.indexOf('ordinary');
      state=state.update({selection:{anchor:outside,head:outside+8},userEvent:'select.pointer'}).state;
      expect(state.field(markdownPreview)).toBe(before);
      state=state.update({effects:finishPreviewPointer.of(null)}).state;
      expect(formulas()).toContain(raw);
      expect(state.sliceDoc(state.selection.main.from,state.selection.main.to)).toBe('ordinary');
    }
    expect(state.doc.toString()).toBe(doc);
  });
  it('makes preview read-only with no revealed markup, preserving normal history and synchronization',()=>{
    const doc='**正文**';
    let state=EditorState.create({doc,extensions:[history(),markdownDisplayExtensions]});
    state=state.update({changes:{from:4,insert:'修改'},userEvent:'input.type'}).state;
    const edited=state.doc;
    state=state.update({effects:[setDisplayMode.of('preview'),setPreviewFocus.of(true)],selection:{anchor:3}}).state;
    expect(state.readOnly).toBe(true);
    expect(state.facet(EditorView.editable)).toBe(false);
    const view={get state(){return state;},dispatch(tr:ReturnType<EditorState['update']>){state=tr.state;}};
    expect(undo(view)).toBe(false);
    const preview=state.field(markdownPreview);
    state=state.update({selection:{anchor:5},userEvent:'select.keyboard'}).state;
    expect(state.field(markdownPreview)).toBe(preview);
    for(const userEvent of ['input.type','input.paste','input.task','input.table','input.ai.preview',undefined]){
      expect(state.update({changes:{from:2,insert:'不允许'},userEvent}).state.doc).toBe(edited);
    }
    for(const userEvent of ['input.shared-document','input.disk-sync']){
      expect(state.update({changes:{from:2,insert:'同步'},userEvent}).state.sliceDoc()).toContain('同步正文');
    }
    state=state.update({effects:setDisplayMode.of('live')}).state;
    expect(state.readOnly).toBe(false);
    expect(state.facet(EditorView.editable)).toBe(true);
    expect(undo(view)).toBe(true);
    expect(state.sliceDoc()).toBe(doc);
  });
  it('renders CJK-adjacent quoted bold and preserves ordinary bold, escaped syntax, and code',()=>{
    const doc='以及**"AI 建议先审阅"**的闭环，此外**「写作」**可撤回。\n\n**普通**"引号" 与 \\**"转义"**。\n\n`**"代码"**`';
    const state=create(doc);
    expect(previewPlan(state).styles.filter(style=>style.className==='cm-preview-strong').map(style=>state.sliceDoc(style.from,style.to))).toEqual(['"AI 建议先审阅"','「写作」','普通']);
    expect(hidden(state).filter(marker=>marker==='**')).toHaveLength(6);
    expect(state.sliceDoc()).toBe(doc);
  });
  it('decorates list item starts and continuations according to their AST nesting depth',()=>{
    const doc='- 根项\n  续行\n  - 子项\n    续行\n    - 末层\n  - [x] 任务\n\n正文';
    const state=create(doc);
    const list=previewPlan(state).styles.filter(style=>style.list);
    expect(list.map(style=>[state.doc.lineAt(style.from).number,style.list!.depth,style.className!.includes('cm-preview-list-first')]).sort((a,b)=>Number(a[0])-Number(b[0]))).toEqual([[1,0,true],[2,0,false],[3,1,true],[4,1,false],[5,2,true],[6,1,true]]);
    expect(previewPlan(state).replacements.filter(item=>item.kind==='bullet').map(item=>item.text)).toEqual(['•','◦','▪']);
    expect(state.update({effects:setDisplayMode.of('source')}).state.field(markdownPreview).size).toBe(0);
  });
  it('renumbers each ordered sibling group from its source start without altering surviving Markdown or undo',()=>{
    const doc='9. root A\n   4) child A\n   9) child B\n70. root B\n99. root C';
    let state=EditorState.create({doc,extensions:[history(),markdownDisplayExtensions]});
    const labels=()=>previewPlan(state).replacements.filter(item=>item.kind==='bullet').map(item=>item.text);
    expect(labels()).toEqual(['9.','4)','5)','10.','11.']);
    const from=doc.indexOf('70.'),to=doc.indexOf('99.');
    state=state.update({changes:{from,to},selection:{anchor:from},effects:setPreviewFocus.of(true),userEvent:'delete.backward'}).state;
    expect(labels()).toEqual(['9.','4)','5)','10.']);
    expect(state.sliceDoc()).toBe(doc.slice(0,from)+doc.slice(to));
    expect(visibleReplacements(state,true).find(item=>item.from===from)?.text).toBe('10.');
    expect(state.update({effects:setDisplayMode.of('preview')}).state.sliceDoc()).toBe(state.sliceDoc());
    expect(state.update({effects:setDisplayMode.of('source')}).state.field(markdownPreview).size).toBe(0);
    expect(undo({get state(){return state;},dispatch(tr){state=tr.state;}})).toBe(true);
    expect(state.sliceDoc()).toBe(doc);
    expect(labels()).toEqual(['9.','4)','5)','10.','11.']);
  });

  it('reserves one hanging column through 9 and 10 and through editable source marker reveal',()=>{
    const doc='9. first body\n1. second body\n   explicit continuation';
    const first=create(doc),from=doc.indexOf('1.');
    const readLineStyles=(state:EditorState)=>{
      const styles:string[]=[];
      state.field(markdownPreview).between(0,doc.length,(_from,_to,decoration)=>{
        if(decoration.spec.class?.includes('cm-preview-list-line'))styles.push(decoration.spec.attributes.style);
      });
      return styles;
    };
    const stable=readLineStyles(first);
    expect(new Set(stable).size).toBe(1);
    expect(stable[0]).toContain('4ch');
    let state=first.update({effects:setPreviewFocus.of(true),selection:{anchor:from+4,head:doc.length}}).state;
    expect(visibleReplacements(state,true).find(item=>item.from===from)?.text).toBe('10.');
    expect(readLineStyles(state)).toEqual(stable);
    const prior=state.field(markdownPreview);
    state=state.update({selection:{anchor:from+1}}).state;
    expect(state.field(markdownPreview)).not.toBe(prior);
    expect(visibleReplacements(state,true).some(item=>item.from===from)).toBe(false);
    expect(readLineStyles(state)).toEqual(stable);
    let exposedMarker='';
    state.field(markdownPreview).between(from,from+3,(start,end,decoration)=>{
      if(decoration.spec.class==='cm-preview-list-source-marker')exposedMarker=state.sliceDoc(start,end);
    });
    expect(exposedMarker).toBe('1. ');
  });
  it('renders literal fenced code in an independent block and reveals its complete source for editing',()=>{
    const source='```md\n# 这是代码\n**照原样显示**\n```';
    const state=create(source);
    const block=previewPlan(state).replacements.find(item=>item.kind==='code');
    expect(block).toMatchObject({text:'# 这是代码\n**照原样显示**',language:'md',block:true});
    expect(previewPlan(state).styles.some(style=>style.className==='cm-preview-h1')).toBe(false);
    expect(visibleReplacements(state,true).some(item=>item.kind==='code')).toBe(false);
    expect(state.sliceDoc()).toBe(source);
  });
  it('keeps huge fences in the existing virtual line viewport',()=>{
    const source='```ts\n'+'const value=1;\n'.repeat(2000)+'```';
    const state=create(source);
    expect(previewPlan(state).replacements.some(item=>item.kind==='code')).toBe(false);
    expect(previewPlan(state).styles.filter(style=>style.className?.includes('cm-preview-code-line')).length).toBe(2002);
    expect(state.sliceDoc()).toBe(source);
  });
  it('hides HTML underline and alignment markers while preserving their effects',()=>{
    const state=create('<div style="text-align: center;">\n\n<u>正文</u>\n\n</div>');
    expect(hidden(state).join('')).toContain('<div style="text-align: center;">');expect(hidden(state).join('')).toContain('</div>');
    const styles=previewPlan(state).styles;expect(styles.some(style=>style.align==='center')).toBe(true);expect(styles.some(style=>style.className==='cm-format-underline')).toBe(true);
    const items=visibleReplacements(state,false);for(let index=1;index<items.length;index++)expect(items[index].from).toBeGreaterThanOrEqual(items[index-1].to);
  });
  it('renders links, bullet lists, tasks and images without fetching external resources',()=>{
    const state=create('[链接文字](https://example.test)\n\n- 条目\n- [x] 完成\n\n![图片说明](https://example.test/private.png)');
    const items=visibleReplacements(state,false);expect(items.find(item=>item.kind==='bullet')?.text).toBe('•');expect(items.find(item=>item.kind==='task')?.text).toBe('☑');expect(items.find(item=>item.kind==='image')?.text).toBe('图片说明');
    expect(items.some(item=>state.sliceDoc(item.from,item.to)==='](https://example.test)')).toBe(true);
  });
  it('renders a table as cells and keeps it visible when editing a cell',()=>{
    const state=create('| 名称 | 值 |\n| --- | --- |\n| A | B |');
    const table=visibleReplacements(state,false).find(item=>item.kind==='table');expect(table?.rows?.map(row=>row.map(cell=>cell.text))).toEqual([['名称','值'],['A','B']]);
    const editing=state.update({selection:{anchor:30}}).state;expect(visibleReplacements(editing,true).some(item=>item.kind==='table')).toBe(true);
  });
  it('renders horizontal rules and Setext headings without displaying syntax',()=>{
    const state=create('标题\n===\n\n---');expect(hidden(state)).toContain('===\n');expect(visibleReplacements(state,false).some(item=>item.kind==='rule')).toBe(true);
  });
  it('counts displayed GFM text without list, task, strikethrough or table delimiters',()=>{
    expect(visibleCount('~~文字~~')).toBe(2);expect(visibleCount('- [x] 完成')).toBe(2);expect(visibleCount('| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |')).toBe(4);
  });
  it('reuses parsed presentation for cursor movement but invalidates it when text changes',()=>{
    const state=create('# 标题'),plan=previewPlan(state),moved=state.update({selection:{anchor:3}}).state;
    expect(previewPlan(moved)).toBe(plan);const changed=moved.update({changes:{from:4,insert:'新'}}).state;expect(previewPlan(changed)).not.toBe(plan);
  });
});
