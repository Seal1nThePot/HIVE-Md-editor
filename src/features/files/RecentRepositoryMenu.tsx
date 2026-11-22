import {useEffect,useId,useLayoutEffect,useRef,useState,type KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import {Check,ChevronDown,Icon} from '../../shared/icons';
import {repositoryLabel,type WorkspaceInfo} from './WorkspaceContext';
import {recentRepositoryItems,rememberRecentRepository} from './recentRepositories';
import './recent-repositories.css';

export default function RecentRepositoryMenu({info,onSwitch,onManage,onError}: {
  info:WorkspaceInfo;
  onSwitch:(root:string)=>Promise<void>;
  onManage:()=>void;
  onError:(message:string)=>void;
}) {
  const [open,setOpen]=useState(false),[pending,setPending]=useState(false);
  const anchor=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
  const [position,setPosition]=useState({left:0,top:0});
  const firstFocus=useRef<'first'|'last'>('first'),menuId=useId();
  const items=recentRepositoryItems(info);
  const current=info.repositories.find(item=>item.id===info.id);
  const currentLabel=repositoryLabel(current??info);
  // WorkspaceInfo is published only after the initial open or a successful switch.
  useEffect(()=>rememberRecentRepository(info),[info]);

  useLayoutEffect(()=>{
    if(!open||!anchor.current||!menu.current)return;
    const node=anchor.current,layer=menu.current,doc=node.ownerDocument,win=doc.defaultView;
    if(!win)return;
    const place=()=>{
      const rect=node.getBoundingClientRect(),width=layer.getBoundingClientRect().width;
      setPosition({left:Math.max(6,Math.min(rect.left,win.innerWidth-width-6)),top:rect.bottom+4});
    };
    place();
    const buttons=layer.querySelectorAll<HTMLButtonElement>('button');
    buttons[firstFocus.current==='last'?buttons.length-1:0]?.focus();
    const dismiss=(event:PointerEvent)=>{
      if(!node.contains(event.target as Node)&&!layer.contains(event.target as Node))setOpen(false);
    };
    const blur=()=>setOpen(false);
    doc.addEventListener('pointerdown',dismiss,true);
    win.addEventListener('resize',place);
    win.addEventListener('blur',blur);
    return ()=>{
      doc.removeEventListener('pointerdown',dismiss,true);
      win.removeEventListener('resize',place);
      win.removeEventListener('blur',blur);
    };
  },[open]);

  function close(focus=false){
    setOpen(false);
    if(focus)anchor.current?.focus();
  }
  function navigate(event:KeyboardEvent<HTMLDivElement>){
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);return;}
    if(event.key==='Tab'){close();return;}
    const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
    const index=buttons.indexOf(event.target as HTMLButtonElement);
    let next:number;
    switch(event.key){
      case 'Home':next=0;break;
      case 'End':next=buttons.length-1;break;
      case 'ArrowDown':next=(index+1)%buttons.length;break;
      case 'ArrowUp':next=(index+buttons.length-1)%buttons.length;break;
      default:return;
    }
    event.preventDefault();
    buttons[next]?.focus();
  }
  async function select(id:string){
    close(true);
    if(id===info.id||pending)return;
    const item=info.repositories.find(repository=>repository.id===id);
    if(!item)return;
    setPending(true);
    try{await onSwitch(item.root);}
    catch(error){onError((error as Error).message);}
    finally{setPending(false);}
  }
  return <>
    <button ref={anchor} type="button" className="workspace-switcher" aria-label="切换仓库" title={`切换仓库 · ${info.root}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open?menuId:undefined} disabled={pending}
      onClick={()=>{firstFocus.current='first';setOpen(value=>!value);}} onKeyDown={event=>{
        if(event.key!=='ArrowDown'&&event.key!=='ArrowUp')return;
        event.preventDefault();firstFocus.current=event.key==='ArrowUp'?'last':'first';setOpen(true);
      }}>
      <Icon name="panel.repositories" className="workspace-switcher-icon"/>
      <b>{currentLabel}</b>
      <ChevronDown className="workspace-switcher-chevron" aria-hidden="true"/>
    </button>
    {open&&anchor.current&&createPortal(<div ref={menu} className="recent-repositories-menu" id={menuId}
      style={position} role="menu" aria-label="最近使用的仓库" onKeyDown={navigate}>
      {items.map(item=><button key={item.id} type="button" role="menuitem" data-recent-repository={item.id}
        aria-current={item.id===info.id?'true':undefined} title={item.root} onClick={()=>void select(item.id)}>
        <span>{repositoryLabel(item)}</span>{item.id===info.id&&<Check size={14}/>}
      </button>)}
      <button type="button" role="menuitem" className="recent-repositories-manage" onClick={()=>{close(true);onManage();}}>
        <Icon name="panel.repositories" size={15}/><span>仓库管理</span>
      </button>
    </div>,anchor.current.ownerDocument.body)}
  </>;
}
