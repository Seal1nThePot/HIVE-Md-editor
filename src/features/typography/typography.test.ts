import {describe,it,expect,vi} from 'vitest';
import {EditorState,EditorSelection,RangeSet,Transaction} from '@codemirror/state';
import {history,undo,redo} from '@codemirror/commands';
import {markdownDisplayExtensions,markdownPreview,setDisplayMode} from '../editor/markdownDisplay';
import {previewPlan} from '../editor/markdownPresentation';
import {headings} from '../../shared/core';
import {defaultTypography,normalizeTypography,applyTypographyPreset,isTypographyCustomized} from './typographyPreferences';
import {typographyUpdateQueue} from './typographyUpdateQueue';
import {headingTypography} from './typographyTheme';
import {makeState} from '../editor/Editor';
import {highlightingFor} from '@codemirror/language';
import {tags} from '@lezer/highlight';

const create=(doc:string)=>EditorState.create({doc,extensions:[markdownDisplayExtensions,history(),EditorState.allowMultipleSelections.of(true)]});
const paragraphs=(state:EditorState)=>previewPlan(state).styles.filter(style=>style.className?.startsWith('cm-typography-'));
// CodeMirror's content builder consumes RangeSet.spans, which excludes line
// decorations covered by a replacement's inclusive endpoint. Raw .between()
// alone cannot prove that a line decoration reaches the rendered DOM.
const renderedLineClasses=(state:EditorState)=>{
  const classes:{from:number;className:string}[]=[];
  RangeSet.spans([state.field(markdownPreview)],0,state.doc.length,{span(){},point(from,_to,value){if(value.spec.class)classes.push({from,className:value.spec.class});}});
  return classes;
};
describe('typography display preferences',()=>{
  it('keeps legacy defaults and validates corrupt, missing and out-of-range records',()=>{
    for(const input of [null,{},[],{version:2}])expect(normalizeTypography(input)).toEqual(defaultTypography);
    expect(defaultTypography).toMatchObject({maxWidth:780,lineHeight:2.05,paragraphSpacing:0,firstLineIndent:false});
    expect(normalizeTypography({version:1,preset:'novel',maxWidth:Infinity,lineHeight:-2,paragraphSpacing:9,firstLineIndent:'true'})).toEqual({...applyTypographyPreset('novel'),lineHeight:1.2,paragraphSpacing:2});
    expect(normalizeTypography({version:1,preset:'__proto__'}).preset).toBe('original');
  });
  it('defaults legacy tables to compact and preserves independent density through prose presets',()=>{
    expect(normalizeTypography({version:1}).tableDensity).toBe('compact');
    expect(normalizeTypography({version:1,tableDensity:'standard'}).tableDensity).toBe('standard');
    expect(applyTypographyPreset('novel','standard').tableDensity).toBe('standard');
  });
  it('supports customizing and restoring each complete preset independently',()=>{
    for(const preset of ['original','novel','brief','article'] as const){const base=applyTypographyPreset(preset);expect(isTypographyCustomized(base)).toBe(false);expect(isTypographyCustomized({...base,maxWidth:base.maxWidth+10})).toBe(true);expect(applyTypographyPreset(preset)).toEqual(base);}
  });
});
describe('semantic paragraph typography',()=>{
  it('adds spacing once at the paragraph end and indents only the first source line',()=>{
    const state=create('第一行，屏幕可以多次折行\n同一语义段的软换行\n第三行。\n\n下一个段落。'),styles=paragraphs(state);
    expect(styles).toHaveLength(4);
    expect(styles.filter(style=>style.className?.includes('paragraph-end')).map(style=>state.doc.lineAt(style.from).number)).toEqual([3,5]);
    expect(styles.filter(style=>style.className?.includes('indentable')).map(style=>state.doc.lineAt(style.from).number)).toEqual([1,5]);
    expect(styles.filter(style=>style.className?.includes('typography-prose')).map(style=>state.doc.lineAt(style.from).number)).toEqual([1,2,3,5]);
  });
  it('respects metadata, headings, code, GFM tables, list/quote nesting and display math boundaries',()=>{
    const text='---\ntitle: 元数据\n---\n\n# 一级\n\n正文。\n\n```md\n代码\n```\n\n| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |\n\n- 列表\n\n> 引用\n\n$$\nx+y\n$$\n\n后文。';
    const state=create(text),styles=paragraphs(state);
    expect(styles.filter(style=>style.className?.includes('indentable')).map(style=>state.doc.lineAt(style.from).text)).toEqual(['正文。','后文。']);
    expect(styles.map(style=>state.doc.lineAt(style.from).text)).toEqual(['正文。','- 列表','> 引用','后文。']);
    expect(styles.filter(style=>style.className?.includes('typography-prose')).map(style=>state.doc.lineAt(style.from).text)).toEqual(['正文。','后文。']);
  });
  it('keeps inline math in prose but never indents image-only display blocks',()=>{
    const state=create('带有 $x$ 的正文。\n\n![图片](image.png)\n\n$$x+y$$');
    expect(paragraphs(state).filter(style=>style.className?.includes('indentable')).map(style=>state.doc.lineAt(style.from).text)).toEqual(['带有 $x$ 的正文。']);
    for(const text of ['$$\n尚未闭合','$$malformed'])expect(paragraphs(create(text))).toEqual([]);
  });
  it('keeps every source line of ordinary prose marked in the rendered view without altering source mode',()=>{
    const text='中 English 123，第一行继续折行。\n第二行含 https://example.com/long-path。\n第三行。',state=create(text);
    const classes=renderedLineClasses(state);
    expect(classes.filter(item=>item.className.includes('cm-typography-prose')).map(item=>state.doc.lineAt(item.from).number)).toEqual([1,2,3]);
    const source=state.update({effects:setDisplayMode.of('source')}).state;
    expect(source.sliceDoc()).toBe(text);expect(source.field(markdownPreview).size).toBe(0);
  });
  it('renders the same inline code style for long technical paths and ordinary names after editing',()=>{
    const technicalPath='markdownPresentation/formatting';
    const text=`文字 \`${technicalPath}\` 与 \`international\`。\n\n- \`${technicalPath}\``;
    let state=create(text);
    const inlineCode=()=>previewPlan(state).styles.filter(style=>style.className==='cm-preview-inline-code').map(style=>state.sliceDoc(style.from,style.to));
    expect(inlineCode()).toEqual([technicalPath,'international',technicalPath]);
    const edited=text.indexOf('/formatting');
    state=state.update({changes:{from:edited,to:edited+'/formatting'.length,insert:'/editor'}}).state;
    expect(inlineCode()).toEqual(['markdownPresentation/editor','international',technicalPath]);
    state=state.update({effects:setDisplayMode.of('source')}).state;
    expect(state.field(markdownPreview).size).toBe(0);
    expect(state.sliceDoc()).toBe(text.replace('/formatting','/editor'));
  });
  it('switches display modes repeatedly without accumulating spacing, changing text or losing undo/selections',()=>{
    let state=create('第一段。\n\n第二段。');state=state.update({changes:{from:4,insert:'新增'},selection:EditorSelection.create([EditorSelection.range(1,3),EditorSelection.cursor(10)]),userEvent:'input.type'}).state;
    const source=state.doc,selection=state.selection,plan=previewPlan(state),size=state.field(markdownPreview).size,read=vi.spyOn(source,'toString');
    for(let n=0;n<6;n++){
      state=state.update({effects:setDisplayMode.of('source'),annotations:Transaction.addToHistory.of(false)}).state;expect(state.field(markdownPreview).size).toBe(0);
      state=state.update({effects:setDisplayMode.of('live'),annotations:Transaction.addToHistory.of(false)}).state;expect(state.field(markdownPreview).size).toBe(size);
    }
    expect(state.doc).toBe(source);expect(state.selection).toEqual(selection);expect(previewPlan(state)).toBe(plan);expect(read).not.toHaveBeenCalled();
    const dispatch=(tr:Transaction)=>{state=tr.state;};expect(undo({state,dispatch})).toBe(true);expect(state.sliceDoc()).toBe('第一段。\n\n第二段。');expect(redo({state,dispatch})).toBe(true);expect(state.doc.eq(source)).toBe(true);
  });
  it('gives H1–H6 distinct display sizes while preserving exact TOC hierarchy, including Setext',()=>{
    const state=create('# 一\n\n## 二\n\n### 三\n\n#### 四\n\n##### 五\n\n###### 六\n\nSetext\n---');
    expect(new Set(headingTypography.map(style=>style.fontSize)).size).toBe(6);
    expect(headings(state).map(heading=>heading.level)).toEqual([1,2,3,4,5,6,2]);
    expect(previewPlan(state).styles.filter(style=>style.className?.startsWith('cm-preview-h')).map(style=>style.className)).toEqual(['cm-preview-h1','cm-preview-h2','cm-preview-h3','cm-preview-h4','cm-preview-h5','cm-preview-h6','cm-preview-h2','cm-preview-h2']);
    const source=makeState(state.doc,()=>{},undefined,'source');
    expect([tags.heading1,tags.heading2,tags.heading3,tags.heading4,tags.heading5,tags.heading6].map(tag=>highlightingFor(source,[tag]))).toEqual(['cm-markdown-h1','cm-markdown-h2','cm-markdown-h3','cm-markdown-h4','cm-markdown-h5','cm-markdown-h6']);
    expect(source.field(markdownPreview).size).toBe(0);expect(headings(source)).toEqual(headings(state));
  });
  it('preserves rendered heading and paragraph line classes immediately after hidden source blocks',()=>{
    for(const prefix of ['---\ntitle: 测试\n---\n','\uFEFF---\ntitle: 测试\n...\n','~~~md\n代码\n~~~\n','[ref]: /example\n']){
      const state=create(prefix+'# 一级\n\n## 二级'),classes=renderedLineClasses(state);
      expect(classes).toEqual(expect.arrayContaining([{from:prefix.length,className:'cm-preview-h1'}]));
      expect(headings(state).map(heading=>heading.level)).toEqual([1,2]);
      const source=state.update({effects:setDisplayMode.of('source')}).state,live=source.update({effects:setDisplayMode.of('live')}).state;
      expect(renderedLineClasses(live)).toEqual(classes);expect(live.doc).toBe(state.doc);
    }
    const prefix='---\ntitle: 测试\n---\n',state=create(prefix+'普通段落。');
    expect(renderedLineClasses(state).find(style=>style.from===prefix.length)?.className).toContain('cm-typography-indentable');
    const setext=create('标题\n---\n紧接的普通段落。');
    expect(renderedLineClasses(setext).find(style=>style.from===7)?.className).toContain('cm-typography-indentable');
  });
  it('leaves table and math block rendering on their existing independent replacement boundaries',()=>{
    const text='| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |\n# 表后标题\n\n$$x+y$$\n# 公式后标题',state=create(text),classes=renderedLineClasses(state),widgets:string[]=[];
    state.field(markdownPreview).between(0,state.doc.length,(_from,_to,value)=>{if(value.spec.widget)widgets.push(value.spec.widget.constructor.name);});
    expect(widgets).toEqual(['TableWidget','MathWidget']);
    expect(classes.filter(style=>style.className==='cm-preview-h1').map(style=>state.doc.lineAt(style.from).text)).toEqual(['# 表后标题','# 公式后标题']);
    expect(state.sliceDoc()).toBe(text);
  });
  it('does not expand the entire document or rebuild its cached plan on selection-only updates',()=>{
    const state=create(('正文第一行\n软换行\n\n').repeat(2000)),plan=previewPlan(state),read=vi.spyOn(state.doc,'toString');
    for(let n=0;n<20;n++){const moved=state.update({selection:{anchor:n}}).state;expect(previewPlan(moved)).toBe(plan);}
    expect(read).not.toHaveBeenCalled();
  });
});
describe('composition-safe typography updates',()=>{
  function setup(){let composing=false,next=0;const callbacks=new Map<number,()=>void>(),apply=vi.fn();const queue=typographyUpdateQueue<number>({composing:()=>composing,schedule:callback=>{callbacks.set(++next,callback);return next;},cancel:id=>{callbacks.delete(id as number);},apply});return {queue,apply,callbacks,setComposing(value:boolean){composing=value;},flush(){for(const [id,callback] of callbacks){callbacks.delete(id);callback();}}};}
  it('coalesces rapid settings changes and waits for the end of IME composition',()=>{
    const t=setup();t.queue.request(1);t.queue.request(2);expect(t.callbacks.size).toBe(1);t.setComposing(true);t.flush();expect(t.apply).not.toHaveBeenCalled();t.queue.request(3);t.queue.released();expect(t.callbacks.size).toBe(0);t.setComposing(false);t.queue.released();t.flush();expect(t.apply).toHaveBeenCalledExactlyOnceWith(3);
  });
  it('cancels a pending update when a view sleeps or is disposed',()=>{const t=setup();t.queue.request(1);t.queue.dispose();t.flush();t.queue.request(2);t.queue.released();expect(t.apply).not.toHaveBeenCalled();expect(t.callbacks.size).toBe(0);});
});
