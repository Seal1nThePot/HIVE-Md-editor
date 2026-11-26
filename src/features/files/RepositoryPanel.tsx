import {useEffect, useRef, useState, type FormEvent} from 'react';
import {AlertCircle, ArrowDown, ArrowRight, ArrowUp, Check, FolderOpen, Icon, Pencil, Search} from "../../shared/icons";
import {repositoryLabel, useFileWorkspace} from './WorkspaceContext';
import './repositories.css';

export default function RepositoryPanel({onSwitch,onRemove,onReturn}:{onSwitch:(root:string)=>Promise<void>;onRemove:(id:string)=>Promise<void>;onReturn:()=>void}) {
  const space=useFileWorkspace();
  const [root,setRoot]=useState(''),[query,setQuery]=useState(''),[busy,setBusy]=useState(false);
  const [feedback,setFeedback]=useState<{message:string;error?:boolean}|null>(null);
  const [enterPath,setEnterPath]=useState(false);
  const [editing,setEditing]=useState<{id:string;name:string}|null>(null);
  const pending=useRef(false),pathDialog=useRef<HTMLDialogElement>(null);
  const repositories=space.info.repositories;
  const chooseDirectory=window.hiveDesktop?.chooseRepositoryDirectory;
  const shown=repositories.filter(item=>(repositoryLabel(item)+' '+item.root).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(()=>{
    if(!feedback)return;
    const timer=setTimeout(()=>setFeedback(null),feedback.error?5000:3200);
    return ()=>clearTimeout(timer);
  },[feedback]);
  useEffect(()=>{
    const dialog=pathDialog.current;
    if(!enterPath||!dialog)return;
    dialog.showModal();
    return ()=>dialog.close();
  },[enterPath]);
  async function run(action:()=>Promise<void>,message='') {
    if(pending.current)return false;
    pending.current=true;setBusy(true);setFeedback(null);
    try {await action();if(message)setFeedback({message});return true;}
    catch(error) {setFeedback({message:(error as Error).message,error:true});return false;}
    finally {pending.current=false;setBusy(false);}
  }
  async function add(pathInput?:string) {
    let success='';
    const added=await run(async()=>{
      const selected=pathInput??await chooseDirectory?.();
      if(!selected)return;
      const normalized=selected.trim().replace(/[\\/]+$/,'').toLocaleLowerCase();
      const exists=repositories.some(item=>item.root.replace(/[\\/]+$/,'').toLocaleLowerCase()===normalized);
      await space.manage({action:'add',root:selected});
      success=exists?'这个仓库已在列表中。':'仓库已添加。';
    });
    if(added&&success){setFeedback({message:success});setEnterPath(false);}
  }
  function beginAdd() {
    if(chooseDirectory){void add();return;}
    setRoot('');setFeedback(null);setEnterPath(true);
  }
  function move(id:string,offset:number) {
    const order=repositories.map(item=>item.id),index=order.indexOf(id),target=index+offset;
    if(index<0||target<0||target>=order.length)return;
    [order[index],order[target]]=[order[target],order[index]];
    void run(()=>space.manage({action:'reorder',order}));
  }
  async function rename(event:FormEvent) {
    event.preventDefault();if(!editing)return;
    if(await run(()=>space.manage({action:'rename',id:editing.id,name:editing.name}),'备注名称已保存。'))setEditing(null);
  }
  const result=feedback&&<p className={'repository-feedback'+(feedback.error?' repository-error':'')} role={feedback.error?'alert':'status'}>
    {feedback.error?<AlertCircle size={15}/>:<Check size={15}/>} {feedback.message}
  </p>;
  return <div className="repository-surface">
    <div className="repository-page" aria-busy={busy}>
    <div className="repository-masthead">
      <header className="repository-heading">
        <span className="repository-heading-icon"><Icon name="panel.repositories" size={22}/></span>
        <div className="repository-title"><h1>仓库管理</h1><span className="repository-count" aria-label={`共 ${repositories.length} 个仓库`}>{repositories.length}</span></div>
      </header>
      <button type="button" className="repository-primary repository-add-button" disabled={busy} onClick={beginAdd}><Icon name="repository.add" size={15}/>添加仓库</button>
    </div>
    <div className="repository-toolbar"><label className="repository-search"><Search size={15}/><input aria-label="搜索仓库" placeholder="搜索名称或路径…" value={query} onChange={event=>setQuery(event.target.value)}/></label></div>
    <div className="repository-grid" aria-label="仓库列表">{shown.map(item=>{
      const current=item.id===space.info.id,isDefault=item.id===space.info.defaultRepositoryId;
      const index=repositories.findIndex(value=>value.id===item.id),name=repositoryLabel(item);
      return <article className={'repository-card'+(current?' repository-current':'')} key={item.id} data-repository-id={item.id} aria-label={`仓库：${name}`}>
        <div className="repository-card-heading"><span className="repository-card-icon"><FolderOpen size={20}/></span><h3 title={name}>{name}</h3><button type="button" className="repository-rename" aria-label={`备注仓库名称：${name}`} title="备注名称" disabled={busy} onClick={()=>{setEditing({id:item.id,name:item.name||''});setFeedback(null);}}><Pencil size={15}/></button>{current&&<span className="repository-current-badge"><Check size={12}/>当前</span>}</div>
        {editing?.id===item.id&&<form className="repository-name-editor" onSubmit={event=>void rename(event)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!busy)setEditing(null);}}}>
          <label htmlFor={`repository-name-${item.id}`}>备注名称</label><input id={`repository-name-${item.id}`} aria-label="仓库备注名称" value={editing.name} maxLength={80} placeholder="留空使用文件夹名" autoFocus disabled={busy} onChange={event=>setEditing({...editing,name:event.target.value})}/>
          <p>仅修改应用中的名称，文件夹名保持不变。</p><div><button type="submit" className="repository-primary" disabled={busy}><Check size={14}/>保存</button><button type="button" className="repository-secondary" disabled={busy} onClick={()=>setEditing(null)}>取消</button></div>
        </form>}
        <p className="repository-path" title={item.root}>{isDefault&&<span className="repository-default-badge">默认根目录</span>}<span className="repository-path-value">{item.root}</span></p>
        <div className="repository-card-actions"><button type="button" className={current?'repository-secondary':'repository-primary'} disabled={busy} onClick={()=>{if(current)onReturn();else void run(()=>onSwitch(item.root));}}>{current?'返回写作':'打开仓库'}<ArrowRight size={14}/></button><div className="repository-order">
          <button type="button" aria-label={`上移仓库：${name}`} title="上移" disabled={busy||index===0||!!query.trim()} onClick={()=>move(item.id,-1)}><ArrowUp size={16}/></button>
          <button type="button" aria-label={`下移仓库：${name}`} title="下移" disabled={busy||index===repositories.length-1||!!query.trim()} onClick={()=>move(item.id,1)}><ArrowDown size={16}/></button>
          <button type="button" aria-label={`从列表移除仓库：${name}`} title={isDefault?'默认根目录不能移出仓库列表':current?'从列表移除并返回默认根目录，文件保留':'从列表移除，文件保留'} disabled={busy||isDefault} onClick={()=>void run(()=>onRemove(item.id),'已从列表移除，文件仍保留在原文件夹。')}><Icon name="repository.remove" size={16}/></button>
        </div></div>
      </article>;
    })}</div>
    {!shown.length&&<div className="repository-empty"><Icon name="repository.noResults" size={25}/><p>没有找到匹配的仓库</p><button type="button" onClick={()=>setQuery('')}>清除搜索</button></div>}
    </div>
    {!enterPath&&result}
    {enterPath&&<dialog ref={pathDialog} className="repository-path-dialog" aria-label="添加仓库" onCancel={event=>{event.preventDefault();if(!busy){setEnterPath(false);setFeedback(null);}}}>
      <form onSubmit={event=>{event.preventDefault();void add(root.trim());}}>
        <h2>添加仓库</h2>
        <label htmlFor="repository-root">仓库文件夹路径</label>
        <input id="repository-root" autoFocus required value={root} placeholder="输入文件夹的完整路径" disabled={busy} onChange={event=>setRoot(event.target.value)}/>
        {result}
        <div className="repository-dialog-actions"><button type="button" disabled={busy} onClick={()=>{setEnterPath(false);setFeedback(null);}}>取消</button><button className="repository-primary" type="submit" disabled={busy||!root.trim()}>添加仓库</button></div>
      </form>
    </dialog>}
  </div>;
}
