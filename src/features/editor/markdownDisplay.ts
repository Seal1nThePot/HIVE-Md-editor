import {EditorState,Prec,StateEffect,StateField,Transaction,type EditorSelection,type Extension} from '@codemirror/state';
import {Decoration,EditorView,ViewPlugin,WidgetType,type DecorationSet} from '@codemirror/view';
import {createUiIcon} from '../../shared/icons';
import {previewPlan,visibleReplacements,previewActiveLines,replacementSelectionSignature,localPreviewUpdate,type PreviewReplacement} from './markdownPresentation';
import type {ImageContext} from './insertions';
import {ImagePreviewWidget,imageViewSizes} from './imagePreview';
import {TableWidget,tableSizeHistory,tableStickyHeaders,selectTableSource,tableSourceSelection,tableSourceSelectionView,type TableMark} from './tableWidget';
import {annotationHighlights,setAnnotationMarks} from '../annotations/annotationDecorations';
import {markdownParseState} from './markdownParse';
import {tableSegments} from './tableViewport';
import {MathWidget} from './mathWidget';
import {frontmatterVisible,subscribeFrontmatterVisibility} from './frontmatterVisibility';
import {typographyUpdateQueue} from '../typography/typographyUpdateQueue';
import {isolateHistory} from '@codemirror/commands';
import {codeBlockViewport} from './codeBlockViewport';
import {MermaidWidget} from './mermaidWidget';
import {detailsOpenState, detailsReplacements} from './detailsBlocks';

export type DisplayMode='live'|'preview'|'source';
export const setDisplayMode=StateEffect.define<DisplayMode>(),setPreviewFocus=StateEffect.define<boolean>();
export const displayModeField=StateField.define<DisplayMode>({
  create:()=> 'live',
  update(value,tr){for(const effect of tr.effects)if(effect.is(setDisplayMode))value=effect.value;return value;},
  provide:field=>[
    EditorView.editorAttributes.from(field,value=>({'data-display-mode':value})),
    Prec.highest(EditorState.readOnly.computeN([field],state=>state.field(field)==='preview'?[true]:[])),
    Prec.highest(EditorView.editable.computeN([field],state=>state.field(field)==='preview'?[false]:[])),
  ],
});
const previewReadOnly=EditorState.changeFilter.of(tr=>tr.startState.field(displayModeField)!=='preview'||tr.isUserEvent('input.shared-document')||tr.isUserEvent('input.disk-sync'));
type PreviewFocus={focused:boolean;pointer:boolean;selection:EditorSelection|null;pointerMath:EditorSelection|null};
export const finishPreviewPointer=StateEffect.define<null>();
const previewFocus=StateField.define<PreviewFocus>({
  create:()=>({focused:false,pointer:false,selection:null,pointerMath:null}),
  update(value,tr){
    for(const effect of tr.effects)if(effect.is(setPreviewFocus)){
      return {focused:effect.value,pointer:false,selection:effect.value&&!tr.state.field(tableSourceSelection,false)?tr.newSelection:null,pointerMath:null};
    }
    if(tr.isUserEvent(selectTableSource))return {...value,pointer:false,selection:null,pointerMath:null};
    if(value.pointer&&tr.effects.some(effect=>effect.is(finishPreviewPointer)))return {focused:true,pointer:false,selection:tr.newSelection,pointerMath:tr.newSelection};
    if(tr.isUserEvent('select.pointer'))return value.pointer?value:{...value,pointer:true};
    if(tr.isUserEvent('select.widget')||((value.focused||value.pointer)&&(tr.selection||tr.docChanged))){
      if(tr.isUserEvent('input.shared-document')||tr.isUserEvent('input.disk-sync')){
        return {...value,selection:value.selection?.map(tr.changes)??null,pointerMath:value.pointerMath?.map(tr.changes)??null};
      }
      return {focused:true,pointer:false,selection:tr.newSelection,pointerMath:null};
    }
    return value;
  },
});
const previewPointerRelease=ViewPlugin.define(view=>{
  let doc=view.contentDOM.ownerDocument;
  let frame:number|undefined,pressed=false,released=false;

  function cancel(){
    if(frame!==undefined)doc.defaultView?.cancelAnimationFrame(frame);
    frame=undefined;
  }
  function schedule(){
    if(frame!==undefined||!released)return;
    // Let CodeMirror's document mouseup handler finish any pending selection first.
    frame=doc.defaultView?.requestAnimationFrame(()=>{
      frame=undefined;
      if(view.compositionStarted)return;
      released=false;
      if(view.state.field(displayModeField)==='live'&&view.state.field(previewFocus).pointer){
        view.dispatch({effects:finishPreviewPointer.of(null)});
      }
    });
  }
  function down(event:MouseEvent){
    if(event.button!==0)return;
    cancel();
    pressed=true;
    released=false;
  }
  function up(event:MouseEvent){
    if(event.button!==0||(!pressed&&!view.state.field(previewFocus).pointer))return;
    pressed=false;
    released=true;
    schedule();
  }
  function moved(){
    const next=view.contentDOM.ownerDocument;
    if(next===doc)return;
    cancel();
    doc.removeEventListener('mouseup',up,true);
    doc=next;
    doc.addEventListener('mouseup',up,true);
    schedule();
  }
  view.contentDOM.addEventListener('mousedown',down,true);
  view.contentDOM.addEventListener('compositionend',schedule,true);
  view.dom.addEventListener('hive:panel-document-changed',moved);
  doc.addEventListener('mouseup',up,true);
  return {destroy(){
    cancel();
    view.contentDOM.removeEventListener('mousedown',down,true);
    view.contentDOM.removeEventListener('compositionend',schedule,true);
    view.dom.removeEventListener('hive:panel-document-changed',moved);
    doc.removeEventListener('mouseup',up,true);
  }};
});
export const setFrontmatterVisibility=StateEffect.define<boolean>();
export const frontmatterVisibilityField=StateField.define<boolean>({create:()=>frontmatterVisible(),update(value,tr){for(const effect of tr.effects)if(effect.is(setFrontmatterVisibility))value=effect.value;return value;}});
const setImageContext=StateEffect.define<ImageContext|null>(),imageContext=StateField.define<ImageContext|null>({create:()=>null,update(value,tr){for(const effect of tr.effects)if(effect.is(setImageContext))value=effect.value;return value;}});

class PreviewWidget extends WidgetType{
  constructor(readonly item:PreviewReplacement,readonly propertyText?:string,readonly readOnly=false){super();}
  eq(other:PreviewWidget){return (this.item===other.item||this.item.kind===other.item.kind&&this.item.from===other.item.from&&this.item.to===other.item.to&&this.item.text===other.item.text&&this.item.src===other.item.src)&&this.propertyText===other.propertyText&&this.readOnly===other.readOnly;}
  toDOM(view:EditorView){
    const document=view.dom.ownerDocument;
    const item=this.item;
    const edit=(element:HTMLElement,from=item.from)=>element.addEventListener('mousedown',event=>{if(view.state.readOnly)return;event.preventDefault();event.stopPropagation();view.dispatch({selection:{anchor:from},userEvent:'select.widget'});view.focus();});
    if(item.kind==='properties'){const block=document.createElement('div');block.className='cm-preview-properties';block.textContent=this.propertyText||'';if(!this.readOnly)block.title='点击编辑属性源码';edit(block);return block;}
    if(item.kind==='rule'){const hr=document.createElement('hr');hr.className='cm-preview-rule';edit(hr);return hr;}
    if(item.kind==='task'){
      const button=document.createElement('button');button.type='button';button.className='cm-preview-task';
      const checked=item.text==='☑';button.append(createUiIcon(document,checked?'SquareCheck':'Square',14));button.setAttribute('role','checkbox');button.setAttribute('aria-checked',String(checked));button.setAttribute('aria-label',checked?'取消完成待办':'完成待办');button.disabled=view.state.readOnly;
      button.addEventListener('mousedown',event=>{event.preventDefault();event.stopPropagation();});
      button.addEventListener('click',event=>{
        event.preventDefault();event.stopPropagation();if(view.state.readOnly)return;
        const marker=view.state.sliceDoc(item.from,item.to);if(!/^\[[ xX]\]$/.test(marker))return;
        view.dispatch({changes:{from:item.from+1,to:item.from+2,insert:marker[1]===' '?'x':' '},effects:view.scrollSnapshot(),annotations:isolateHistory.of('full'),userEvent:'input.task'});
      });
      return button;
    }
    const span=document.createElement('span');span.className='cm-preview-'+item.kind;
    span.textContent=item.text||'';
    return span;
  }
  ignoreEvent(){return false;}
}
export const markdownPreview=StateField.define<DecorationSet>({
  create:build,
  update(value,tr){
    if(tr.docChanged||tr.state.field(detailsOpenState,false)!==tr.startState.field(detailsOpenState,false)||tr.state.field(imageViewSizes,false)!==tr.startState.field(imageViewSizes,false)||tr.effects.some(effect=>effect.is(setDisplayMode)||effect.is(setImageContext)||effect.is(setAnnotationMarks)||effect.is(setFrontmatterVisibility)))return build(tr.state);
    if(tr.state.field(displayModeField)==='preview')return value;
    const prior=tr.startState.field(previewFocus,false),next=tr.state.field(previewFocus,false);
    const before=prior?.selection??null,after=next?.selection??null;
    if(before!==after&&(activeLines(tr.state,before)!==activeLines(tr.state,after)||
      replacementSelectionSignature(tr.state,'image',before)!==replacementSelectionSignature(tr.state,'image',after)||
      replacementSelectionSignature(tr.state,'ordered-marker',before)!==replacementSelectionSignature(tr.state,'ordered-marker',after)))return build(tr.state);
    const priorMath=prior?.pointerMath??null,nextMath=next?.pointerMath??null;
    if(priorMath!==nextMath){
      const mathChanged=priorMath&&nextMath
        ? replacementSelectionSignature(tr.state,'math',priorMath)!==replacementSelectionSignature(tr.state,'math',nextMath)
        : previewPlan(tr.state).replacements.some(item=>item.kind==='math');
      if(mathChanged)return build(tr.state);
    }
    return value;
  },
  provide:field=>EditorView.decorations.from(field),
});
const punctuationJoin=Decoration.mark({class:'cm-preview-punctuation-join'});
const codePunctuationJoin=Decoration.mark({class:'cm-preview-code-punctuation-join'});
const punctuationJoins=EditorView.outerDecorations.compute([displayModeField,previewFocus,'doc'],state=>{
  const mode=state.field(displayModeField);
  if(mode==='source')return Decoration.none;
  const active=mode==='preview'?[]:previewActiveLines(state,state.field(previewFocus).selection);
  return Decoration.set(previewPlan(state).punctuation
    .filter(item=>!active.some(line=>item.from<=line.to&&item.to>line.from))
    .map(item=>(item.codeGroup?codePunctuationJoin:punctuationJoin).range(item.from,item.to)),true);
});
function activeLines(state:EditorState,selection:EditorSelection|null){return previewActiveLines(state,selection).map(line=>`${line.from}:${line.to}`).join(',');}
class WideTableNotice extends WidgetType{
  constructor(readonly readOnly:boolean){super();}
  eq(other:WideTableNotice){return this.readOnly===other.readOnly;}
  toDOM(view:EditorView){const note=view.dom.ownerDocument.createElement('div');note.className='cm-table-source-notice';note.textContent=this.readOnly?'此表列数较多，以下显示原始 Markdown。':'此表列数较多，以下直接编辑 Markdown 源码；所有内容与撤销记录均保留。';return note;}
}
function build(state:EditorState){
  if(state.field(displayModeField,false)==='source')return Decoration.none;
  const ranges=[];
  const plan=previewPlan(state),focus=state.field(displayModeField)==='preview'?undefined:state.field(previewFocus,false);
  const selection=focus?.selection??null,pointerMath=focus?.pointerMath??null;
  const details=detailsReplacements(state,previewActiveLines(state,selection),setPreviewFocus.of(false));
  ranges.push(...details.ranges);
  const items=visibleReplacements(state,!!(selection||pointerMath),selection,pointerMath)
    .filter(item=>!details.hidden.some(span=>item.from<span.to&&item.to>span.from));
  const active=previewActiveLines(state,selection),rawTaskLines=new Set<number>();
  // A revealed source marker occupies the same hanging column as its preview widget.
  // Task items keep their existing editable prefix and interactive checkbox.
  const visibleList=new Set(items.filter(item=>item.list));
  const rawList=selection?plan.replacements.filter(item=>item.list&&!visibleList.has(item)&&active.some(line=>item.reveal.from<=line.to&&item.reveal.to>line.from)):[];
  for(const item of rawList)if(item.list==='task-marker')rawTaskLines.add(state.doc.lineAt(item.from).from);
  for(const item of rawList){
    if(rawTaskLines.has(state.doc.lineAt(item.from).from))continue;
    const className=item.list==='padding'?'cm-preview-list-source-padding':'cm-preview-list-source-marker';
    ranges.push(Decoration.mark({class:className}).range(item.from,item.to));
  }
  for(const style of plan.styles){
    if(style.list&&rawTaskLines.has(style.from))continue;
    const attributes:Record<string,string>={};if(style.align)attributes.style=`text-align: ${style.align}`;if(style.title)attributes.title=style.title;
    const reveal=style.linkReveal,sourceLink=reveal&&active.some(line=>reveal.from<=line.to&&reveal.to>line.from);
    if(style.link&&!sourceLink)attributes['data-hive-link']=style.link;
    if(style.list)attributes.style=`--hive-list-depth: ${style.list.depth}; --hive-list-offset: ${style.list.offset}; --hive-list-marker-width: ${style.list.width}`;
    if(style.line)ranges.push(Decoration.line({class:style.className,attributes}).range(style.from));
    else if(style.to>style.from)ranges.push(Decoration.mark({class:sourceLink?'cm-source-link':style.className,attributes}).range(style.from,style.to));
  }
  const marks:TableMark[]=[];state.field(annotationHighlights,false)?.between(0,state.doc.length,(from,to,decoration)=>{const id=decoration.spec.attributes?.['data-annotation-id'];if(id)marks.push({from,to,id,note:decoration.spec.attributes?.['aria-label']||'文本标注'});});
  const showProperties=state.field(frontmatterVisibilityField,false)!==false;
  if(!showProperties){const property=previewPlan(state).replacements.find(item=>item.kind==='properties');if(property&&!items.includes(property))items.push(property);}
  for(const item of items){
    if(item.kind==='properties'&&!showProperties){ranges.push(Decoration.replace({block:true,inclusiveEnd:false}).range(item.from,item.to));continue;}
    if(item.kind==='table'){
      const segments=tableSegments(item,state.doc);
      if(!segments.length){ranges.push(Decoration.widget({widget:new WideTableNotice(state.readOnly),block:true,side:-1}).range(item.from));continue;}
      for(const segment of segments)ranges.push(Decoration.replace({block:true,widget:new TableWidget(item,state.field(imageContext,false)||null,marks.filter(mark=>mark.from<segment.to&&mark.to>segment.from),segment.fromRow,segment.toRow)}).range(segment.from,segment.to));
    }else if(item.kind==='image'){
      const size=state.field(imageViewSizes,false)?.get(item.from), width=size&&size.src===item.src&&size.to===item.to?size.width:1;
      ranges.push(Decoration.replace({widget:new ImagePreviewWidget(item,state.field(imageContext,false)||null,width,state.readOnly)}).range(item.from,item.to));
    }else if(item.kind==='mermaid'){
      ranges.push(Decoration.replace({block:true,widget:new MermaidWidget(item,state.field(displayModeField)==='preview')}).range(item.from,item.to));
    }else if(item.kind==='math'){
      const widget=new MathWidget(item,state.doc);
      if(item.text){
        ranges.push(Decoration.widget({widget,block:item.block,side:-1}).range(item.from));
        ranges.push(Decoration.mark({class:'cm-math-source'}).range(item.from,item.to));
      }else ranges.push(Decoration.replace({block:item.block,widget}).range(item.from,item.to));
    // A hidden source line may end exactly where the next line's decoration starts.
    // Keep that endpoint outside the block replacement so its heading/paragraph style survives.
    }else ranges.push(Decoration.replace({block:item.block,inclusiveEnd:false,widget:item.kind?new PreviewWidget(item,item.kind==='properties'?state.sliceDoc(item.from,item.to).trimEnd():undefined,state.field(displayModeField)==='preview'):undefined}).range(item.from,item.to));
  }
  return Decoration.set(ranges,true);
}
export const markdownDisplayTheme=EditorView.baseTheme({
  '.cm-preview-details-heading':{display:'flex',alignItems:'center',gap:'6px',margin:'5px clamp(12px, 6.4%, 50px)',border:'1px solid var(--hive-surface-border)',borderRadius:'5px',background:'color-mix(in srgb, var(--hive-accent) 8%, transparent)'},
  '.cm-preview-details-heading button':{border:'0',background:'transparent',font:'inherit',color:'inherit',cursor:'pointer',padding:'5px 9px'},
  '.cm-preview-details-toggle':{display:'flex',alignItems:'center',gap:'7px',flex:'1',minWidth:'0',textAlign:'left',overflowWrap:'anywhere',whiteSpace:'normal'},
  '.cm-preview-details-toggle > svg':{flex:'none',color:'var(--muted)'},
  '.cm-preview-details-toggle::after':{content:'attr(data-details-action)',marginLeft:'auto',paddingLeft:'8px',flexShrink:'0',fontSize:'.8em',color:'var(--muted)'},
  '.cm-preview-details-hint':{flex:'none',paddingRight:'9px',fontSize:'.8em',color:'var(--muted)'},
  '.cm-preview-details-edit':{flex:'none',fontSize:'.8em !important'},
  '.cm-format-highlight':{backgroundColor:'var(--hive-editor-text-highlight-background, #eab30847)',borderRadius:'2px'},
  '.cm-format-underline':{textDecoration:'underline',textUnderlineOffset:'3px'},
  '.cm-preview-strong':{fontWeight:'700'},'.cm-preview-emphasis':{fontStyle:'italic'},'.cm-preview-strike':{textDecoration:'line-through'},
  '.cm-preview-code-line':{
    '--hive-code-block-edge':'color-mix(in srgb, var(--hive-document-text) 23%, var(--hive-document-bg))',
    '--hive-code-block-fill':'color-mix(in srgb, var(--hive-accent) 7%, var(--hive-document-bg))',
    '--hive-code-block-top':'transparent',
    '--hive-code-block-bottom':'transparent',
    '--hive-code-block-shadow':'inset 1px 0 var(--hive-code-block-edge), inset -1px 0 var(--hive-code-block-edge), inset 0 1px var(--hive-code-block-top), inset 0 -1px var(--hive-code-block-bottom)',
    backgroundColor:'var(--hive-code-block-fill)',boxShadow:'var(--hive-code-block-shadow)',
  },
  '.cm-preview-code-line:not(.cm-preview-code-opening, .cm-preview-code-closing)':{fontFamily:'Consolas, monospace',lineHeight:'1.65'},
  '.cm-preview-code-opening, .cm-preview-code-first:not(.cm-preview-code-opening + .cm-preview-code-first)':{
    '--hive-code-block-top':'var(--hive-code-block-edge)',borderTopLeftRadius:'5px',borderTopRightRadius:'5px',
  },
  '.cm-preview-code-closing, .cm-preview-code-last:not(:has(+ .cm-preview-code-closing))':{
    '--hive-code-block-bottom':'var(--hive-code-block-edge)',borderBottomLeftRadius:'5px',borderBottomRightRadius:'5px',
  },
  '.cm-preview-punctuation-join':{whiteSpace:'pre'},
  '.cm-preview-code-punctuation-join':{display:'inline-block',maxWidth:'100%',textIndent:'0',whiteSpace:'pre-wrap'},
  // The final-grapheme join divides the code mark into two adjacent spans.
  '.cm-preview-code-punctuation-join:has(.cm-preview-punctuation-join) .cm-preview-inline-code:not(.cm-preview-code-punctuation-join .cm-preview-punctuation-join .cm-preview-inline-code)':{
    paddingInlineEnd:'0',borderStartEndRadius:'0',borderEndEndRadius:'0',
  },
  '.cm-preview-code-punctuation-join .cm-preview-punctuation-join .cm-preview-inline-code':{
    paddingInlineStart:'0',borderStartStartRadius:'0',borderEndStartRadius:'0',
  },
  '.cm-preview-inline-code':{fontFamily:'Consolas, monospace',backgroundColor:'color-mix(in srgb, var(--hive-document-text) 5%, transparent)',borderRadius:'3px',padding:'1px 3px'},
  '.cm-preview-quote':{backgroundImage:'linear-gradient(var(--hive-surface-border), var(--hive-surface-border))',backgroundSize:'2px 100%',backgroundRepeat:'no-repeat',backgroundPosition:'max(0px, calc(clamp(12px, 6.4%, 50px) - 10px)) 0',color:'var(--hive-document-text, var(--text))'},
  '.cm-preview-link':{color:'var(--hive-document-text, var(--text))',textDecoration:'underline',textUnderlineOffset:'3px'},
  '.cm-preview-bullet':{color:'var(--hive-document-text, var(--text))'},'.cm-preview-task':{color:'var(--hive-document-text, var(--text))',fontFamily:'inherit',border:'0',padding:'0',background:'transparent',cursor:'pointer',lineHeight:'inherit'},'.cm-preview-task > svg':{verticalAlign:'-0.125em'},'.cm-preview-task:disabled':{cursor:'default'},
  '.cm-preview-image':{display:'block',width:'var(--hive-image-view-width, 100%)',maxWidth:'100%',position:'relative',boxSizing:'border-box',color:'var(--hive-document-text, var(--text))'},
  '.cm-preview-image img':{display:'block',width:'100%',height:'auto',borderRadius:'4px'},
  '.cm-preview-image-unavailable':{display:'inline-flex',alignItems:'center',gap:'4px',width:'auto',padding:'4px 8px',border:'1px solid var(--hive-surface-border)',borderRadius:'4px'},
  '.cm-preview-image-unavailable > svg':{flex:'none'},
  '.cm-preview-image-resize':{position:'absolute',right:'3px',bottom:'3px',width:'22px',height:'22px',border:'1px solid var(--hive-surface-border)',borderRadius:'4px',background:'var(--hive-panel-bg)',color:'var(--text)',cursor:'nwse-resize',touchAction:'none',opacity:'0',pointerEvents:'none',padding:'0'},
  '.cm-preview-image-resize::after':{content:'""',width:'8px',height:'8px',borderBottom:'2px solid currentColor',borderRight:'2px solid currentColor'},
  '.cm-preview-image:hover .cm-preview-image-resize, .cm-preview-image-resize:focus-visible, .cm-preview-image-resizing .cm-preview-image-resize':{opacity:'1',pointerEvents:'auto'},
  '.cm-preview-image-resize:disabled':{display:'none'},
  '.cm-preview-properties':{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:'.8em',color:'var(--hive-document-text, var(--text))',padding:'5px 12px',marginBottom:'8px',borderBottom:'1px solid var(--hive-surface-border)',cursor:'text'},
  '.cm-preview-rule':{border:'0',borderTop:'1px solid var(--hive-document-text, var(--text))',margin:'14px 50px'},
  '.cm-table-source-notice':{padding:'5px 50px',color:'var(--hive-document-text, var(--text))',fontSize:'.85em'},
  '.cm-table-marked[data-annotation-visible]':{backgroundColor:'color-mix(in srgb, var(--hive-accent) 19%, transparent)'},
  '.cm-table-select-top':{borderTop:'2px solid var(--hive-accent) !important'},
  '.cm-table-select-bottom':{borderBottom:'2px solid var(--hive-accent) !important'},
  '.cm-table-select-left':{borderLeft:'2px solid var(--hive-accent) !important'},
  '.cm-table-select-right':{borderRight:'2px solid var(--hive-accent) !important'},
  '.cm-table-widget button':{border:'0',background:'transparent',color:'var(--hive-document-text, var(--text))',cursor:'pointer'},
  '.cm-table-widget textarea':{display:'block',boxSizing:'border-box',width:'100%',minWidth:'40px',minHeight:'24px',height:'100%',resize:'none',border:'0',outline:'0',background:'transparent',color:'inherit',font:'inherit',overflow:'hidden'},
  '.cm-preview-table th,.cm-preview-table td':{position:'relative'},
  '.cm-table-resize-col':{position:'absolute',right:'-4px',top:'0',height:'100%',width:'8px',cursor:'col-resize',zIndex:'2'},
  '.cm-table-resize-row':{position:'absolute',bottom:'-4px',left:'0',width:'100%',height:'8px',cursor:'row-resize',zIndex:'2'},
  '.cm-preview-table':{borderCollapse:'collapse',tableLayout:'fixed',fontSize:'.95em'},
  '.cm-preview-table td,.cm-preview-table th':{border:'1px solid color-mix(in srgb, var(--hive-document-text, var(--text)) 20%, transparent)',padding:'6px 12px',textAlign:'left'},
  '.cm-mermaid-widget':{margin:'12px clamp(12px, 6.4%, 50px)',maxWidth:'100%',overflow:'auto',position:'relative'},
  '.cm-mermaid-widget svg':{display:'block',maxWidth:'100%',height:'auto'},
  '.cm-mermaid-widget button':{display:'block',marginBottom:'6px',font:'inherit',fontSize:'.8em',color:'var(--hive-document-text, var(--text))',background:'transparent',border:'1px solid var(--hive-surface-border)',borderRadius:'4px',cursor:'pointer'},
  '.cm-mermaid-widget pre':{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:'.85em'},
  '.cm-preview-table th':{background:'color-mix(in srgb, var(--hive-document-text) 4%, transparent)',fontWeight:'600'},
});
const frontmatterVisibilityPlugin=ViewPlugin.define(view=>{
  let composing=false,timer:ReturnType<typeof setTimeout>|undefined;
  const queue=typographyUpdateQueue<boolean>({composing:()=>composing||view.composing,schedule:callback=>setTimeout(callback,0),cancel:id=>clearTimeout(id as ReturnType<typeof setTimeout>),apply:visible=>{if(view.state.field(frontmatterVisibilityField)===visible)return;view.dispatch({effects:[setFrontmatterVisibility.of(visible),view.scrollSnapshot()],annotations:Transaction.addToHistory.of(false)});}});
  queue.request(frontmatterVisible());
  const unsubscribe=subscribeFrontmatterVisibility(()=>queue.request(frontmatterVisible()));
  const start=()=>{composing=true;},end=()=>{composing=false;clearTimeout(timer);timer=setTimeout(()=>queue.released(),0);};
  view.dom.addEventListener('compositionstart',start,true);view.dom.addEventListener('compositionend',end,true);
  return {update(){queue.released();},destroy(){unsubscribe();queue.dispose();clearTimeout(timer);view.dom.removeEventListener('compositionstart',start,true);view.dom.removeEventListener('compositionend',end,true);}};
});
export const markdownDisplayExtensions:Extension=[displayModeField,previewReadOnly,frontmatterVisibilityField,frontmatterVisibilityPlugin,previewFocus,previewPointerRelease,imageContext,markdownParseState,localPreviewUpdate,detailsOpenState,imageViewSizes,markdownPreview,punctuationJoins,markdownDisplayTheme,codeBlockViewport,tableSourceSelection,tableSourceSelectionView,tableSizeHistory,tableStickyHeaders,EditorView.focusChangeEffect.of((state,focused)=>focused&&state.field(previewFocus).pointer?null:setPreviewFocus.of(focused))];
export function configureImageContext(view:EditorView,context:ImageContext|null){
  if(view.state.field(imageContext,false)===undefined)view.dispatch({effects:StateEffect.appendConfig.of(imageContext)});
  const current=view.state.field(imageContext);if(current?.file!==context?.file||current?.workspace!==context?.workspace)view.dispatch({effects:setImageContext.of(context)});
}
export function configureMarkdownDisplay(view:EditorView,mode:DisplayMode){
  if(view.state.field(displayModeField,false)===undefined)view.dispatch({effects:StateEffect.appendConfig.of(markdownDisplayExtensions)});
  if(view.state.field(displayModeField)!==mode)view.dispatch({effects:setDisplayMode.of(mode)});
  if(!view.hasFocus&&view.state.field(previewFocus).focused)view.dispatch({effects:setPreviewFocus.of(false)});
}
