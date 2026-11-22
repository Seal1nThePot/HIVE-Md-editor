import {useId,useLayoutEffect,useRef,useState,type KeyboardEvent} from 'react';
import {ArrowLeft,Camera,Check,Icon,Redo2,RotateCcw,Undo2,type IconName} from "../../shared/icons";
import './history-page.css';

export type HistoryTab='snapshot'|'human'|'ai';
export type HistorySection={title:string;text?:string;before?:string;after?:string};
export type HistoryPageEntry={
  id:string;label:string;createdAt:string;file?:string;status?:'applied'|'reverted';
  sections?:HistorySection[];undoable?:boolean;redoable?:boolean;restorable?:boolean;
};
type Conflict={title:string;sections:HistorySection[];onConfirm:()=>void;onCancel:()=>void};
export type HistoryPageProps={
  activeFile:string;entries:Record<HistoryTab,HistoryPageEntry[]>;busy?:boolean;error?:string;
  onCreate:()=>void;onRestore:(id:string)=>void;
  onUndo:(tab:'human'|'ai',id:string)=>void;onRedo:(tab:'human'|'ai',id:string)=>void;
  conflict?:Conflict;
};

const tabs:HistoryTab[]=['snapshot','human','ai'];
const tabIcons:Record<HistoryTab,IconName>={snapshot:'history.tab.snapshot',human:'history.tab.human',ai:'history.tab.ai'};
const labels:Record<HistoryTab,string>={snapshot:'文件快照',human:'人工操作',ai:'AI 操作'};
const empty:Record<HistoryTab,string>={snapshot:'这篇文稿还没有快照。',human:'暂无人工操作记录。',ai:'暂无 AI 操作记录。'};
const dateFormat=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const rowDateFormat=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit'});
const rowTimeFormat=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
function displayTime(value:string){const stamp=Date.parse(value);return Number.isFinite(stamp)?dateFormat.format(stamp):value;}

function RowTime({value}:{value:string}){
  const stamp=Date.parse(value);
  return <time dateTime={value} title={displayTime(value)}>{Number.isFinite(stamp)?<>
    <span className="history-row-date">{rowDateFormat.format(stamp)} </span>{rowTimeFormat.format(stamp)}
  </>:value}</time>;
}

function Sections({sections,conflict=false}:{sections:HistorySection[];conflict?:boolean}){
  return <>{sections.map((section,index)=><section className="history-section" key={index}>
    <h4>{section.title}</h4>
    {section.text!==undefined&&<pre>{section.text||'（空）'}</pre>}
    {(section.before!==undefined||section.after!==undefined)&&<div className="history-changes">
      {section.before!==undefined&&<div><h5>{conflict?'当前内容':'改动前'}</h5><pre>{section.before||'（空）'}</pre></div>}
      {section.after!==undefined&&<div><h5>{conflict?'拟改内容':'改动后'}</h5><pre>{section.after||'（空）'}</pre></div>}
    </div>}
  </section>)}</>;
}

function ConflictDialog({conflict,busy}:{conflict:Conflict;busy:boolean}){
  const ref=useRef<HTMLDialogElement>(null),title=useId();
  useLayoutEffect(()=>{const dialog=ref.current!;dialog.showModal();return()=>dialog.close();},[]);
  return <dialog ref={ref} className="history-conflict" aria-labelledby={title} onCancel={event=>{event.preventDefault();if(!busy)conflict.onCancel();}}>
    <h3 id={title}>{conflict.title}</h3>
    <div className="history-conflict-content"><Sections sections={conflict.sections} conflict/></div>
    <div className="history-actions"><button type="button" disabled={busy} onClick={conflict.onCancel} autoFocus>取消</button>
      <button type="button" className="history-primary" disabled={busy} onClick={conflict.onConfirm}><Check size={15}/>确认应用</button></div>
  </dialog>;
}

function HistoryContent({activeFile,entries,busy=false,error,onCreate,onRestore,onUndo,onRedo,conflict}:HistoryPageProps){
  const [tab,setTab]=useState<HistoryTab>('snapshot'),[chosen,setChosen]=useState<Partial<Record<HistoryTab,string>>>({});
  const [drillDown,setDrillDown]=useState(false);
  const id=useId(),list=useRef<HTMLUListElement>(null),detail=useRef<HTMLElement>(null);
  const items=entries[tab],selected=items.find(item=>item.id===chosen[tab])??items[0];
  const selectTab=(next:HistoryTab)=>{setTab(next);setDrillDown(false);};
  const tabKey=(event:KeyboardEvent<HTMLButtonElement>,index:number)=>{
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:-1;
    if(next<0)return;event.preventDefault();selectTab(tabs[next]);
    event.currentTarget.parentElement?.querySelectorAll('button')[next]?.focus();
  };
  const inspect=(entry:HistoryPageEntry)=>{
    setChosen(previous=>({...previous,[tab]:entry.id}));setDrillDown(true);
    detail.current?.ownerDocument.defaultView?.requestAnimationFrame(()=>{
      const node=detail.current;
      if(node?.querySelector<HTMLElement>('.history-back')?.getClientRects().length)node.focus({preventScroll:true});
    });
  };
  function back(){
    setDrillDown(false);
    const node=list.current;node?.ownerDocument.defaultView?.requestAnimationFrame(()=>node.querySelector<HTMLButtonElement>('[aria-current=true]')?.focus());
  }
  return <section className="history-page" aria-label="历史记录">
    <header className="history-heading"><div><Icon name="history.open" size={19}/><h2>历史记录</h2></div>
      <p><Icon name="file.text" size={14}/><span>当前文稿</span><strong title={activeFile}>{activeFile||'尚未选择'}</strong></p></header>
    <div className="history-navigation"><div role="tablist" aria-label="历史类型">{tabs.map((value,index)=><button key={value} id={id+'-'+value} type="button" role="tab" aria-selected={tab===value} aria-controls={id+'-panel'} tabIndex={tab===value?0:-1} onKeyDown={event=>tabKey(event,index)} onClick={()=>selectTab(value)}><Icon name={tabIcons[value]} size={15}/>{labels[value]}</button>)}</div>
      {tab==='snapshot'&&<button type="button" className="history-create" disabled={busy||!activeFile} onClick={onCreate}><Camera size={15}/>创建快照</button>}</div>
    {error&&<p role="alert" className="history-error">{error}</p>}
    <div role="tabpanel" aria-labelledby={id+'-'+tab} id={id+'-panel'} className="history-panel" data-history-tab={tab} data-detail={drillDown&&!!selected} aria-busy={busy}>
      {!selected?<p className="history-empty">{busy?'正在读取历史记录…':empty[tab]}</p>:<>
        <ul ref={list} aria-label={labels[tab]+'记录'} className="history-list">{items.map(entry=>{
          const row=tab==='human',fileName=entry.file?.split(/[\\/]/).at(-1);
          return <li key={entry.id} className={row?'history-human-row':undefined}>
            <button type="button" className="history-list-entry" aria-current={entry.id===selected.id?'true':undefined} onClick={()=>inspect(entry)}>
              <strong title={row?entry.label:undefined}>{entry.label}</strong>
              {row?<RowTime value={entry.createdAt}/>:<time dateTime={entry.createdAt}>{displayTime(entry.createdAt)}</time>}
              {row?<small title={entry.file}>{fileName||'—'}</small>:entry.file&&entry.file!==activeFile&&<small title={entry.file}>{entry.file}</small>}
            </button>
            {row&&<div className="history-row-actions">
              <button type="button" title="撤销这条人工操作" disabled={busy||!entry.undoable} onClick={()=>onUndo('human',entry.id)}>恢复</button>
              <button type="button" disabled={busy||!entry.redoable} onClick={()=>onRedo('human',entry.id)}>重做</button>
            </div>}
          </li>;
        })}</ul>
        <article ref={detail} tabIndex={-1} className="history-detail" aria-label="记录详情" key={tab+selected.id}>
          <button type="button" className="history-back" onClick={back}><ArrowLeft size={14}/>返回列表</button>
          <h3>{selected.label}</h3><div className="history-meta"><time dateTime={selected.createdAt}>{displayTime(selected.createdAt)}</time>
            {selected.status&&<span>{selected.status==='reverted'?'已撤回':'已应用'}</span>}</div>
          {selected.file&&<p className="history-file">{selected.file}</p>}
          <div className="history-actions">{tab==='snapshot'
            ?<button type="button" disabled={busy||!selected.restorable} onClick={()=>onRestore(selected.id)}><RotateCcw size={14}/>还原到此快照</button>
            :<><button type="button" disabled={busy||!selected.undoable} onClick={()=>onUndo(tab,selected.id)}><Undo2 size={14}/>{tab==='ai'?'撤回这次改动':'撤销'}</button>
              <button type="button" disabled={busy||!selected.redoable} onClick={()=>onRedo(tab,selected.id)}><Redo2 size={14}/>{tab==='ai'?'重新应用':'重做'}</button></>}</div>
          <Sections sections={selected.sections??[]}/>
        </article>
      </>}
    </div>
    {conflict&&<ConflictDialog conflict={conflict} busy={busy}/>}
  </section>;
}

export default function HistoryPage(props:HistoryPageProps){return <HistoryContent key={props.activeFile} {...props}/>;}
