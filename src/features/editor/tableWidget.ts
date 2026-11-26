import {EditorSelection, EditorState, StateEffect, StateField, type Text} from '@codemirror/state';
import {EditorView, WidgetType, ViewPlugin} from '@codemirror/view';
import {isolateHistory, invertedEffects} from '@codemirror/commands';
import {createUiIcon} from '../../shared/icons';
import type {PreviewCell, PreviewReplacement} from './markdownPresentation';
import type {ImageContext} from './insertions';
import {defaultTableWidths,fitTableWidths,sameSourceTable,tableCell} from './tableViewport';
import {tableOperation,type TableAction} from './tableOperations';
import {renderTableCell,tableCellSourceOffset} from './tableCellPresentation';
import './table-actions.css';

export function decodeCell(value:string){return value.replace(/<br\s*\/?\s*>/gi,'\n').replace(/\\([\\|])/g,'$1');}
export function encodeCell(value:string){return value.replace(/\\/g,'\\\\').replace(/\|/g,'\\|').replace(/\r\n?|\n/g,'<br>');}
export function encodeCellSource(value:string){let result='',slashes=0;for(const ch of value.replace(/\r\n?|\n/g,'<br>')){if(ch==='|'&&slashes%2===0)result+='\\';result+=ch;slashes=ch==='\\'?slashes+1:0;}return result;}
function tableAlignments(item:PreviewReplacement,doc:Text){const first=item.rows?.[0]?.[0];if(!first)return [];return doc.line(Math.min(doc.lines,doc.lineAt(first.from).number+1)).text.trim().replace(/^(?:>\s*)+/, '').replace(/^\|/, '').replace(/\|$/, '').split('|').map(part=>{part=part.trim();return part.startsWith(':')&&part.endsWith(':')?'center':part.endsWith(':')?'right':'left';});}
export function cellContent(cell:PreviewCell,doc:string|Text){
  if(cell.virtual!==undefined)return {from:cell.from,to:cell.to,raw:''};
  const raw=typeof doc==='string'?doc.slice(cell.from,cell.to):doc.sliceString(cell.from,cell.to),left=raw.match(/^\s*/)?.[0].length||0,right=raw.match(/\s*$/)?.[0].length||0;
  const from=cell.from+left,to=Math.max(from,cell.to-right);return {from,to,raw:raw.slice(left,left+to-from)};
}
function hash(value:string){let h=2166136261;for(let i=0;i<value.length;i++)h=Math.imul(h^value.charCodeAt(i),16777619);return (h>>>0).toString(36);}
type Sizes={widths:(number|null)[];heights:(number|null)[]};
const storageKey='hive.table.sizes.v1';
export function tableSizeKey(context:ImageContext|null,item:PreviewReplacement){if(!context?.workspace||!context.file)return '';return hash(context.workspace+'\0'+context.file+'\0'+(item.tableOrdinal??0));}
function readSizes(key:string):Sizes{try{const raw=localStorage.getItem(storageKey)||'{}';if(raw.length>100000)return {widths:[],heights:[]};const data=JSON.parse(raw),item=data[key];const clean=(value:unknown,max:number,minSize:number,maxSize:number)=>Array.isArray(value)?value.slice(0,max).map(n=>typeof n==='number'&&Number.isFinite(n)?clamp(n,minSize,maxSize):null):[];return {widths:clean(item?.widths,100,60,800),heights:clean(item?.heights,1000,30,500)};}catch{return {widths:[],heights:[]};}}
function saveSizes(key:string,sizes:Sizes){if(!key)return;try{const raw=localStorage.getItem(storageKey)||'{}';const data=raw.length<=100000?JSON.parse(raw):{};delete data[key];data[key]={widths:sizes.widths.slice(0,100),heights:sizes.heights.slice(0,1000)};for(const k of Object.keys(data).slice(0,-100))delete data[k];localStorage.setItem(storageKey,JSON.stringify(data));}catch{/* storage unavailable */}}
const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));

export type TableMark={from:number;to:number;id:string;note:string};
type Controller={fromRow:number;toRow:number;marks:TableMark[];applySize?:()=>void;refreshActions?:()=>void;selectColumn?:(col:number)=>void;selectTable?:()=>void;composition?:{row:number;col:number;source:Text;conflict:boolean};item:PreviewReplacement;context:ImageContext|null;view:EditorView; sizes:Sizes;key:string;root:HTMLElement; cleanup?:()=>void;dispose?:()=>void;committing?:boolean};
export const selectTableSource='select.table-block';
// CodeMirror owns the source range. The widget mirrors it across rendered segments,
// whose cell content is outside CodeMirror's text selection layer.
export const tableSourceSelection=StateField.define<{from:number;to:number}|null>({
  create:()=>null,
  update(value,tr){
    if(tr.isUserEvent(selectTableSource))return tr.newSelection.main;
    if(tr.docChanged||tr.selection&&!tr.newSelection.eq(tr.startState.selection))return null;
    return value;
  },
});
export function isTableSourceSelected(state:EditorState,item:PreviewReplacement){
  const range=state.field(tableSourceSelection,false);
  return range?.from===item.from&&range.to===item.to;
}

const controllers=new WeakMap<HTMLElement,Controller>();
export const tableSourceSelectionView=ViewPlugin.define(view=>({
  update(update){
    if(update.startState.field(tableSourceSelection)===update.state.field(tableSourceSelection))return;
    for(const root of view.contentDOM.querySelectorAll<HTMLElement>('[data-table-widget]')){
      const controller=controllers.get(root);
      if(controller)root.classList.toggle('cm-table-source-selected',isTableSourceSelected(update.state,controller.item));
    }
  },
}));
const liveSizes=new WeakMap<EditorView,Map<string,Sizes>>();
const tableScrolls=new WeakMap<EditorView,Map<string,number>>();
const copySizes=(sizes:Sizes):Sizes=>({widths:[...sizes.widths],heights:[...sizes.heights]});
const sizeChange=StateEffect.define<{key:string;ordinal:number;before:Sizes;after:Sizes}>();
const sizeIdentity=(key:string,ordinal:number)=>key+'\0'+ordinal;
const scrollIdentity=(controller:Controller)=>sizeIdentity(controller.key,controller.item.tableOrdinal??0);
type StickyGeometry={controller:Controller;top:number;left:number;width:number;tableLeft:number;selectEndInset:number;availableHeight:number;trackHeight:number;fontFamily:string;lineHeight:string};

function tableColumns(table:HTMLTableElement,controller:Controller){
  const defaults=defaultTableWidths(controller.item);
  let group=table.querySelector('colgroup');
  if(!group){
    group=table.ownerDocument.createElement('colgroup');
    for(let col=0;col<defaults.length;col++)group.append(table.ownerDocument.createElement('col'));
    table.prepend(group);
  }
  if(group.children.length!==defaults.length)return;
  const window=controller.root.ownerDocument.defaultView!;
  const rootStyle=window.getComputedStyle(controller.root);
  const tableStyle=window.getComputedStyle(table);
  const fontSize=Number.parseFloat(rootStyle.fontSize)||16;
  const available=Math.max(0,controller.root.clientWidth-(Number.parseFloat(tableStyle.marginLeft)||0)-(Number.parseFloat(tableStyle.marginRight)||0)-1);
  const widths=fitTableWidths(defaults,controller.sizes.widths,available,fontSize).map(width=>`${width}px`);
  for(let col=0;col<widths.length;col++){
    const column=group.children[col] as HTMLElement;
    if(column.style.width!==widths[col])column.style.width=widths[col];
  }
  table.style.width=`calc(${widths.join(' + ')})`;
}

function columnSelector(document:Document,select:()=>void){
  const button=document.createElement('button');
  button.type='button';
  button.className='cm-table-edge cm-table-select-column';
  button.setAttribute('aria-label','选择整列');
  button.title='选择整列';
  button.append(createUiIcon(document,'table.select',8));
  button.addEventListener('pointerdown',event=>{event.preventDefault();event.stopPropagation();});
  button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();select();});
  return button;
}

function addTableSelectionButton(table:HTMLTableElement,select:()=>void){
  const caption=table.createCaption(),document=table.ownerDocument;
  caption.className='cm-table-select-table-toolbar';
  caption.setAttribute('role','presentation');
  const button=document.createElement('button');
  button.className='cm-table-select-table-button';
  button.type='button';
  button.title='选择整张表格';
  button.setAttribute('aria-label',button.title);
  button.append(createUiIcon(document,'AiLauncher',15));
  button.addEventListener('pointerdown',event=>{event.preventDefault();event.stopPropagation();});
  button.addEventListener('click',event=>{
    event.preventDefault();
    event.stopPropagation();
    select();
  });
  caption.append(button);
  return button;
}

function scrollTable(event:WheelEvent,root:HTMLElement,view:EditorView){
  if(event.ctrlKey||event.metaKey)return;
  const {scrollDOM}=view;
  if(event.shiftKey||Math.abs(event.deltaX)>Math.abs(event.deltaY)){
    const delta=event.deltaX||(event.shiftKey?event.deltaY:0);
    if(!delta||root.scrollWidth<=root.clientWidth)return;
    const scale=event.deltaMode===1?view.defaultLineHeight:event.deltaMode===2?root.clientWidth:1;
    root.scrollLeft+=delta*scale;
  }else{
    if(!event.deltaY)return;
    // The horizontal overflow box can capture a Chromium wheel gesture around
    // cell controls. Route vertical movement to the containing document.
    const previous=scrollDOM.scrollTop;
    const scale=event.deltaMode===1?view.defaultLineHeight:event.deltaMode===2?scrollDOM.clientHeight:1;
    scrollDOM.scrollTop+=event.deltaY*scale;
    if(scrollDOM.scrollTop===previous)return;
  }
  event.preventDefault();event.stopPropagation();
}

function updateCellReadOnly(controller:Controller){
  const {root,view}=controller,readOnly=view.state.readOnly;
  for(const input of root.querySelectorAll<HTMLTextAreaElement>('textarea')){
    input.readOnly=readOnly;
    const preview=input.previousElementSibling as HTMLElement;
    const label=input.getAttribute('aria-label')||'单元格';
    preview.setAttribute('aria-label',readOnly?label:label+'，按 Enter 编辑');
    preview.title=readOnly?'拖动可选择文字':'单击或按 Enter 编辑单元格；拖动可选择文字或多个单元格';
    if(readOnly&&!input.hidden&&!controller.composition)queueMicrotask(()=>{
      if(!input.isConnected||!view.state.readOnly||controller.composition)return;
      input.blur();
      input.hidden=true;preview.hidden=false;
    });
  }
}
/** Size movement participates in the same history item as the source structure edit. */
export const tableSizeHistory=[invertedEffects.of(tr=>tr.effects.filter(effect=>effect.is(sizeChange)).map(effect=>{const value=effect.value as {key:string;ordinal:number;before:Sizes;after:Sizes};return sizeChange.of({...value,before:value.after,after:value.before});})),ViewPlugin.define(view=>({update(update){for(const tr of update.transactions)for(const effect of tr.effects)if(effect.is(sizeChange)){
  const {key,ordinal,after}=effect.value;let cache=liveSizes.get(view);if(!cache)liveSizes.set(view,cache=new Map());cache.set(sizeIdentity(key,ordinal),copySizes(after));saveSizes(key,after);
  for(const root of view.dom.querySelectorAll<HTMLElement>('[data-table-widget]')){const c=controllers.get(root);if(c&&c.key===key&&(c.item.tableOrdinal??0)===ordinal){c.sizes=copySizes(after);c.applySize?.();}}
}if(update.startState.readOnly!==update.state.readOnly)for(const root of view.dom.querySelectorAll<HTMLElement>('[data-table-widget]')){const c=controllers.get(root);if(c){updateCellReadOnly(c);c.refreshActions?.();}}
}}))];

/** The separate sticky surface avoids clipping by the table's horizontal scroller
 * and remains attached when CodeMirror recycles the original table header. */
export const tableStickyHeaders=ViewPlugin.define(view=>{
  const document=view.dom.ownerDocument;
  const sticky=document.createElement('div'),track=document.createElement('div'),table=document.createElement('table');
  sticky.className='cm-table-sticky';track.className='cm-table-sticky-track';table.className='cm-preview-table';
  sticky.hidden=true;track.append(table);sticky.append(track);view.dom.append(sticky);
  let active:Controller|undefined,rendered:PreviewReplacement|undefined;
  const selectButton=addTableSelectionButton(table,()=>active?.selectTable?.());
  const measure={
    read():StickyGeometry|null{
      const scroll=view.scrollDOM,viewport=scroll.getBoundingClientRect(),editor=view.dom.getBoundingClientRect();
      const sx=view.scaleX,sy=view.scaleY;
      const viewportTop=viewport.top+scroll.clientTop*sy;
      if(!scroll.clientHeight)return null;
      const roots=[...view.contentDOM.querySelectorAll<HTMLElement>('[data-table-widget]')];
      for(const root of roots){
        const controller=controllers.get(root),rootBounds=root.getBoundingClientRect();
        if(!controller||rootBounds.top>=viewportTop||rootBounds.bottom<=viewportTop)continue;
        const table=root.querySelector<HTMLTableElement>('.cm-preview-table');
        if(!table)continue;
        const caption=table.caption?.getBoundingClientRect();
        const headerTop=caption?.height?caption.top:table.tHead?.getBoundingClientRect().top;
        if(headerTop!==undefined&&headerTop>=viewportTop)continue;
        const last=roots.find(node=>sameSourceTable(node,root)&&node.classList.contains('cm-table-final-segment'));
        const lastRow=last?.querySelector('tbody tr:last-of-type')??last?.querySelector('thead tr');
        const tableEnd=lastRow?.getBoundingClientRect().bottom??view.documentTop+view.lineBlockAt(Math.max(controller.item.from,controller.item.to-1)).bottom*sy;
        if(tableEnd<=viewportTop)continue;
        const tableBounds=table.getBoundingClientRect();
        const {fontFamily,lineHeight}=table.ownerDocument.defaultView!.getComputedStyle(table);
        const left=Math.max(rootBounds.left,viewport.left+scroll.clientLeft*sx);
        const right=Math.min(rootBounds.left+root.clientWidth*sx,viewport.left+(scroll.clientLeft+scroll.clientWidth)*sx);
        if(right<=left)continue;
        return {
          controller,top:(viewportTop-editor.top)/sy-view.dom.clientTop,left:(left-editor.left)/sx-view.dom.clientLeft,width:(right-left)/sx,
          tableLeft:(tableBounds.left-left)/sx,selectEndInset:Math.max(0,(tableBounds.right-right)/sx),
          availableHeight:(tableEnd-viewportTop)/sy,trackHeight:track.offsetHeight,fontFamily,lineHeight,
        };
      }
      return null;
    },
    write(geometry:StickyGeometry|null){
      if(!geometry){sticky.hidden=true;active=undefined;return;}
      const controller=active=geometry.controller;
      const rebuilt=rendered!==controller.item;
      if(rebuilt){
        rendered=controller.item;
        const head=table.tHead??table.createTHead(),row=document.createElement('tr');
        const align=tableAlignments(controller.item,view.state.doc);
        for(let col=0;col<(controller.item.columns??0);col++){
          const cell=document.createElement('th'),preview=document.createElement('div');
          cell.scope='col';cell.style.textAlign=align[col]||'left';
          preview.className='cm-table-cell-preview';
          renderTableCell(preview,tableCell(controller.item,0,col)?.text||'');
          for(const link of preview.querySelectorAll('a'))link.tabIndex=-1;
          const selector=columnSelector(sticky.ownerDocument,()=>active?.selectColumn?.(col));
          selector.tabIndex=-1;
          cell.append(preview,selector);row.append(cell);
        }
        head.replaceChildren(row);table.querySelector('colgroup')?.remove();
      }
      tableColumns(table,controller);
      const {top,left,width,tableLeft,selectEndInset,availableHeight,trackHeight,fontFamily,lineHeight}=geometry;
      const resized=sticky.hidden||sticky.style.width!==width+'px'||rebuilt||table.style.fontFamily!==fontFamily||table.style.lineHeight!==lineHeight;
      table.style.fontFamily=fontFamily;table.style.lineHeight=lineHeight;
      sticky.hidden=false;
      sticky.style.top=top+'px';sticky.style.left=left+'px';sticky.style.width=width+'px';
      sticky.style.height=Math.max(0,Math.min(trackHeight,availableHeight))+'px';
      track.style.transform=`translate(${tableLeft}px, ${Math.min(0,availableHeight-trackHeight)}px)`;
      selectButton.style.right=selectEndInset+'px';
      sticky.classList.toggle('cm-table-source-selected',isTableSourceSelected(view.state,controller.item));
      if(resized)view.requestMeasure(measure);
    },
  };
  const request=()=>view.requestMeasure(measure);
  sticky.addEventListener('wheel',event=>{if(active)scrollTable(event,active.root,view);},{passive:false});
  view.scrollDOM.addEventListener('scroll',request,{passive:true});
  view.contentDOM.addEventListener('scroll',request,true);
  view.dom.addEventListener('hive:table-geometry-changed',request);
  request();
  return {
    update(update){if(update.docChanged||update.geometryChanged||update.viewportChanged||update.selectionSet)request();},
    destroy(){view.scrollDOM.removeEventListener('scroll',request);view.contentDOM.removeEventListener('scroll',request,true);view.dom.removeEventListener('hive:table-geometry-changed',request);sticky.remove();},
  };
});
export class TableWidget extends WidgetType{
  constructor(readonly item:PreviewReplacement,readonly context:ImageContext|null,readonly marks:TableMark[]=[],readonly fromRow=0,readonly toRow=item.rows?.length||0){super();}
  eq(other:TableWidget){return this.item===other.item&&this.fromRow===other.fromRow&&this.toRow===other.toRow&&this.context?.workspace===other.context?.workspace&&this.context?.file===other.context?.file&&this.marks.length===other.marks.length&&this.marks.every((mark,i)=>{const next=other.marks[i];return mark.from===next.from&&mark.to===next.to&&mark.id===next.id&&mark.note===next.note;});}
  get estimatedHeight(){return Math.max(1,this.toRow-this.fromRow)*44;}
  toDOM(view:EditorView){
    const root=view.dom.ownerDocument.createElement('div');root.className='cm-table-widget';root.dataset.tableWidget='';root.dataset.tableOrdinal=String(this.item.tableOrdinal??0);if(this.toRow-this.fromRow!==(this.item.rows?.length||0))root.dataset.tableSegment=String(this.fromRow);root.contentEditable='false';
    const key=tableSizeKey(this.context,this.item),cached=liveSizes.get(view)?.get(sizeIdentity(key,this.item.tableOrdinal??0)),controller:Controller={fromRow:this.fromRow,toRow:this.toRow,marks:this.marks,item:this.item,context:this.context,view,key,sizes:cached?copySizes(cached):readSizes(key),root};controllers.set(root,controller);root.classList.toggle('cm-table-source-selected',isTableSourceSelected(view.state,this.item));render(controller);return root;
  }
  updateDOM(dom:HTMLElement,view:EditorView){const c=controllers.get(dom);if(!c)return false;
    const old=c.item, key=tableSizeKey(this.context,this.item);if(key!==c.key){c.cleanup?.();if(c.composition)c.composition.conflict=true;c.key=key;c.sizes=readSizes(key);}
    const changedShape=c.fromRow!==this.fromRow||c.toRow!==this.toRow||(old.columns??old.rows?.[0]?.length)!==(this.item.columns??this.item.rows?.[0]?.length);
    if(c.composition&&!c.committing&&(c.composition.conflict||!view.state.doc.slice(this.item.from,this.item.to).eq(c.composition.source))){c.composition.conflict=true;const status=dom.querySelector<HTMLElement>('[role=status]');if(status)status.textContent='表格已在别处更改，输入尚未写入；请复制输入后重新编辑。';}
    if(changedShape&&!c.composition)return false;
    c.item=this.item;c.context=this.context;c.view=view;c.marks=this.marks;dom.dataset.tableOrdinal=String(this.item.tableOrdinal??0);
    for(const input of dom.querySelectorAll<HTMLTextAreaElement>('textarea')){input.readOnly=view.state.readOnly;const row=Number(input.dataset.row),col=Number(input.dataset.col),cell=tableCell(this.item,row,col);if(cell&&!(c.composition?.row===row&&c.composition.col===col)&&(!c.committing||dom.ownerDocument.activeElement!==input)){const value=cell.text;if(input.value!==value){const start=input.selectionStart,end=input.selectionEnd;input.value=value;input.style.height='auto';input.style.height=Math.max(24,input.scrollHeight)+'px';if(dom.ownerDocument.activeElement===input)input.setSelectionRange(Math.min(start,value.length),Math.min(end,value.length));}}}
    const aligns=tableAlignments(this.item,view.state.doc);for(const td of dom.querySelectorAll<HTMLElement>('[data-cell]'))td.style.textAlign=aligns[Number(td.dataset.column)]||'left';
    for(const preview of dom.querySelectorAll<HTMLElement>('.cm-table-cell-preview')){const cell=tableCell(this.item,Number(preview.dataset.row),Number(preview.dataset.col));if(cell&&preview.dataset.source!==cell.text){renderTableCell(preview,cell.text);preview.dataset.source=cell.text;}}
    dom.classList.toggle('cm-table-source-selected',isTableSourceSelected(view.state,this.item));
    renderMarks(c);c.applySize?.();c.refreshActions?.();
    return true;
  }
  destroy(dom:HTMLElement){controllers.get(dom)?.cleanup?.();controllers.get(dom)?.dispose?.();controllers.delete(dom);}
  ignoreEvent(){return true;}
}
function renderMarks(c:Controller){for(const td of c.root.querySelectorAll<HTMLElement>('[data-cell]')){const [r,col]=td.dataset.cell!.split(':').map(Number),cell=tableCell(c.item,r,col);const part=cell&&c.marks.length?cellContent(cell,c.view.state.doc):null;const marks=part?c.marks.filter(m=>m.from<part.to&&m.to>part.from):[];td.classList.toggle('cm-table-marked',!!marks.length);if(marks.length){td.dataset.tableAnnotationIds=JSON.stringify(marks.map(m=>m.id));}else{delete td.dataset.tableAnnotationIds;}}}
export function tableRectangle(start:{row:number;col:number},end:{row:number;col:number}){return {top:Math.min(start.row,end.row),bottom:Math.max(start.row,end.row),left:Math.min(start.col,end.col),right:Math.max(start.col,end.col)};}
function render(c:Controller){
  const {root,view}=c,document=root.ownerDocument,table=document.createElement('table');table.className='cm-preview-table';const status=document.createElement('span');status.setAttribute('role','status');status.className='cm-table-status';root.append(table,status);
  if(c.fromRow===0)addTableSelectionButton(table,()=>c.selectTable?.());
  if(root.dataset.tableSegment!==undefined)root.setAttribute('aria-label','表格按可见行分段显示，原始行列与编辑内容保持完整');
  const head=c.fromRow===0?table.createTHead():null,body=table.createTBody();
  const roots=()=>[...view.dom.querySelectorAll<HTMLElement>('[data-table-widget]')].filter(node=>sameSourceTable(node,root));
  const tableCells=()=>roots().flatMap(node=>[...node.querySelectorAll<HTMLElement>('[data-cell]')]);
  const scrolls=tableScrolls.get(view)||new Map<string,number>();
  tableScrolls.set(view,scrolls);
  const syncX=()=>{
    const key=scrollIdentity(c),left=root.scrollLeft;
    if(left===scrolls.get(key))return;
    scrolls.set(key,left);
    if(scrolls.size>100)scrolls.delete(scrolls.keys().next().value!);
    for(const other of roots())if(other!==root&&other.scrollLeft!==left)other.scrollLeft=left;
    view.requestMeasure();
  };
  root.addEventListener('scroll',syncX,{passive:true});
  root.addEventListener('wheel',event=>scrollTable(event,root,view),{passive:false});
  queueMicrotask(()=>{if(root.isConnected)root.scrollLeft=scrolls.get(scrollIdentity(c))||0;});
  let activeRow=c.fromRow,activeCol=0;
  const composing=()=>roots().some(node=>!!controllers.get(node)?.composition);
  c.selectTable=()=>{
    if(!root.isConnected||composing()||view.compositionStarted)return;
    clearSelection();
    view.dispatch({selection:EditorSelection.range(c.item.from,c.item.to),userEvent:selectTableSource});
    view.focus();
  };
  const refreshActions=()=>{root.querySelectorAll<HTMLButtonElement>('[data-table-action]').forEach(button=>{button.disabled=view.state.readOnly||composing()||view.composing;});};
  c.refreshActions=refreshActions;
  const runAction=(action:TableAction)=>{if(view.state.readOnly||view.composing||composing())return;c.cleanup?.();const operation=tableOperation(view.state.doc,c.item,activeRow,activeCol,action);if(!operation)return;clearSelection();
    const ordinal=root.dataset.tableOrdinal,next=view.state.changes(operation.changes).apply(view.state.doc),line=next.line(view.state.doc.lineAt(c.item.from).number+operation.row+(operation.row>0?1:0));
    const before=copySizes(c.sizes),after=copySizes(before),axis=action.includes('column')?'widths':'heights',index=action==='delete-row'?activeRow:action==='delete-column'?activeCol:axis==='widths'?operation.col:operation.row;
    while(after[axis].length<index)after[axis].push(null);if(action.startsWith('delete'))after[axis].splice(index,1);else after[axis].splice(index,0,null);
    view.dispatch({changes:operation.changes,selection:{anchor:Math.min(line.to,line.from+2)},effects:sizeChange.of({key:c.key,ordinal:c.item.tableOrdinal??0,before,after}),userEvent:'input.table',annotations:isolateHistory.of('full')});
    queueMicrotask(()=>{const widgets=[...view.dom.querySelectorAll<HTMLElement>('[data-table-widget]')].filter(node=>node.dataset.tableOrdinal===ordinal);widgets.map(node=>node.querySelector<HTMLTextAreaElement>(`textarea[data-row="${operation.row}"][data-col="${operation.col}"]`)).find(Boolean)?.parentElement?.querySelector<HTMLElement>('.cm-table-cell-preview')?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));});
  };
  root.addEventListener('focusin',event=>{const input=(event.target as HTMLElement).closest<HTMLTextAreaElement>('textarea[data-row]');if(input){activeRow=Number(input.dataset.row);activeCol=Number(input.dataset.col);refreshActions();}});
  const canMark=()=>!view.state.readOnly&&!view.composing&&!composing();
  const markRanges=(ranges:{from:number;to:number}[])=>{
    const owner=root.ownerDocument.defaultView;
    if(!owner||!canMark()||!ranges.length)return;
    view.dom.dispatchEvent(new owner.CustomEvent('hive:table-annotation',{bubbles:true,detail:{ranges,action:'mark'}}));
  };
  const select=(cells:PreviewCell[],mark=false)=>{
    const ranges=cells.map(cell=>cellContent(cell,view.state.doc)).filter(r=>r.to>r.from).map(({from,to})=>({from,to}));
    if(!ranges.length){if(mark)status.textContent='所选单元格为空，没有可标注文字。';return;}
    const unique=ranges.filter((r,i)=>i===0||r.from!==ranges[i-1].from||r.to!==ranges[i-1].to);
    if(mark)markRanges(unique);
    else view.dispatch({selection:EditorSelection.create(unique.map(r=>EditorSelection.range(r.from,r.to))),userEvent:'select.pointer'});
  };
  const inputRange=(input:HTMLTextAreaElement,row:number,col:number)=>{
    const cell=tableCell(c.item,row,col);
    if(!cell||cell.virtual!==undefined||input.selectionStart===input.selectionEnd)return;
    const part=cellContent(cell,view.state.doc);
    const encoded=encodeCellSource(input.value);
    if(encoded.trim()!==part.raw)return;
    const padding=encoded.length-encoded.trimStart().length;
    const position=(offset:number)=>part.from+clamp(encodeCellSource(input.value.slice(0,offset)).length-padding,0,part.raw.length);
    const from=position(input.selectionStart),to=position(input.selectionEnd);
    if(to>from)return {from,to};
  };
  const rows=c.item.rows||[];
  const alignments=tableAlignments(c.item,view.state.doc);
  const alignment=(col:number)=>alignments[col]||'left';
  const applySize=(broadcast=false)=>{tableColumns(table,c);root.querySelectorAll<HTMLElement>('[data-column]').forEach(el=>{const width=c.sizes.widths[Number(el.dataset.column)];el.style.width=typeof width==='number'?width+'px':'';});root.querySelectorAll<HTMLElement>('tr[data-row]').forEach(el=>{const height=c.sizes.heights[Number(el.dataset.row)];el.style.height=Number.isFinite(height)?clamp(height!,30,500)+'px':'';});view.requestMeasure();view.dom.dispatchEvent(new Event('hive:table-geometry-changed'));if(broadcast){let cache=liveSizes.get(view);if(!cache)liveSizes.set(view,cache=new Map());cache.set(sizeIdentity(c.key,c.item.tableOrdinal??0),copySizes(c.sizes));view.dom.dispatchEvent(new CustomEvent('hive:table-size-changed',{detail:c}));}};
  c.applySize=applySize;
  const handle=(axis:'widths'|'heights',index:number)=>{const h=document.createElement('span');h.className=axis==='widths'?'cm-table-resize-col':'cm-table-resize-row';h.title=axis==='widths'?'拖动调整列宽':'拖动调整行高';h.addEventListener('pointerdown',e=>{const window=root.ownerDocument.defaultView;if(!window)return;e.preventDefault();e.stopPropagation();c.cleanup?.();const start=axis==='widths'?e.clientX:e.clientY,previous=c.sizes[axis][index];const target=axis==='widths'?root.querySelector<HTMLElement>(`[data-column="${index}"]`):root.querySelector<HTMLElement>(`tr[data-row="${index}"]`);const size=axis==='widths'?target?.getBoundingClientRect().width:target?.getBoundingClientRect().height;const move=(ev:PointerEvent)=>{if(ev.pointerId!==e.pointerId)return;c.sizes[axis][index]=clamp((size||100)+(axis==='widths'?ev.clientX:ev.clientY)-start,axis==='widths'?60:30,axis==='widths'?800:500);applySize(true);};const end=(ev:PointerEvent)=>{if(ev.pointerId!==e.pointerId)return;cleanup();saveSizes(c.key,c.sizes);};const cancel=()=>{if(previous===undefined)delete c.sizes[axis][index];else c.sizes[axis][index]=previous;cleanup();applySize(true);};const pointerCancel=(event:PointerEvent)=>{if(event.pointerId===e.pointerId)cancel();};const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();cancel();}};const cleanup=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',pointerCancel);window.removeEventListener('keydown',escape,true);window.removeEventListener('blur',cancel);c.cleanup=undefined;};c.cleanup=cancel;window.addEventListener('pointermove',move);window.addEventListener('pointerup',end);window.addEventListener('pointercancel',pointerCancel);window.addEventListener('keydown',escape,true);window.addEventListener('blur',cancel);});return h;};
  let suppressMouseup=false;
  const clearSelection=()=>{for(const node of roots()){delete node.dataset.tableSelection;node.querySelectorAll('.cm-table-selected,.cm-table-select-top,.cm-table-select-bottom,.cm-table-select-left,.cm-table-select-right').forEach(el=>el.classList.remove('cm-table-selected','cm-table-select-top','cm-table-select-bottom','cm-table-select-left','cm-table-select-right'));}};
  const paint=(rect:ReturnType<typeof tableRectangle>)=>{clearSelection();for(const node of roots())node.dataset.tableSelection=JSON.stringify(rect);for(const el of tableCells()){const [row,col]=el.dataset.cell!.split(':').map(Number);if(row<rect.top||row>rect.bottom||col<rect.left||col>rect.right)continue;el.classList.add('cm-table-selected');if(row===rect.top)el.classList.add('cm-table-select-top');if(row===rect.bottom)el.classList.add('cm-table-select-bottom');if(col===rect.left)el.classList.add('cm-table-select-left');if(col===rect.right)el.classList.add('cm-table-select-right');}};
  const rectCells=({top,bottom,left,right}:ReturnType<typeof tableRectangle>)=>
    (c.item.rows||[]).slice(top,bottom+1).flatMap(row=>row.slice(left,right+1));
  const plainModifiers=(event:MouseEvent)=>!event.altKey&&!event.shiftKey&&!event.metaKey;
  const isAnnotationClick=(event:MouseEvent)=>event.button===0&&event.ctrlKey&&plainModifiers(event);
  root.addEventListener('pointerdown',event=>{
    const document=root.ownerDocument,owner=document.defaultView;
    if(!owner||event.button!==0||!event.isPrimary||c.composition)return;
    const target=event.target as HTMLElement;
    if(target.closest('.cm-table-resize-col,.cm-table-resize-row,button'))return;
    const cell=target.closest<HTMLElement>('[data-cell]');
    if(!cell)return;
    const input=target.closest<HTMLTextAreaElement>('textarea');
    const marking=plainModifiers(event)&&(event.ctrlKey||!!root.closest('[data-annotation-tool-active]'))&&canMark();
    const preserveRectangle=isAnnotationClick(event)&&cell.classList.contains('cm-table-selected')&&!target.closest('a,[data-hive-link],textarea');
    if(preserveRectangle)event.preventDefault();
    else clearSelection();
    const [row,col]=cell.dataset.cell!.split(':').map(Number),start={row,col};
    const doc=view.state.doc;
    const preview=marking&&!input?cell.querySelector<HTMLElement>('.cm-table-cell-preview'):null;
    const startOffset=preview?tableCellSourceOffset(preview,event.clientX,event.clientY):undefined;
    const initialInputRange=marking&&input?inputRange(input,row,col):undefined;
    let end=start,dragged=false,moved=false;

    const track=(pointer:PointerEvent)=>{
      moved||=Math.hypot(pointer.clientX-event.clientX,pointer.clientY-event.clientY)>3;
      const hit=document.elementFromPoint(pointer.clientX,pointer.clientY)?.closest<HTMLElement>('[data-cell]');
      if(!hit||!sameSourceTable(hit.closest('[data-table-widget]'),root))return;
      const [row,col]=hit.dataset.cell!.split(':').map(Number);
      end={row,col};
      dragged||=row!==start.row||col!==start.col;
      if(dragged){
        pointer.preventDefault();
        document.getSelection()?.removeAllRanges();
        paint(tableRectangle(start,end));
      }
    };
    const move=(pointer:PointerEvent)=>{if(pointer.pointerId===event.pointerId)track(pointer);};
    const cleanup=()=>{
      owner.removeEventListener('pointermove',move);
      owner.removeEventListener('pointerup',up,true);
      owner.removeEventListener('pointercancel',pointerCancel);
      owner.removeEventListener('blur',cancel);
      owner.removeEventListener('keydown',escape,true);
      c.cleanup=undefined;
    };
    const cancel=()=>{cleanup();if(dragged)clearSelection();};
    const pointerCancel=(pointer:PointerEvent)=>{if(pointer.pointerId===event.pointerId)cancel();};
    const escape=(key:KeyboardEvent)=>{if(key.key==='Escape'){key.preventDefault();key.stopImmediatePropagation();cancel();}};
    const up=(pointer:PointerEvent)=>{
      if(pointer.pointerId!==event.pointerId)return;
      track(pointer);
      cleanup();
      if(!dragged&&!moved)return;
      suppressMouseup=true;
      owner.setTimeout(()=>{suppressMouseup=false;},0);
      if(view.state.doc!==doc){
        clearSelection();
        status.textContent='表格已变化，请重新选择。';
        return;
      }
      if(dragged){
        select(rectCells(tableRectangle(start,end)),marking);
      }else if(marking&&input){
        const range=inputRange(input,row,col);
        if(range&&(range.from!==initialInputRange?.from||range.to!==initialInputRange?.to))markRanges([range]);
      }else if(preview&&startOffset!==undefined){
        const endOffset=tableCellSourceOffset(preview,pointer.clientX,pointer.clientY);
        const source=tableCell(c.item,row,col);
        if(endOffset===undefined||endOffset===startOffset||!source||source.virtual!==undefined)return;
        const {from,raw}=cellContent(source,doc);
        if(raw!==preview.dataset.source)return;
        markRanges([{from:from+Math.min(startOffset,endOffset),to:from+Math.max(startOffset,endOffset)}]);
      }
    };
    c.cleanup?.();
    c.cleanup=cancel;
    owner.addEventListener('pointermove',move);
    owner.addEventListener('pointerup',up,true);
    owner.addEventListener('pointercancel',pointerCancel);
    owner.addEventListener('blur',cancel);
    owner.addEventListener('keydown',escape,true);
  });
  root.addEventListener('click',event=>{
    const target=event.target as HTMLElement,cell=target.closest('[data-cell].cm-table-selected');
    if(suppressMouseup&&target.closest('a[href]')){
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if(!isAnnotationClick(event)||!cell||target.closest('a,[data-hive-link],textarea,button')||!root.dataset.tableSelection||view.state.readOnly||composing()||suppressMouseup)return;
    let rect:ReturnType<typeof tableRectangle>;try{rect=JSON.parse(root.dataset.tableSelection);}catch{return;}
    event.preventDefault();event.stopPropagation();
    select(rectCells(rect),true);
  },true);
  let menu:HTMLElement|undefined;
  const closeMenu=()=>{menu?.remove();menu=undefined;};
  root.addEventListener('contextmenu',event=>{const cell=(event.target as HTMLElement).closest<HTMLElement>('[data-cell]');if(!cell||!cell.classList.contains('cm-table-selected')||!root.dataset.tableSelection)return;let rect:ReturnType<typeof tableRectangle>;try{rect=JSON.parse(root.dataset.tableSelection);}catch{return;}
    const row=rect.top===rect.bottom&&rect.left===0&&rect.right===(c.item.columns??1)-1, col=rect.left===rect.right&&rect.top===0&&rect.bottom===(c.item.rows?.length??1)-1;
    if(!row&&!col)return;event.preventDefault();event.stopPropagation();closeMenu();const menuDocument=root.ownerDocument;menu=menuDocument.createElement('div');menu.className='cm-table-context-menu';menu.setAttribute('role','menu');menu.style.left=`${event.clientX}px`;menu.style.top=`${event.clientY}px`;
    const add=(action:TableAction,label:string,disabled:boolean)=>{const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.textContent=label;button.disabled=disabled||view.state.readOnly||composing()||view.composing;button.addEventListener('click',()=>{activeRow=rect.top;activeCol=rect.left;closeMenu();runAction(action);});menu!.append(button);};
    if(row)add('delete-row','删除行',rect.top===0);if(col)add('delete-column','删除列',(c.item.columns??1)<=1);menuDocument.body.append(menu);menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  },true);
  const outside=(event:PointerEvent)=>{
    if(menu&&!menu.contains(event.target as Node))closeMenu();
    if(!sameSourceTable((event.target as Element).closest?.('[data-table-widget]'),root))clearSelection();
  };
  const escapeMenu=(event:KeyboardEvent)=>{if(event.key==='Escape'&&menu){event.preventDefault();event.stopPropagation();closeMenu();}};
  let outsideDocument=root.ownerDocument;
  const bindOutside=()=>{
    outsideDocument.addEventListener('pointerdown',outside,true);
    outsideDocument.addEventListener('keydown',escapeMenu,true);
    outsideDocument.defaultView?.addEventListener('blur',closeMenu);
  };
  const unbindOutside=()=>{
    outsideDocument.removeEventListener('pointerdown',outside,true);
    outsideDocument.removeEventListener('keydown',escapeMenu,true);
    outsideDocument.defaultView?.removeEventListener('blur',closeMenu);
  };
  bindOutside();
  const resized=(event:Event)=>{const source=(event as CustomEvent<Controller>).detail;if(source===c||!sameSourceTable(source.root,root))return;c.sizes=source.sizes;applySize();};
  const moved=()=>{closeMenu();c.cleanup?.();clearSelection();unbindOutside();outsideDocument=root.ownerDocument;bindOutside();};
  view.dom.addEventListener('hive:table-size-changed',resized);
  view.dom.addEventListener('hive:panel-document-changed',moved);
  c.dispose=()=>{
    closeMenu();unbindOutside();
    view.dom.removeEventListener('hive:panel-document-changed',moved);
    view.dom.removeEventListener('hive:table-size-changed',resized);
  };
  c.selectColumn=col=>{
    const rect={top:0,bottom:(c.item.rows?.length??1)-1,left:col,right:col};
    paint(rect);
    select((c.item.rows||[]).map((_,row)=>tableCell(c.item,row,col)!).filter(Boolean));
  };
  rows.slice(c.fromRow,c.toRow).forEach((row,index)=>{const r=c.fromRow+index,tr=document.createElement('tr');tr.dataset.row=String(r);
    Array.from({length:c.item.columns??row.length},(_,col)=>tableCell(c.item,r,col)!).forEach((cell,col)=>{const td=document.createElement(r===0?'th':'td');td.dataset.column=String(col);td.style.textAlign=alignment(col);td.dataset.cell=`${r}:${col}`;const preview=document.createElement('div');preview.className='cm-table-cell-preview';preview.dataset.row=String(r);preview.dataset.col=String(col);preview.tabIndex=0;preview.setAttribute('aria-label',`第 ${r+1} 行第 ${col+1} 列，按 Enter 编辑`);renderTableCell(preview,cell.text);preview.dataset.source=cell.text;const input=document.createElement('textarea');input.hidden=true;input.dataset.row=String(r);input.dataset.col=String(col);input.value=cell.text;input.rows=1;const fit=()=>{input.style.height='auto';input.style.height=Math.max(24,input.scrollHeight)+'px';};input.setAttribute('aria-label',`第 ${r+1} 行第 ${col+1} 列`);input.readOnly=view.state.readOnly;
      const edit=(offset?:number)=>{if(view.state.readOnly)return;preview.hidden=true;input.hidden=false;root.ownerDocument.getSelection()?.removeAllRanges();fit();input.focus({preventScroll:true});if(offset!==undefined)input.setSelectionRange(offset,offset);};
      td.addEventListener('click',event=>{
        if(suppressMouseup||(event.target as HTMLElement).closest('a,[data-hive-link],textarea,button,.cm-table-resize-col,.cm-table-resize-row'))return;
        edit(tableCellSourceOffset(preview,event.clientX,event.clientY));
      });
      preview.addEventListener('dblclick',event=>{if(suppressMouseup||!root.ownerDocument.getSelection()?.isCollapsed)return;edit(tableCellSourceOffset(preview,event.clientX,event.clientY));});
      preview.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key==='F2'){e.preventDefault();edit();}});
      preview.addEventListener('pointerdown',()=>{activeRow=r;activeCol=col;});
      input.addEventListener('blur',()=>{if(c.composition)return;const source=tableCell(c.item,r,col)?.text??'';if(preview.dataset.source!==source){renderTableCell(preview,source);preview.dataset.source=source;}input.hidden=true;preview.hidden=false;view.requestMeasure();});
      const commit=()=>{if(view.state.readOnly||c.composition?.conflict)return;const current=tableCell(c.item,r,col);if(!current)return;const part=cellContent(current,view.state.doc);if(current.virtual===undefined&&part.raw!==current.text)return;const encoded=encodeCellSource(input.value);if(current.virtual===undefined&&encoded===part.raw)return;
        let insert=encoded;if(current.virtual!==undefined){const previous=c.item.rows?.[r]?.filter(x=>x.virtual===undefined).length||0;insert=(current.trailing?' ':' | ')+Array(Math.max(0,col-previous)).fill(' | ').join('')+encoded+' |';}
        c.committing=true;try{view.dispatch({changes:{from:part.from,to:part.to,insert},userEvent:'input.type'});}finally{c.committing=false;}
      };
      let pendingMark:{from:number;to:number;x:number;y:number;doc:Text}|undefined;
      input.addEventListener('pointerdown',event=>{
        pendingMark=undefined;
        if(!isAnnotationClick(event)||!event.isPrimary||!canMark())return;
        const range=inputRange(input,r,col);
        if(range)pendingMark={...range,x:event.clientX,y:event.clientY,doc:view.state.doc};
      });
      input.addEventListener('pointercancel',()=>{pendingMark=undefined;});
      input.addEventListener('click',event=>{
        const mark=pendingMark;pendingMark=undefined;
        if(!mark||suppressMouseup||!isAnnotationClick(event)||mark.doc!==view.state.doc||Math.hypot(mark.x-event.clientX,mark.y-event.clientY)>5)return;
        event.preventDefault();event.stopPropagation();
        markRanges([{from:mark.from,to:mark.to}]);
      });
      // CodeMirror keeps the selection's block mounted outside the viewport. Pin the focused
      // cell there as well, so scrolling cannot destroy an unfinished native IME composition.
      input.addEventListener('focus',()=>{
        activeRow=r;activeCol=col;refreshActions();
        const cell=tableCell(c.item,r,col);
        // A select.pointer transaction sends Chromium's native caret back to CodeMirror.
        if(cell)view.dispatch({selection:{anchor:cell.from},userEvent:'select.table-cell'});
      });
      input.addEventListener('compositionstart',()=>{c.composition={row:r,col,source:view.state.doc.slice(c.item.from,c.item.to),conflict:false};for(const node of roots())controllers.get(node)?.refreshActions?.();});input.addEventListener('compositionend',()=>{if(c.composition?.conflict)return;c.composition=undefined;commit();for(const node of roots())controllers.get(node)?.refreshActions?.();});input.addEventListener('input',()=>{fit();if(!c.composition)commit();});input.addEventListener('keydown',e=>{if(e.isComposing||c.composition){e.stopPropagation();return;}e.stopPropagation();});td.append(preview,input,handle('widths',col),handle('heights',r));
      const edge=(label:string,kind:string,callback:()=>void)=>{const button=document.createElement('button');button.type='button';button.className=`cm-table-edge ${kind}`;button.setAttribute('aria-label',label);button.title=label;const adding=kind.includes('add');button.append(createUiIcon(document,adding?'Plus':'table.select',adding?12:8));button.addEventListener('pointerdown',e=>{e.preventDefault();e.stopPropagation();});button.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();callback();});td.append(button);return button;};
      if(col===0)edge('选择整行','cm-table-select-row',()=>{const rect={top:r,bottom:r,left:0,right:(c.item.columns??1)-1};paint(rect);select((c.item.rows||[])[r]||[]);});
      if(r===0)td.append(columnSelector(document,()=>c.selectColumn?.(col)));
      if(col===(c.item.columns??row.length)-1){const button=edge('在右侧添加列','cm-table-add-column',()=>{activeRow=r;activeCol=col;runAction('column-after');});button.dataset.tableAction='column-after';}
      if(r===(c.item.rows?.length??1)-1){root.classList.add('cm-table-final-segment');const button=edge('在下方添加行','cm-table-add-row',()=>{activeRow=r;activeCol=col;runAction('row-after');});button.dataset.tableAction='row-after';}
      tr.append(td);queueMicrotask(fit);});(r===0?head!:body).append(tr);});
  const ResizeObserverCtor=document.defaultView?.ResizeObserver;const widths=new WeakMap<Element,string>();const observer=ResizeObserverCtor?new ResizeObserverCtor(entries=>{for(const entry of entries){const width=entry.contentRect.width;const geometry=width+'|'+document.defaultView!.getComputedStyle(root).fontSize;if(widths.get(entry.target)===geometry)continue;widths.set(entry.target,geometry);if(entry.target===root||entry.target===view.dom){applySize();continue;}const input=entry.target.querySelector<HTMLTextAreaElement>('textarea');if(input){input.style.height='auto';input.style.height=Math.max(24,input.scrollHeight)+'px';}}}):undefined;observer?.observe(root);observer?.observe(view.dom);root.querySelectorAll('[data-cell]').forEach(cell=>observer?.observe(cell));const priorDispose=c.dispose;c.dispose=()=>{observer?.disconnect();priorDispose?.();};updateCellReadOnly(c);renderMarks(c);applySize();refreshActions();
}
