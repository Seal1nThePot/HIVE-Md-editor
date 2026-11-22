import {Transaction, type EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import type {DisplayMode} from './markdownDisplay';
import {isFoldingEffect} from './headingFolding';
import {paragraphLines} from './splitAlignment';
import {previewPlan} from './markdownPresentation';

export type EditorDisplayMode=DisplayMode|'split';
export type SplitOrder='source-first'|'semantic-first';
export function underlyingDisplayMode(mode:EditorDisplayMode):DisplayMode{return mode==='split'?'live':mode;}

const scrollIntents=new WeakMap<EditorView,()=>void>();
export const splitScrollIntent=EditorView.scrollHandler.of((view,_range,options)=>{
  // A mirrored transaction may request the default nearest-caret scroll in
  // both views. Only explicit navigation chooses a different driver here.
  if(options.y!=='nearest')scrollIntents.get(view)?.();
  return false;
});

/** Keep the scrolling pane as the reference while the follower remeasures its viewport. */
export function synchronizeScroll(source:EditorView,live:EditorView){
  const expected=new WeakMap<EditorView,number>();
  let driver:EditorView=live,preferredUntil=0;
  const window=live.dom.ownerDocument.defaultView!;
  let correctionFrame=0;
  const destination=(view:EditorView)=>view===source?live:source;
  const viewportTop=(view:EditorView)=>view.scrollDOM.getBoundingClientRect().top+view.scrollDOM.clientTop*view.scaleY;
  function scrollTo(view:EditorView,top:number){
    const scroller=view.scrollDOM;
    top=Math.min(Math.max(0,top),scroller.scrollHeight-scroller.clientHeight);
    if(Math.abs(scroller.scrollTop-top)<.5)return;
    scroller.scrollTop=top;
    expected.set(view,scroller.scrollTop);
  }
  function alignBlock(from:EditorView,to:EditorView){
    const origin=viewportTop(from)-from.documentTop;
    const block=from.lineBlockAtHeight(origin);
    const first=paragraphLines(live.state,block.from).first.from;
    const target=to.lineBlockAt(first);
    // Rendered widgets may cover several source lines. Use the earliest
    // position shared by both blocks when transferring the vertical offset.
    const anchor=Math.min(first,target.from);
    const documentY=target.top+origin-from.lineBlockAt(anchor).top;
    scrollTo(to,to.scrollDOM.scrollTop+(to.documentTop+documentY-viewportTop(to))/to.scaleY);
  }
  function sync(from:EditorView){
    const to=destination(from);
    if(!from.scrollDOM.clientHeight||!to.scrollDOM.clientHeight||!from.state.doc.eq(to.state.doc))return;
    if(from.scrollDOM.scrollTop<.5)scrollTo(to,0);else alignBlock(from,to);
  }
  function scheduleCorrection(){
    if(!correctionFrame)correctionFrame=window.requestAnimationFrame(()=>{
      correctionFrame=0;correct();
    });
  }
  const bind=(view:EditorView)=>{
    let previousTop=view.scrollDOM.scrollTop;
    const prefer=()=>{driver=view;preferredUntil=window.performance.now()+300;};
    const scroll=()=>{
      const top=view.scrollDOM.scrollTop;
      if(Math.abs(top-previousTop)<.5)return;
      previousTop=top;
      const pending=expected.get(view);
      expected.delete(view);
      if(pending!==undefined&&Math.abs(pending-top)<1)return;
      // A follower may adjust its own scroll anchor during measurement.
      // Keep it following while the other pane is receiving input.
      if(view!==driver&&window.performance.now()<preferredUntil){scheduleCorrection();return;}
      driver=view;
      sync(view);
      scheduleCorrection();
    };
    const scroller=view.scrollDOM;
    scrollIntents.set(view,prefer);
    scroller.addEventListener('scroll',scroll,{passive:true});
    scroller.addEventListener('wheel',prefer,{passive:true});
    scroller.addEventListener('pointerdown',prefer,true);
    scroller.addEventListener('keydown',prefer,true);
    return ()=>{
      scrollIntents.delete(view);
      scroller.removeEventListener('scroll',scroll);
      scroller.removeEventListener('wheel',prefer);
      scroller.removeEventListener('pointerdown',prefer,true);
      scroller.removeEventListener('keydown',prefer,true);
    };
  };
  const removeSource=bind(source),removeLive=bind(live);
  if(live.scrollDOM.scrollTop>0&&source.scrollDOM.clientHeight){
    // A woken split tab already restored the live pane. Align its source before first paint.
    source.lineBlockAtHeight(0);
    sync(driver);
    source.requestMeasure();
    source.lineBlockAtHeight(source.scrollDOM.scrollTop);
  }
  const frame=window.requestAnimationFrame(()=>sync(driver));
  const dispose=()=>{window.cancelAnimationFrame(frame);window.cancelAnimationFrame(correctionFrame);removeSource();removeLive();};
  function correct(){
    const follower=destination(driver),top=viewportTop(driver),bottom=top+driver.scrollDOM.clientHeight*driver.scaleY;
    if(!source.state.doc.eq(live.state.doc)||!driver.scrollDOM.clientHeight||!follower.scrollDOM.clientHeight)return;
    if(driver.scrollDOM.scrollTop<.5){scrollTo(follower,0);return;}
    let bestDistance=Infinity,delta=0;
    const consider=(sourceRect:{top:number;bottom:number}|null,liveRect:{top:number;bottom:number}|null)=>{
      if(!sourceRect||!liveRect)return;
      const from=driver===source?sourceRect:liveRect,to=driver===source?liveRect:sourceRect;
      if(from.top>bottom+40)return;
      const distance=Math.abs(from.top-top);
      if(distance<bestDistance){bestDistance=distance;delta=to.top-from.top;}
    };

    const tableRoots=live.contentDOM.querySelectorAll<HTMLElement>('[data-table-widget]');
    if(tableRoots.length){
      const tables=previewPlan(live.state).replacements.filter(item=>item.kind==='table');
      for(const root of tableRoots){
        const table=tables.find(item=>item.tableOrdinal===Number(root.dataset.tableOrdinal));
        if(!table)continue;
        for(const row of root.querySelectorAll<HTMLElement>('tr[data-row]')){
          const cell=table.rows?.[Number(row.dataset.row)]?.[0];
          if(!cell)continue;
          const visual=row.querySelector<HTMLElement>('.cm-table-cell-preview:not([hidden]),textarea:not([hidden])');
          if(visual)consider(source.coordsAtPos(source.state.doc.lineAt(cell.from).from),visual.getBoundingClientRect());
        }
      }
    }

    // Compare paragraph starts. The same character inside a paragraph can
    // wrap to different rows in the two panes.
    const visited=new Set<number>(),doc=driver.state.doc,documentTop=driver.documentTop;
    for(const block of driver.viewportLineBlocks){
      if(documentTop+block.bottom<top-40||documentTop+block.top>bottom+40)continue;
      const {first:line}=paragraphLines(live.state,block.from);
      if(visited.has(line.from))continue;
      visited.add(line.from);
      const limit=Math.min(line.to,line.from+160);
      for(let pos=line.from;pos<limit;pos++){
        const a=source.coordsForChar(pos),b=live.coordsForChar(pos);
        if(a&&b){consider(a,b);break;}
      }
    }
    if(bestDistance===Infinity){sync(driver);return;}
    scrollTo(follower,follower.scrollDOM.scrollTop+delta/follower.scaleY);
  }
  return Object.assign(dispose,{correct});
}

/** Transfer source edits into the authoritative history; only source-facing selection is copied back. */
export function sourceTransaction(tr:Transaction){
  // CodeMirror writes the native DOM selection for select.pointer even when
  // its view is unfocused. Forward the selection but keep that event local.
  const userEvent=tr.isUserEvent('select.pointer')?'select':tr.annotation(Transaction.userEvent);
  const addToHistory=tr.annotation(Transaction.addToHistory);
  return {changes:tr.changes,selection:tr.newSelection,effects:tr.effects.filter(isFoldingEffect),scrollIntoView:false,annotations:[...(userEvent?[Transaction.userEvent.of(userEvent)]:[]),...(addToHistory===false?[Transaction.addToHistory.of(false)]:[])]};
}
export function mirrorTransaction(state:EditorState,tr:Transaction){
  return state.update({changes:tr.changes,selection:tr.newSelection,effects:tr.effects.filter(isFoldingEffect),annotations:Transaction.addToHistory.of(false)});
}
