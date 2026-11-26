import {describe,it,expect,vi} from 'vitest';
import {EditorState} from '@codemirror/state';
import {previewPlan} from './markdownPresentation';
import {cellContent,decodeCell,encodeCell,encodeCellSource,tableSizeKey,tableRectangle,isTableSourceSelected,selectTableSource} from './tableWidget';
import {markdownDisplayExtensions,markdownPreview} from './markdownDisplay';
import {annotationHighlights,setAnnotationMarks} from '../annotations/annotationDecorations';
import {history,undo,redo} from '@codemirror/commands';
import {tableOperation,type TableAction} from './tableOperations';
import {defaultTableWidths,fitTableWidths,tableSegments} from './tableViewport';

describe('table source editing',()=>{
  it('normalizes a rectangular drag in either direction',()=>{expect(tableRectangle({row:4,col:3},{row:1,col:0})).toEqual({top:1,bottom:4,left:0,right:3});});
  it('round trips pipes, backslashes, and line breaks without creating table syntax',()=>{
    const value='甲 | 乙\\丙\n丁';expect(encodeCell(value)).toBe('甲 \\| 乙\\\\丙<br>丁');expect(decodeCell(encodeCell(value))).toBe(value);
  });
  it('preserves Markdown escapes while protecting raw and adjacent pipe delimiters',()=>{
    expect(encodeCellSource(String.raw`\*x\* | a||b \| c`)).toBe(String.raw`\*x\* \| a\|\|b \| c`);
    expect(encodeCellSource('a\nb')).toBe('a<br>b');
  });
  it('locates only content, preserving padding, separators, and alignment',()=>{
    const doc='| 甲 | 乙 |\n| :--- | ---: |\n|  A  | B |';const state=EditorState.create({doc});const table=previewPlan(state).replacements.find(x=>x.kind==='table')!;const part=cellContent(table.rows![1][0],doc);const next=state.update({changes:{from:part.from,to:part.to,insert:encodeCell('X|Y')}}).state.doc.toString();expect(next).toBe('| 甲 | 乙 |\n| :--- | ---: |\n|  X\\|Y  | B |');
  });
  it('reads only the cell range from a large document, including blank and virtual cells',()=>{
    const prefix='正文'.repeat(50000)+'\n',doc=prefix+'|  A  |   |\n| --- | --- |',state=EditorState.create({doc});
    const table=previewPlan(state).replacements.find(x=>x.kind==='table')!,slice=vi.spyOn(state.doc,'sliceString'),full=vi.spyOn(state.doc,'toString');
    const first=table.rows![0][0],blank=table.rows![0][1];
    expect(cellContent(first,state.doc)).toEqual(cellContent(first,doc));
    expect(cellContent(blank,state.doc)).toEqual(cellContent(blank,doc));
    expect(slice.mock.calls).toEqual([[first.from,first.to],[blank.from,blank.to]]);
    expect(full).not.toHaveBeenCalled();
    slice.mockClear();expect(cellContent({...blank,virtual:1},state.doc).raw).toBe('');expect(slice).not.toHaveBeenCalled();
  });
  it('uses actual parsed table order, independent of horizontal rules',()=>{
    const tables=previewPlan(EditorState.create({doc:'***\n\n| A |\n| --- |\n\n---\n\n| B |\n| --- |'})).replacements.filter(x=>x.kind==='table');
    expect(tables.map(t=>t.tableOrdinal)).toEqual([0,1]);const context={workspace:'workspace',file:'file.md'};expect(tableSizeKey(context,tables[0])).not.toBe(tableSizeKey(context,tables[1]));expect(tableSizeKey({...context,file:'other.md'},tables[0])).not.toBe(tableSizeKey(context,tables[0]));
  });
  it('records the exact Markdown bounds for one complete, segmented table',()=>{
    const row=(text:string)=>`| ${text} | 乙 |`;
    const tableText=[row('甲'), '| --- | --- |',...Array.from({length:44},(_,index)=>row('数据'+index))].join('\n');
    const doc='前文\n\n'+tableText+'\n\n另外一张表\n\n'+tableText+'\n\n后文';
    const state=EditorState.create({doc,extensions:markdownDisplayExtensions});
    const [first,second]=previewPlan(state).replacements.filter(item=>item.kind==='table');
    expect(tableSegments(second,state.doc).length).toBeGreaterThan(1);
    const selected=state.update({selection:{anchor:second.from,head:second.to},userEvent:selectTableSource}).state;
    expect(selected.sliceDoc(selected.selection.main.from,selected.selection.main.to)).toBe(tableText);
    expect(selected.doc).toBe(state.doc);
    expect(isTableSourceSelected(selected,first)).toBe(false);
    expect(isTableSourceSelected(selected,second)).toBe(true);
    const moved=selected.update({selection:{anchor:first.from}}).state;
    expect(isTableSourceSelected(moved,second)).toBe(false);
  });
  it('updates table widget marks when annotation effects change',()=>{
    const doc='| A |\n| --- |',state=EditorState.create({doc,extensions:[annotationHighlights,markdownDisplayExtensions]});const updated=state.update({effects:setAnnotationMarks.of([{id:'id-1',from:2,to:3,note:'note'}])}).state;let marks:unknown;updated.field(markdownPreview).between(0,doc.length,(_from,_to,decoration)=>{const widget=decoration.spec.widget;if(widget?.constructor.name==='TableWidget')marks=(widget as unknown as {marks:unknown}).marks;});expect(marks).toEqual([{id:'id-1',from:2,to:3,note:'note'}]);
  });
  it('locates padded missing cells at the end of their own row',()=>{
    const doc='| A | B | C |\n| --- | --- | --- |\n| x |';const table=previewPlan(EditorState.create({doc})).replacements.find(x=>x.kind==='table')!;expect(table.rows![1]).toHaveLength(3);expect(table.rows![1][1].virtual).toBe(1);expect(table.rows![1][1].from).toBe(doc.length);
  });
});

describe('automatic table widths',()=>{
  it('fills the page while respecting manual widths and readable overflow minima',()=>{
    expect(fitTableWidths([6,12],[null,null],600,16).reduce((a,b)=>a+b,0)).toBeCloseTo(600);
    expect(fitTableWidths([6,12],[120,null],600,16)).toEqual([120,480]);
    expect(fitTableWidths([6,12],[120,240],600,16)).toEqual([120,240]);
    expect(fitTableWidths([6,12],[null,null],80,16)).toEqual([64,96]);
  });
  const longStatus='已完成旧版及 WPF 预检，样本待制作';
  const row=(cells:string[])=>'| '+cells.join(' | ')+' |';
  function parsedTable(headers:string[],data:string[][]){
    const doc=[row(headers),row(headers.map(()=> '---')),...data.map(row)].join('\n');
    const state=EditorState.create({doc});
    const table=previewPlan(state).replacements.find(item=>item.kind==='table')!;
    return {table,doc:state.doc};
  }
  it.each([2,3,4])('caps a single long status in a table with %s data rows',count=>{
    const data=[[longStatus],...Array.from({length:count-1},()=>['待执行'])];
    expect(defaultTableWidths(parsedTable(['状态'],data).table)).toEqual([8]);
  });
  it('keeps the header contribution bounded and allows a sole populated value to guide a column',()=>{
    const headers=['编号','用于查看跨分栏滚动对齐和显示模式的很长说明标题',''];
    expect(defaultTableWidths(parsedTable(headers,[]).table)).toEqual([6,12,6]);
    const {table}=parsedTable(headers,[['R1'],['R2','','此处有较长的可用说明文字需要保留其阅读空间']]);
    expect(defaultTableWidths(table)).toEqual([6,12,20]);
  });
  it('keeps common prose wide and shares narrow status widths across table segments',()=>{
    const headers=['编号','任务','前置','承办人','状态','验收条件'];
    const data=Array.from({length:225},(_,index)=>[
      'R'+index,'核对旧版窗口布局及快捷操作的恢复流程','-','甲',
      index===0||index===224?longStatus:'待执行','在不同宽度和显示模式下确认文本与界面操作的表现',
    ]);
    const {table,doc}=parsedTable(headers,data);
    expect(tableSegments(table,doc).length).toBeGreaterThan(1);
    const widths=defaultTableWidths(table);
    expect(widths).toEqual([6,20,6,6,8,20]);
    expect(defaultTableWidths(table)).toBe(widths);
  });
});

describe('table row and column operations',()=>{
  const source='before\n\n| 甲 \\| 乙 | 路径\\\\目录<br>续 |\n| :--- | ---: |\n|  A  | B |\n| C | D |\n\nafter';
  function change(doc:string,row:number,col:number,action:TableAction){
    const state=EditorState.create({doc}),table=previewPlan(state).replacements.find(x=>x.kind==='table')!;
    const operation=tableOperation(state.doc,table,row,col,action);if(!operation)return null;
    const next=state.update({changes:operation.changes}).state,parsed=previewPlan(next).replacements.find(x=>x.kind==='table');
    return {text:next.doc.toString(),table:parsed!,operation};
  }
  it('inserts before/after data rows and below the header without touching the separator',()=>{
    expect(change(source,0,0,'row-before')).toBeNull();
    const below=change(source,0,1,'row-after')!;expect(below.text).toContain('| :--- | ---: |\n|  |  |\n|  A  | B |');expect(below.table.rows).toHaveLength(4);
    expect(change(source,1,0,'row-before')!.text).toBe(below.text);
    const last=change(source,2,0,'row-after')!;expect(last.text).toContain('| C | D |\n|  |  |\n\nafter');expect(last.table.rows).toHaveLength(4);
  });
  it('deletes data rows including the last one, retaining a valid header-only table',()=>{
    expect(change(source,0,0,'delete-row')).toBeNull();
    expect(change(source,1,0,'delete-row')!.text).not.toContain('|  A  | B |');
    const doc='| A |\n| --- |\n| x |';const last=change(doc,1,0,'delete-row')!;expect(last.text).toBe('| A |\n| --- |');expect(last.table.rows).toHaveLength(1);
  });
  it('inserts columns on both sides while preserving all existing raw cell source and alignment',()=>{
    const before=change(source,0,0,'column-before')!;expect(before.text).toContain('| | 甲 \\| 乙 | 路径\\\\目录<br>续 |\n| ---| :--- | ---: |');expect(before.table.columns).toBe(3);
    const after=change(source,2,1,'column-after')!;expect(after.text).toContain('|  A  | B |  |');expect(after.text).toContain('| :--- | ---: | --- |');expect(after.table.columns).toBe(3);
    expect(change(source,1,1,'column-before')!.table.rows![1].map(cell=>cell.text)).toEqual(['A','','B']);
  });
  it('deletes either column and protects the final remaining column',()=>{
    const first=change(source,1,0,'delete-column')!;expect(first.table.columns).toBe(1);expect(first.text).toContain('| 路径\\\\目录<br>续 |\n| ---: |');
    const second=change(source,1,1,'delete-column')!;expect(second.table.columns).toBe(1);expect(second.text).toContain('| 甲 \\| 乙 |\n| :--- |');expect(change(second.text,0,0,'delete-column')).toBeNull();
  });
  it.each(['A | B\n:--- | ---:\nx | y','| A | B\n| :--- | ---:\n| x | y','A | B |\n:--- | ---: |\nx | y |'])('keeps one-column tables valid with optional outer pipes: %s',doc=>{
    for(const col of [0,1]){const result=change(doc,1,col,'delete-column')!;expect(result.table?.columns).toBe(1);expect(result.table.rows).toHaveLength(2);expect(result.table.rows![1][0].text).toBe(col===0?'y':'x');}
  });
  it('materializes sparse cells only as needed and keeps missing cells empty',()=>{
    const doc='| A | B | C |\n| --- | --- | --- |\n| x |';
    const result=change(doc,1,2,'column-after')!;expect(result.table.columns).toBe(4);expect(result.table.rows![1].map(cell=>cell.text)).toEqual(['x','','','']);
    const removed=change(doc,1,1,'delete-column')!;expect(removed.table.columns).toBe(2);expect(removed.table.rows![1].map(cell=>cell.text)).toEqual(['x','']);
  });
  it('uses original global indices in a virtualized table and preserves outside text',()=>{
    const doc='prefix\n\n| A | B |\n| --- | --- |\n'+Array.from({length:100},(_,i)=>`| row${i} | b${i} |`).join('\n')+'\n\nsuffix';
    const state=EditorState.create({doc}),table=previewPlan(state).replacements.find(x=>x.kind==='table')!;expect(tableSegments(table,state.doc)).toHaveLength(4);
    const result=change(doc,70,1,'row-before')!;expect(result.text).toContain('| row68 | b68 |\n|  |  |\n| row69 | b69 |');expect(result.text.startsWith('prefix\n\n')).toBe(true);expect(result.text.endsWith('\n\nsuffix')).toBe(true);
  });
  it('keeps blockquote and indentation prefixes outside structural cell edits',()=>{
    for(const prefix of ['> ','  ']){const doc=['| A | B |','| --- | --- |','| x | y |'].map(line=>prefix+line).join('\n');
      const inserted=change(doc,1,0,'column-before')!;expect(inserted.table.columns).toBe(3);expect(inserted.text.split('\n').every(line=>line.startsWith(prefix+'|'))).toBe(true);
      const row=change(doc,0,0,'row-after')!;expect(row.table.rows).toHaveLength(3);expect(row.text.split('\n')[2]).toBe(prefix+'|  |  |');
      const removed=change(doc,1,0,'delete-column')!;expect(removed.table.columns).toBe(1);expect(removed.table.rows![1][0].text).toBe('y');
    }
  });
  it('maps untouched annotations and can undo/redo each operation through document history',()=>{
    let state=EditorState.create({doc:source,extensions:[history(),annotationHighlights]});
    const from=source.indexOf('B |');state=state.update({effects:setAnnotationMarks.of([{id:'keep',from,to:from+1,note:'B'}])}).state;
    const table=previewPlan(state).replacements.find(x=>x.kind==='table')!,operation=tableOperation(state.doc,table,1,0,'column-before')!;
    state=state.update({changes:operation.changes,userEvent:'input.table'}).state;const next=state.doc.toString();
    const fakeView={get state(){return state;},dispatch(tr:Parameters<EditorState['update']>[0]){state=state.update(tr).state;}};
    expect(undo(fakeView as never)).toBe(true);expect(state.doc.toString()).toBe(source);expect(redo(fakeView as never)).toBe(true);expect(state.doc.toString()).toBe(next);
    let annotated='';state.field(annotationHighlights).between(0,state.doc.length,(from,to)=>{annotated=state.doc.sliceString(from,to);});expect(annotated).toBe('B');
  });
});

