import {useCallback,useEffect,useRef,useState} from 'react';
import {requestJson} from '../../shared/api';

export type EditorStatusContribution = {
  slot:'editor.status'; metric:'document-lines'|'selected-lines'|'line-length'; label:string;
};
type Plugin = {id:string;name:string;description:string;file:string;enabled:boolean;contribution:EditorStatusContribution};
type PluginCatalog = {directory:string;plugins:Plugin[];errors:{file:string;message:string}[];limitReached:boolean;canOpenDirectory:boolean;canInstallSample:boolean};

export function usePlugins() {
  const [catalog,setCatalog] = useState<PluginCatalog|null>(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const pending = useRef<AbortController|null>(null);
  const run = useCallback(async (route:string, body?:unknown) => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await requestJson<PluginCatalog|{ok:true}>(fetch,route,body,controller.signal);
      if (!controller.signal.aborted && 'plugins' in result) setCatalog(result);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '无法读取插件。');
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  },[]);

  const reload = useCallback(()=>run('/plugins'),[run]);
  useEffect(()=>{
    void reload();
    return ()=>{pending.current?.abort();pending.current=null;};
  },[reload]);

  return {catalog,error,busy,reload, enable:(id:string,enabled:boolean)=>run('/plugins/enabled',{id,enabled}),
    installSample:()=>run('/plugins/sample',{}),openDirectory:()=>run('/plugins/open',{})};
}
