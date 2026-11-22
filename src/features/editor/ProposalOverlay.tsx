import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {EditorView} from '@codemirror/view';
import {Icon} from '../../shared/icons';
import {inlineProposalField,type InlineProposal} from './proposalInline';
import './proposalInline.css';

type Props={
  view:EditorView|null;
  proposal:InlineProposal|null;
  accept:()=>void;
  reject:(adjust?:boolean)=>void;
  editCandidate?:(text:string)=>void;
  editRefinementNote?:(note:string)=>void;
  refineCandidate?:(instruction:string)=>void;
  busy?:boolean;
};

type Position={top:number;left:number;width:number};

/** 建议上方那条很薄的操作条：浮在正文上，滚到框外时贴住视口顶部继续跟随，直到这段建议走完。 */
export function ProposalOverlay(props:Props){
  if(props.proposal?.placement==='comparison')return <ComparisonOverlay {...props}/>;
  return <LegacyProposalOverlay {...props}/>;
}

function ComparisonOverlay({view,proposal,accept,reject,editCandidate,editRefinementNote,refineCandidate,busy}:Props){
  const [mount,setMount]=useState<HTMLElement|null>(null);
  const [annotating,setAnnotating]=useState(false);
  const id=proposal?.id;
  useLayoutEffect(()=>{
    if(!view||!id){setMount(null);return;}
    const locate=()=>setMount([...view.contentDOM.querySelectorAll<HTMLElement>('.proposal-comparison-mount')]
      .find(element=>element.dataset.proposalId===id)??null);
    locate();
    const observer=new MutationObserver(locate);
    observer.observe(view.contentDOM,{childList:true,subtree:true});
    return()=>observer.disconnect();
  },[view,id]);
  useEffect(()=>{setAnnotating(Boolean(proposal?.refinementNote));},[id]);
  if(!mount||mount.dataset.proposalId!==id||!proposal)return null;
  const locked=proposal.stale||!!view?.state.readOnly;
  const note=proposal.refinementNote??'';
  const cancel=()=>reject();
  return createPortal(<section className="proposal-comparison" aria-label="润色结果" data-stale={proposal.stale||undefined}>
    <header><strong>润色结果</strong><span title={proposal.reason}>{proposal.reason}</span></header>
    {proposal.stale&&<p role="status">原文已改动，请核对后重新润色。</p>}
    <textarea aria-label="编辑润色结果" rows={Math.max(3,Math.min(12,proposal.text.split('\n').length+1))}
      value={proposal.text} readOnly={locked||!editCandidate} onChange={event=>editCandidate?.(event.target.value)}/>
    {annotating&&<form className="proposal-refine" onSubmit={event=>{
      event.preventDefault();
      if(note.trim()&&!locked&&!busy)refineCandidate?.(note);
    }}>
      <label>再次批注<textarea rows={2} value={note} readOnly={locked||busy||!editRefinementNote}
        onChange={event=>editRefinementNote?.(event.target.value)} /></label>
      <button type="submit" className="text-button" disabled={!note.trim()||locked||busy||!refineCandidate}>发送批注</button>
    </form>}
    <footer>
      <button type="button" className="text-button proposal-refine-button" title="右键取消此润色预览" aria-expanded={annotating}
        disabled={(locked||busy)&&!annotating} onClick={()=>setAnnotating(value=>!value)}
        onContextMenu={event=>{event.preventDefault();event.stopPropagation();cancel();}}>再次批注</button>
      <button type="button" className="text-button proposal-cancel" onClick={cancel}>取消</button>
      <button type="button" className="gold-button proposal-accept" disabled={locked||busy||proposal.text===proposal.original} onClick={accept}>采纳</button>
    </footer>
  </section>,mount);
}

function LegacyProposalOverlay({view,proposal,accept,reject}:Props){
  const barRef=useRef<HTMLDivElement|null>(null);
  const [position,setPosition]=useState<Position|null>(null);
  const lastKey=useRef('');

  const measure=useCallback(()=>{
    if(!view||!proposal){
      if(lastKey.current!==''){lastKey.current='';setPosition(null);}
      return;
    }
    const live=view.state.field(inlineProposalField,false);
    const range=live?.proposal??proposal;
    const docLength=view.state.doc.length;
    const start0=Math.max(0,Math.min(range.from,docLength));
    const end0=Math.max(start0,Math.min(range.to,docLength));
    const raw=view.state.doc.sliceString(start0,end0);
    const from=start0+(raw.length-raw.trimStart().length);
    const to=Math.max(from,end0-(raw.length-raw.trimEnd().length));
    const scroller=view.scrollDOM.getBoundingClientRect();
    const content=view.contentDOM.getBoundingClientRect();
    const start=view.coordsAtPos(from);
    if(!start){
      if(lastKey.current!==''){lastKey.current='';setPosition(null);}
      return;
    }
    const end=(to>from?view.coordsAtPos(to):null)||start;
    const barHeight=barRef.current?.offsetHeight||24;
    const inset=content.width>320?50:8;
    const left=start.left;
    const width=Math.max(200,content.right-inset-left);
    const boxTop=start.top;
    const boxBottom=Math.max(end.bottom,start.bottom);
    // 框还在视口里才显示：整段滚出上方或下方就收起来。
    const visible=boxBottom>scroller.top+6&&boxTop<scroller.bottom-6;
    const minTop=scroller.top+6;
    const maxTop=Math.max(minTop,boxBottom-barHeight-8);
    const top=Math.min(Math.max(boxTop-barHeight-6,minTop),maxTop);
    const key=[Math.round(top),Math.round(left),Math.round(width),visible,range.stale?1:0].join(',');
    if(key===lastKey.current)return;
    lastKey.current=key;
    setPosition(visible?{top,left,width}:null);
  },[view,proposal]);

  const measureRef=useRef(measure);
  measureRef.current=measure;

  // 每次渲染后重量一次：正文增删、缩放、切换文档都会走到这里。
  useLayoutEffect(()=>{measure();});

  useEffect(()=>{
    if(!view)return;
    const handler=()=>measureRef.current();
    const scroller=view.scrollDOM;
    scroller.addEventListener('scroll',handler,{passive:true});
    window.addEventListener('resize',handler);
    const observer=new ResizeObserver(handler);
    observer.observe(scroller);
    observer.observe(view.contentDOM);
    return ()=>{
      scroller.removeEventListener('scroll',handler);
      window.removeEventListener('resize',handler);
      observer.disconnect();
    };
  },[view]);

  if(!proposal||!position)return null;
  const stale=proposal.stale;
  const tag=proposal.count?`${proposal.mode} · ${proposal.count} 字`:proposal.mode;
  const reason=stale?'这段文字已被改动，请先核对再决定':proposal.reason;
  return (
    <div ref={barRef} className={'proposal-bar'+(stale?' stale':'')} style={{top:position.top,left:position.left,width:position.width}}
      role="group" aria-label="AI 建议" onMouseDown={event=>event.preventDefault()}>
      <span className="proposal-bar-tag">{tag}</span>
      <span className="proposal-bar-reason" title={reason}>{reason}</span>
      <span className="proposal-bar-actions">
        <button type="button" className="proposal-bar-button adjust" title="撤掉并回到对话里继续调整" aria-label="撤掉并回到对话里继续调整" onClick={()=>reject(true)}><Icon name="proposal.adjust" size={14}/></button>
        <button type="button" className="proposal-bar-button reject" title="撤掉这段建议，恢复原样" aria-label="撤掉这段建议，恢复原样" onClick={()=>reject()}><Icon name="proposal.reject" size={14}/></button>
        <button type="button" className="proposal-bar-button accept" title={stale?'这段文字已被改动，请先核对':'保留这段建议（之后按 Ctrl+S 才写入磁盘）'} aria-label={stale?'这段文字已被改动，请先核对':'保留这段建议（之后按 Ctrl+S 才写入磁盘）'} onClick={accept}><Icon name="proposal.accept" size={14}/></button>
      </span>
    </div>
  );
}
