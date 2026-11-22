import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import {usePanelDocument} from '../../shared/panelDocument';
import { EditorState, EditorSelection, StateEffect, Compartment, Prec, type Text } from "@codemirror/state";
import {linkAt} from './linkNavigation';
import {openExternalHttpLink,parseExternalHttpLink} from '../../shared/externalLinks';
import EditorContextMenu, {type AnnotationContext} from './EditorContextMenu';
import {previewAnnotationHint,textAnnotationHit} from '../annotations/annotationGesture';
import {useAnnotationSelectionGesture} from '../annotations/useAnnotationSelectionGesture';
import {useShortcutPreferences} from '../settings/ShortcutPreferences';
import {matchesShortcut,type ShortcutId} from '../settings/shortcuts';
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab, insertNewline, undo, redo,
} from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches,getSearchQuery,findNext,findPrevious } from "@codemirror/search";
import {floatingSearchExtensions,configureFloatingSearch} from './searchTools';
import {useFileWorkspace} from '../files/WorkspaceContext';
import { markdown } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  syntaxHighlighting,
  bracketMatching,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {annotationFrames} from '../annotations/annotationFrames';
import { annotationHighlights } from "../annotations/annotationDecorations";
import {inlineProposalField,setInlineProposal,type InlineProposal} from './proposalInline';
import {configureMarkdownDisplay,configureImageContext,markdownDisplayExtensions,displayModeField,setDisplayMode} from './markdownDisplay';
import {sourceMarkdownLanguage} from './sourceSyntax';
import {fencedCodeHighlight,fencedCodeLanguage} from './codeHighlight';
import {inlineFormatting,paragraphAlignment,type Alignment,type InlineFormat} from './formatting';
import {configureTypewriter,typewriterExtensions} from './typewriter';
import {usePanelActivity} from '../../shared/panelActivity';
import {deferredEditorSleep} from './editorSleep';
import {configureTypography,typographyExtensions} from '../typography/typographyExtension';
import {type EditorDisplayMode, type SplitOrder, underlyingDisplayMode, synchronizeScroll, splitScrollIntent, sourceTransaction, mirrorTransaction} from './splitView';
import './split-view.css';
import {headingFolding,foldingEffects,isFoldingEffect,foldingMarker} from './headingFolding';
import './headingFolding.css';
import {codeModeExtensions,codeModeMarker} from './codeMode';
import {splitPadding,setSplitPadding,splitTopPadding,setSplitTopPadding,splitBlockPadding,setSplitBlockPadding,alignSplitViews} from './splitAlignment';
import {outlineTree} from './markdownParse';

const colors = HighlightStyle.define([
  {tag:tags.heading1,class:'cm-markdown-h1'},
  {tag:tags.heading2,class:'cm-markdown-h2'},
  {tag:tags.heading3,class:'cm-markdown-h3'},
  {tag:tags.heading4,class:'cm-markdown-h4'},
  {tag:tags.heading5,class:'cm-markdown-h5'},
  {tag:tags.heading6,class:'cm-markdown-h6'},
  { tag: tags.processingInstruction, color: "var(--hive-document-text, var(--text))" },
  { tag: tags.emphasis, fontStyle: "italic", color: "var(--hive-document-text, var(--text))" },
  { tag: tags.strong, fontWeight: "700", color: "var(--hive-document-text, var(--text))" },
  { tag: tags.link, class: 'cm-source-link' },
  { tag: tags.monospace, color: "var(--hive-document-text, var(--text))", backgroundColor: "color-mix(in srgb, var(--hive-document-text) 5%, transparent)" },
  { tag: tags.quote, color: "var(--hive-document-text, var(--text))" },
]);
const documentUpdateListener = new Compartment();

const preserveEmptyListMarker = Prec.highest(keymap.of([{key:'Enter',run(view) {
  if (view.composing) return false;
  const {state}=view;
  const emptyListItems=state.selection.ranges.every(range=>{
    if (!range.empty) return false;
    const line=state.doc.lineAt(range.from);
    const marker=/^(?:[ \t]*>[ \t]?)*[ \t]*(?:[-+*]|\d{1,9}[.)])(?=[ \t]*$)/.exec(line.text);
    if (!marker) return false;
    const end=line.from+marker[0].length;
    return range.from>=end && outlineTree(state).resolveInner(end,-1).name==='ListMark';
  });
  return emptyListItems && insertNewline(view);
}}]));

function withDisplayMode(state:EditorState,mode:EditorDisplayMode){
  const display=underlyingDisplayMode(mode),current=state.field(displayModeField,false);
  return current===display?state:state.update({effects:[
    ...(current===undefined?[StateEffect.appendConfig.of(markdownDisplayExtensions)]:[]),
    setDisplayMode.of(display),
  ]}).state;
}

function editorLinkAt(editor:EditorView,target:HTMLElement,point:{x:number;y:number},sourceShortcut:boolean){
  const rendered=target.closest<HTMLElement>('[data-hive-link]');
  if(!rendered&&!sourceShortcut)return;
  const pos=rendered?null:editor.posAtCoords(point);
  const raw=rendered?.dataset.hiveLink||(pos!==null?linkAt(editor.state,pos):undefined);
  if(!raw)return;
  const link=raw.trim().replace(/^<([^<>]+)>$/,'$1');
  return parseExternalHttpLink(link)||(!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link)?link:undefined);
}

const preventRepeatedIndent = Prec.highest(EditorView.domEventHandlers({
  keydown(event, view) {
    if (event.key !== 'Tab' || !event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
        event.isComposing || view.composing || view.state.readOnly) return false;
    const target = event.target as HTMLElement | null;
    return !!target && view.contentDOM.contains(target) && !target.closest('input,textarea,button,[contenteditable=false]');
  },
}));

export function rebindDocumentUpdates(state: EditorState, onUpdate: (update: ViewUpdate) => void) {
  return state.update({effects: documentUpdateListener.reconfigure(EditorView.updateListener.of(onUpdate))}).state;
}

export function makeState(
  doc: string|Text,
  onUpdate: (u: ViewUpdate) => void,
  label = "Markdown 正文编辑器",
  displayMode:EditorDisplayMode='live',
) {
  return EditorState.create({
    doc,
    extensions: [
      markdown({ base: sourceMarkdownLanguage, codeLanguages:fencedCodeLanguage }),
      preserveEmptyListMarker,
      annotationHighlights,
      annotationFrames,
      inlineProposalField,
      markdownDisplayExtensions,
      headingFolding,
      displayModeField.init(()=>underlyingDisplayMode(displayMode)),
      floatingSearchExtensions,
      typewriterExtensions,
      typographyExtensions,
      codeModeExtensions,
      splitPadding,
      splitTopPadding,
      splitBlockPadding,
      splitScrollIntent,
      EditorState.allowMultipleSelections.of(true),
      EditorState.phrases.of({Find:'查找',Replace:'替换',next:'下一处',previous:'上一处',all:'全部','match case':'区分大小写',regexp:'正则表达式','by word':'全词',replace:'替换','replace all':'全部替换',close:'关闭'}),
      history(),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      highlightSelectionMatches(),
      preventRepeatedIndent,
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap.filter(binding=>binding.run!==undo&&binding.run!==redo),
        ...searchKeymap.filter(binding=>!['Mod-f','F3','Mod-g'].includes(binding.key||'')),
        indentWithTab,
      ]),
      syntaxHighlighting(colors),
      fencedCodeHighlight,
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        "aria-label": label,
        spellcheck: "false",
      }),
      documentUpdateListener.of(EditorView.updateListener.of(onUpdate)),
      EditorView.theme(
        {
          "&": {
            height: "100%",
            backgroundColor: "transparent",
            color: "var(--hive-document-text, var(--text))",
            fontSize: "var(--editor-font-size, 15px)",
          },
          ".cm-scroller": {
            fontFamily:
              '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
            overflow: "auto",
          },
          ".cm-content": {
            padding: "12px 0 120px",
            caretColor: "var(--hive-document-text, var(--text))",
            margin: "0 auto",
            width: "100%",
          },
          ".cm-line": { padding: "2px 50px" },
          "&.cm-focused": { outline: "none" },
          ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--hive-document-text) 2%, transparent)" },
          ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
            background: "var(--hive-selection-bg)",
          },
          ".cm-cursor": { borderLeftColor: "var(--hive-document-text, var(--text))" },
          ".cm-panels": {
            background: "var(--hive-popup-bg, var(--panel))",
            color: "var(--hive-popup-text, var(--text))",
            borderColor: "var(--hive-popup-border, var(--line))",
          },
          ".cm-searchMatch": { background: "color-mix(in srgb, var(--hive-accent) 23%, transparent)" },
          ".cm-searchMatch-selected": { background: "color-mix(in srgb, var(--hive-accent) 44%, transparent)" },
          ".cm-textfield": {
            background: "var(--hive-input-bg, var(--bg))",
            border: "1px solid var(--hive-input-border, var(--line))",
            color: "var(--hive-popup-text, var(--text))",
          },
          ".cm-button": {
            background: "var(--hive-input-bg, var(--panel))",
            color: "var(--hive-popup-text, var(--text))",
            border: "1px solid var(--hive-popup-border, var(--line))",
          },
          ".cm-tooltip": {
            background: "var(--hive-popup-bg, var(--panel))",
            color: "var(--hive-popup-text, var(--text))",
            border: "1px solid var(--hive-popup-border, var(--line))",
          },
        },
        { dark: true },
      ),
    ],
  });
}
export default function Editor({
  onReady,
  onUpdate,
  onMarkSelection,
  onUnmarkSelection,
  onShowAnnotations,
  onError,
  onFocus,
  onFind,
  onOpenLink,
  onDraftSelection,
  documentFile='',
  annotationTool=false,
  searchActive=false,
  typewriter=false,
  displayMode='live',
  splitOrder='source-first',
  initialState=null,
  keepAlive=false,
  inlineProposal=null,
}: {
  onReady: (v: EditorView | null) => void;
  onUpdate: (u: ViewUpdate) => void;
  onMarkSelection?:()=>void;
  onUnmarkSelection?:(id?:string)=>void;
  onShowAnnotations?:(context:AnnotationContext)=>void;
  onError?:(message:string)=>void;
  onFocus?:()=>void;
  onFind?:(replace?:boolean)=>void;
  onOpenLink?:(target:string)=>void;
  onDraftSelection?:(text:string,table?:{ordinal:number})=>void;
  documentFile?:string;
  annotationTool?:boolean;
  searchActive?:boolean;
  typewriter?:boolean;
  displayMode?:EditorDisplayMode;
  splitOrder?:SplitOrder;
  initialState?:EditorState|null;
  keepAlive?:boolean;
  inlineProposal?:InlineProposal|null;
}) {
  const fileWorkspace=useFileWorkspace();
  const {bindings}=useShortcutPreferences();
  const panelDocument=usePanelDocument();
  const beginAnnotationSelection=useAnnotationSelectionGesture(panelDocument,onMarkSelection);
  const host = useRef<HTMLDivElement>(null),
    callback = useRef(onUpdate);
  const mainHost=useRef<HTMLDivElement>(null),sourceHost=useRef<HTMLDivElement>(null),sourceRef=useRef<EditorView|null>(null);
  const currentMode=useRef(displayMode);currentMode.current=displayMode;
  const split=displayMode==='split';
  const [splitRatio,setSplitRatio]=useState(.5),[splitWidth,setSplitWidth]=useState(0),[splitDragging,setSplitDragging]=useState(false);
  const stopSplitDrag=useRef<(()=>void)|null>(null);
  const linkPress=useRef<{link?:string;annotation?:AnnotationContext;doc:Text;x:number;y:number;moved:boolean}|null>(null);
  const resetSource=useRef<((state:EditorState)=>void)|null>(null),sourceReadOnly=useRef(new Compartment());
  const alignmentRef=useRef<ReturnType<typeof alignSplitViews>|null>(null);
  const editorRef=useRef<EditorView|null>(null),rightSelection=useRef<{selection:EditorSelection;doc:EditorState['doc']}|null>(null);
  const visible=usePanelActivity(),[retained,setRetained]=useState(visible),awake=visible||keepAlive||retained;
  const initial=useRef(initialState);initial.current=initialState;
  const nativeComposition=useRef(false),gestures=useRef(new Set<number>());
  const sleep=useRef<ReturnType<typeof deferredEditorSleep>|null>(null);
  useEffect(()=>{
    const controller=deferredEditorSleep({set:(callback,delay)=>setTimeout(callback,delay),clear:id=>clearTimeout(id as ReturnType<typeof setTimeout>)},()=>setRetained(false),()=>nativeComposition.current||gestures.current.size>0||!!editorRef.current?.composing);
    sleep.current=controller;controller.visible(visible||keepAlive);
    return()=>{controller.dispose();sleep.current=null;};
  },[]);
  useLayoutEffect(()=>{if(visible||keepAlive)setRetained(true);sleep.current?.visible(visible||keepAlive);},[visible,keepAlive]);
  useLayoutEffect(()=>{
    const element=host.current;
    if(!split||!awake||!element)return;
    const observer=new panelDocument.defaultView!.ResizeObserver(entries=>setSplitWidth(entries[0].contentRect.width));
    observer.observe(element);
    return ()=>observer.disconnect();
  },[split,awake,panelDocument]);
  useLayoutEffect(()=>()=>stopSplitDrag.current?.(),[split,awake,panelDocument]);
  useEffect(()=>{
    const element=host.current;if(!element||!awake)return;
    const start=()=>{nativeComposition.current=true;},end=()=>{nativeComposition.current=false;sleep.current?.released();};
    const down=(event:PointerEvent)=>{gestures.current.add(event.pointerId);};
    const up=(event:PointerEvent)=>{gestures.current.delete(event.pointerId);sleep.current?.released();};
    const blur=()=>{gestures.current.clear();sleep.current?.released();};
    const window=panelDocument.defaultView!;
    element.addEventListener('compositionstart',start,true);element.addEventListener('compositionend',end,true);element.addEventListener('pointerdown',down,true);
    window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',up,true);window.addEventListener('blur',blur);
    return()=>{element.removeEventListener('compositionstart',start,true);element.removeEventListener('compositionend',end,true);element.removeEventListener('pointerdown',down,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',up,true);window.removeEventListener('blur',blur);};
  },[panelDocument,awake]);
  const [context,setContext]=useState<{x:number;y:number;position?:number|null;annotationId?:string;input?:HTMLTextAreaElement;link?:string}|null>(null);
  callback.current = onUpdate;
  useLayoutEffect(() => {
    if(!awake)return;
    let restored=initial.current||makeState("", (u) => callback.current(u),undefined,displayMode);
    if(!restored.field((foldingMarker),false))restored=restored.update({effects:StateEffect.appendConfig.of(headingFolding)}).state;
    if(!restored.field(codeModeMarker,false))restored=restored.update({effects:StateEffect.appendConfig.of(codeModeExtensions)}).state;
    restored=withDisplayMode(restored,displayMode);
    const view = new EditorView({
      state: restored,
      parent: mainHost.current!,
      dispatchTransactions(transactions, view){
        view.update(transactions);
        const source=sourceRef.current;
        if(source){
          for(const tr of transactions)source.update([mirrorTransaction(source.state,tr)]);
          if(source.state.readOnly!==view.state.readOnly)source.update([source.state.update({effects:sourceReadOnly.current.reconfigure([EditorState.readOnly.of(view.state.readOnly),EditorView.editable.of(!view.state.readOnly)])})]);
        }
        if(transactions.some(tr=>!tr.effects.some(effect=>(effect.is(setSplitPadding)||effect.is(setSplitTopPadding)||effect.is(setSplitBlockPadding)))))alignmentRef.current?.schedule();
      },
    });
    // File replacement uses setState, which does not dispatch transactions.
    const setState=view.setState.bind(view);
    view.setState=(state)=>{setState(withDisplayMode(state,currentMode.current));resetSource.current?.(view.state);const missing=[...(view.state.field(foldingMarker,false)?[]:[headingFolding]),...(view.state.field(codeModeMarker,false)?[]:[codeModeExtensions]),...(sourceRef.current&&!view.state.field(splitPadding,false)?[splitPadding]:[]),...(sourceRef.current&&!view.state.field(splitTopPadding,false)?[splitTopPadding]:[]),...(sourceRef.current&&!view.state.field(splitBlockPadding,false)?[splitBlockPadding]:[])];if(missing.length)view.dispatch({effects:StateEffect.appendConfig.of(missing)});};
    editorRef.current=view;
    onReady(view);
    // Existing sessions keep their EditorState through Vite updates and pane remounts.
    configureMarkdownDisplay(view,underlyingDisplayMode(displayMode));
    configureTypography(view);
    return () => {
      alignmentRef.current?.dispose();alignmentRef.current=null;
      if(view.state.field(splitPadding,false)?.size||view.state.field(splitTopPadding,false)?.size||view.state.field(splitBlockPadding,false)?.size)view.dispatch({effects:[setSplitPadding.of(new Map()),setSplitTopPadding.of(new Map()),setSplitBlockPadding.of(new Map())]});
      onReady(null);
      editorRef.current=null;
      view.destroy();
      rightSelection.current=null;setContext(null);
    };
  }, [onReady,awake]);
  useEffect(()=>{const view=editorRef.current;if(!view)return;view.setRoot(panelDocument);sourceRef.current?.setRoot(panelDocument);view.requestMeasure();sourceRef.current?.requestMeasure();view.dom.dispatchEvent(new Event('hive:panel-document-changed'));setContext(null);},[panelDocument,onReady,awake]);
  useLayoutEffect(()=>{
    const editor=editorRef.current;
    if(editor)configureMarkdownDisplay(editor,underlyingDisplayMode(displayMode));
    setContext(null);
  },[displayMode,awake]);
  useLayoutEffect(()=>{
    const main=editorRef.current, parent=sourceHost.current;
    if(!awake||displayMode!=='split'||!main||!parent)return;
    const makeSourceState=(mainState:EditorState)=>{
      let state=makeState(mainState.doc,()=>{},'Markdown 源码','source');
      state=state.update({selection:mainState.selection,effects:[...foldingEffects(mainState),StateEffect.appendConfig.of([sourceReadOnly.current.of([EditorState.readOnly.of(mainState.readOnly),EditorView.editable.of(!mainState.readOnly)])])]}).state;
      return state;
    };
    const state=makeSourceState(main.state);
    const source=new EditorView({state,parent,dispatchTransactions(transactions){
      for(const tr of transactions){
        if(main.state.readOnly&&tr.docChanged)continue;
        main.dispatch(sourceTransaction(tr));
        // View-local effects (including explicit scrollIntoView) belong to the
        // source view; its changes and selection were already mirrored above.
        const localEffects=tr.effects.filter(effect=>!isFoldingEffect(effect));
        if(localEffects.length||tr.scrollIntoView)source.update([source.state.update({effects:localEffects,scrollIntoView:tr.scrollIntoView})]);
      }
    }});
    sourceRef.current=source;
    resetSource.current=state=>{
      source.scrollDOM.scrollTop=0;
      source.scrollDOM.scrollLeft=0;
      source.setState(makeSourceState(state));
      source.requestMeasure();alignmentRef.current?.schedule();
    };
    if(!main.state.field(splitPadding,false)||!main.state.field(splitTopPadding,false)||!main.state.field(splitBlockPadding,false))main.dispatch({effects:StateEffect.appendConfig.of([...(main.state.field(splitPadding,false)?[]:[splitPadding]),...(main.state.field(splitTopPadding,false)?[]:[splitTopPadding]),...(main.state.field(splitBlockPadding,false)?[]:[splitBlockPadding])])});
    const detach=synchronizeScroll(source,main),alignment=alignSplitViews(source,main,detach.correct);alignmentRef.current=alignment;
    return()=>{alignmentRef.current=null;alignment.dispose();detach();if(main.state.field(splitPadding,false)?.size||main.state.field(splitTopPadding,false)?.size||main.state.field(splitBlockPadding,false)?.size)main.dispatch({effects:[setSplitPadding.of(new Map()),setSplitTopPadding.of(new Map()),setSplitBlockPadding.of(new Map())]});resetSource.current=null;sourceRef.current=null;source.destroy();};
  },[awake,displayMode,onReady,panelDocument]);
  useEffect(()=>{
    const view=editorRef.current;if(!view)return;
    const handler=(event:Event)=>{const detail=(event as CustomEvent<{ranges:{from:number;to:number}[];action:'mark'|'unmark'}>).detail;
      if(view.state.readOnly||!detail?.ranges?.length)return;
      const ranges=detail.ranges.filter(r=>r.from>=0&&r.to>r.from&&r.to<=view.state.doc.length).sort((a,b)=>a.from-b.from);
      if(!ranges.length)return;
      view.dispatch({selection:EditorSelection.create(ranges.map(r=>EditorSelection.range(r.from,r.to)))});
      if(detail.action==='mark')onMarkSelection?.();else if(detail.action==='unmark')onUnmarkSelection?.();
    };
    view.dom.addEventListener('hive:table-annotation',handler);return()=>view.dom.removeEventListener('hive:table-annotation',handler);
  },[onMarkSelection,onUnmarkSelection,awake]);
  useEffect(()=>{if(editorRef.current){configureTypewriter(editorRef.current,typewriter);configureFloatingSearch(editorRef.current,searchActive);configureImageContext(editorRef.current,documentFile?{file:documentFile,workspace:fileWorkspace.info.id}:null);}});
  useEffect(()=>{
    const view=editorRef.current;if(!view||!awake)return;
    if(!view.state.field(inlineProposalField,false))view.dispatch({effects:StateEffect.appendConfig.of(inlineProposalField)});
    view.dispatch({effects:setInlineProposal.of(inlineProposal)});
  },[awake,inlineProposal]);
  function positionDivider(divider:HTMLElement,x:number){
    const box=host.current?.getBoundingClientRect();
    if(!box)return;
    const width=box.width-divider.getBoundingClientRect().width;
    if(width<=0)return;
    const min=Math.min(140/width,.25),ratio=(x-box.left)/width;
    setSplitRatio(Math.max(min,Math.min(1-min,ratio)));
  }
  function startDividerDrag(event:ReactPointerEvent<HTMLDivElement>){
    if(event.button!==0||!event.isPrimary)return;
    event.preventDefault();event.stopPropagation();
    const divider=event.currentTarget,window=divider.ownerDocument.defaultView!;
    const id=event.pointerId,offset=event.clientX-divider.getBoundingClientRect().left;
    stopSplitDrag.current?.();
    divider.focus({preventScroll:true});
    const move=(pointer:PointerEvent)=>{
      if(pointer.pointerId===id)positionDivider(divider,pointer.clientX-offset);
    };
    const finish=(pointer:PointerEvent)=>{
      if(pointer.pointerId!==id)return;
      if(pointer.type==='pointerup')move(pointer);
      stop();
    };
    const stop=()=>{
      window.removeEventListener('pointermove',move,true);
      window.removeEventListener('pointerup',finish,true);
      window.removeEventListener('pointercancel',finish,true);
      window.removeEventListener('blur',stop);
      if(divider.hasPointerCapture(id))divider.releasePointerCapture(id);
      stopSplitDrag.current=null;
      setSplitDragging(false);
    };
    stopSplitDrag.current=stop;
    window.addEventListener('pointermove',move,true);
    window.addEventListener('pointerup',finish,true);
    window.addEventListener('pointercancel',finish,true);
    window.addEventListener('blur',stop);
    divider.setPointerCapture(id);
    setSplitDragging(true);
  }
  const minimumSplitRatio=Math.min(140/Math.max(1,splitWidth-8),.25);
  const valueNow=Math.max(minimumSplitRatio,Math.min(1-minimumSplitRatio,splitRatio));
  function openEditorLink(link:string){
    if(parseExternalHttpLink(link)){
      void openExternalHttpLink(link).then(opened=>{if(!opened)onError?.('无法在系统默认浏览器中打开此链接。');});
    }else onOpenLink?.(link);
  }
  const annotationToolActive=annotationTool&&displayMode!=='preview';
  return <><div className={'editor-host'+(split?' split-view':'')+(annotationToolActive?' annotation-tool-active':'')} ref={host} onFocusCapture={onFocus}
    data-annotation-tool-active={annotationToolActive?'':undefined}
    data-split-order={split?splitOrder:undefined}
    style={split?{'--split-left':splitRatio} as CSSProperties:undefined}
    onClick={event=>{
      const press=linkPress.current;linkPress.current=null;
      if(event.button!==0||event.altKey||press?.moved)return;
      const target=event.target as HTMLElement,editor=target.closest('.split-source')?sourceRef.current:editorRef.current;
      if(!editor||target.closest('textarea,button'))return;
      const point={x:event.clientX,y:event.clientY};
      if(press&&Math.hypot(point.x-press.x,point.y-press.y)>5)return;
      if(event.ctrlKey&&press?.annotation&&press.doc===editor.state.doc){
        event.preventDefault();event.stopPropagation();
        onShowAnnotations?.(press.annotation);
        return;
      }
      const link=press?press.link:editorLinkAt(editor,target,point,event.ctrlKey||event.metaKey);
      if(!link||(!onOpenLink&&!parseExternalHttpLink(link)))return;
      event.preventDefault();event.stopPropagation();openEditorLink(link);
    }}
    onPointerDownCapture={event=>{
      const target=event.target as HTMLElement,editor=target.closest('.split-source')?sourceRef.current:editorRef.current;
      if(event.button===2&&editor)rightSelection.current={selection:editor.state.selection,doc:editor.state.doc};
      linkPress.current=null;
      if(event.button!==0||event.altKey||!editor||target.closest('textarea,button,[role=separator]'))return;
      const x=event.clientX,y=event.clientY;
      const link=editorLinkAt(editor,target,{x,y},event.ctrlKey||event.metaKey);
      if(displayMode==='preview'&&editor.state.readOnly&&onMarkSelection&&!link&&
        (event.ctrlKey||annotationTool)&&!event.metaKey&&!event.shiftKey&&target.closest('.cm-content')){
        onError?.(previewAnnotationHint);
      }
      beginAnnotationSelection(event.nativeEvent,editor,annotationTool);
      const press:{link?:string;annotation?:AnnotationContext;doc:Text;x:number;y:number;moved:boolean}={link,doc:editor.state.doc,x,y,moved:false};
      linkPress.current=press;
      if(!onShowAnnotations||!event.ctrlKey||editor.composing||editor.state.readOnly||!target.closest('.cm-content')||target.closest('a,[data-table-widget]'))return;
      const position=editor.posAtCoords({x,y});
      const observed=target.closest<HTMLElement>('[data-annotation-id]')?.dataset.annotationId;
      const ranges=editor.state.selection.ranges.filter(range=>!range.empty).map(({from,to})=>({from,to}));
      if(!textAnnotationHit(event.nativeEvent,position,ranges,link,observed))return;
      press.annotation={ranges:ranges.some(range=>position!>=range.from&&position!<=range.to)?ranges:[{from:position!,to:position!}],ids:observed?[observed]:[]};
    }}
    onPointerMoveCapture={event=>{
      const press=linkPress.current;
      if(press&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>5)press.moved=true;
    }}
    onPointerCancelCapture={()=>{linkPress.current=null;}}
    onContextMenu={event=>{
      const editor=editorRef.current;if(!editor||!onMarkSelection)return;
      event.preventDefault();event.stopPropagation();const target=event.target as HTMLElement,input=target.tagName==='TEXTAREA'&&target.closest('[data-table-widget]')?target as HTMLTextAreaElement:undefined;const snapshot=rightSelection.current;rightSelection.current=null;
      if(!input&&snapshot&&snapshot.selection.ranges.some(range=>!range.empty)&&snapshot.doc===editor.state.doc)editor.dispatch({selection:snapshot.selection});
      const hitEditor=target.closest('.split-source')?sourceRef.current:editor;
      const targetLink=!input&&hitEditor?editorLinkAt(hitEditor,target,{x:event.clientX,y:event.clientY},true):undefined;
      const link=targetLink&&(onOpenLink||parseExternalHttpLink(targetLink))?targetLink:undefined;
      setContext({x:event.clientX,y:event.clientY,input,link,position:hitEditor?.posAtCoords({x:event.clientX,y:event.clientY}),annotationId:input?undefined:(event.target as Element).closest<HTMLElement>('[data-annotation-id]')?.dataset.annotationId});
    }}
    onKeyDownCapture={event=>{
      if(event.defaultPrevented||event.nativeEvent.isComposing)return;
      const target=event.target as HTMLElement,editor=editorRef.current;
      const matches=(id:ShortcutId)=>matchesShortcut(bindings,id,event.nativeEvent);
      if(!editor)return;
      if(target.closest('.cm-content,[data-table-widget]')&&(matches('undo')||matches('redo'))){
        event.preventDefault();event.stopPropagation();
        (matches('undo')?undo:redo)(editor);return;
      }
      if(!target.closest('.cm-content'))return;
      if(onFind&&(matches('find')||matches('replace')||matches('findPrevious')||matches('findNext'))){
        event.preventDefault();event.stopPropagation();onFind(matches('replace'));
        if(getSearchQuery(editor.state).valid){
          if(matches('findPrevious'))findPrevious(editor);
          else if(matches('findNext'))findNext(editor);
        }
        return;
      }
      const inline:Partial<Record<ShortcutId,InlineFormat>>={bold:'bold',italic:'italic',underline:'underline'};
      const align:Partial<Record<ShortcutId,Alignment>>={alignLeft:'left',alignCenter:'center',alignRight:'right'};
      const format=(Object.keys(inline) as ShortcutId[]).find(matches),alignment=(Object.keys(align) as ShortcutId[]).find(matches);
      if(!format&&!alignment)return;
      event.preventDefault();event.stopPropagation();
      try{editor.dispatch(format?inlineFormatting(editor.state,inline[format]!):paragraphAlignment(editor.state,align[alignment!]!));}
      catch(error){onError?.((error as Error).message);}
    }}
    onKeyDown={event=>{
      if(!onMarkSelection||!(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'))return;
      const editor=editorRef.current;if(!editor)return;event.preventDefault();event.stopPropagation();
      const point=editor.coordsAtPos(editor.state.selection.main.head),rect=editor.dom.getBoundingClientRect();
      const target=event.target as HTMLElement,input=target.tagName==='TEXTAREA'&&target.closest('[data-table-widget]')?target as HTMLTextAreaElement:undefined;const inputRect=input?.getBoundingClientRect();setContext({x:inputRect?.left??point?.left??rect.left+12,y:inputRect?.bottom??point?.bottom??rect.top+20,input,position:editor.state.selection.main.head});
    }}>
    <div className="split-source" ref={sourceHost}/>
    {split&&<div className="split-divider" role="separator" aria-label="调整左右分栏宽度" aria-orientation="vertical" aria-valuemin={Math.round(minimumSplitRatio*100)} aria-valuemax={Math.round((1-minimumSplitRatio)*100)} aria-valuenow={Math.round(valueNow*100)} tabIndex={0} data-dragging={splitDragging||undefined}
      onPointerDown={startDividerDrag}
      onKeyDown={event=>{
        const delta=event.key==='ArrowLeft'?-1:event.key==='ArrowRight'?1:0;
        if(!delta)return;
        event.preventDefault();
        const divider=event.currentTarget,hostWidth=host.current?.getBoundingClientRect().width||0;
        positionDivider(divider,divider.getBoundingClientRect().left+delta*hostWidth*.03);
      }}/>}
    <div className="split-main" ref={mainHost}/>
  </div>
    {awake&&context&&editorRef.current&&onMarkSelection&&<EditorContextMenu editor={editorRef.current} point={context} input={context.input} link={context.link} onOpenLink={openEditorLink} onClose={()=>setContext(null)} onDraftSelection={onDraftSelection} onMark={onMarkSelection} onUnmark={onUnmarkSelection} annotationId={context.annotationId} onShowAnnotations={onShowAnnotations} onError={onError}/>}</>;
}
