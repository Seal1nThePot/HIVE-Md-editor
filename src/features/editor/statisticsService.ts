import type {Text} from '@codemirror/state';
import {cacheDocumentStatistics,cachedDocumentStatistics,type DocumentStatistics,type TextStatistics} from './statusModel';

type Result<Statistics>={value?:Statistics;error?:string};
type Listener<Statistics=TextStatistics>=(result:Result<Statistics>)=>void;
type WorkerStatistics=TextStatistics|DocumentStatistics;
type Job={id:number;key:object;parts:readonly Text[];doc?:Text;listeners:Set<Listener<WorkerStatistics>>};
let worker:Worker|null=null,active:Job|null=null,timer:ReturnType<typeof setTimeout>|undefined,sequence=0;
let idleTimer:ReturnType<typeof setTimeout>|undefined;
export const statisticsIdleDelay=1500;
const statisticsUnavailable='字数统计暂时不可用';
const pending=new Map<object,Job>();
function stopWorker(){const previous=worker;worker=null;previous?.terminate();}

function finish(result:Result<WorkerStatistics>){
  const job=active;active=null;
  if(job?.listeners.size){
    if(job.doc&&result.value&&'narrationCount' in result.value)cacheDocumentStatistics(job.doc,result.value);
    for(const listener of job.listeners)listener(result);
  }
  schedule();
}
function start(){
  timer=undefined;if(active||!pending.size)return;
  // The latest changed visible document goes first; obsolete queued states are removed by unsubscribe.
  const job=[...pending.values()].at(-1)!;pending.delete(job.key);active=job;
  try{
    if(!worker){
      const created=new Worker(new URL('./statistics.worker.ts',import.meta.url),{type:'module'});worker=created;
      created.onmessage=(event:MessageEvent<Result<WorkerStatistics>&{id:number}>)=>{if(worker===created&&event.data.id===active?.id)finish(event.data);};
      created.onerror=()=>{if(worker!==created)return;stopWorker();finish({error:statisticsUnavailable});};
    }
    worker.postMessage({id:job.id,texts:job.parts.map(doc=>doc.toString()),document:!!job.doc});
  }catch{finish({error:statisticsUnavailable});}
}
function schedule(){
  clearTimeout(idleTimer);idleTimer=undefined;
  if(!pending.size&&!active){if(timer){clearTimeout(timer);timer=undefined;}if(worker)idleTimer=setTimeout(()=>{idleTimer=undefined;stopWorker();},statisticsIdleDelay);}
  else if(!active&&!timer&&pending.size)timer=setTimeout(start,120);
}

/** One worker and at most one pending state per live subscriber, with no queued full strings. */
export function requestDocumentStatistics(doc:Text,listener:Listener<DocumentStatistics>){
  const cached=cachedDocumentStatistics(doc);if(cached){listener({value:cached});return ()=>{};}
  return request(doc,[doc],({error})=>{
    const value=cachedDocumentStatistics(doc);
    listener(value?{value}:{error:error??statisticsUnavailable});
  },doc);
}
export function requestSelectionStatistics(parts:readonly Text[],listener:Listener){return request(parts,parts,listener);}
function request(key:object,parts:readonly Text[],listener:Listener<WorkerStatistics>,doc?:Text){
  let job=active?.key===key?active:pending.get(key);
  if(!job){job={id:++sequence,key,doc,parts,listeners:new Set()};pending.set(key,job);}
  job.listeners.add(listener);schedule();
  return ()=>{
    job!.listeners.delete(listener);
    if(!job!.listeners.size){
      if(pending.get(key)===job)pending.delete(key);
      if(active===job){active=null;stopWorker();}
      schedule();
    }
  };
}
