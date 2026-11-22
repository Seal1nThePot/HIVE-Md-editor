import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {EditorState} from '@codemirror/state';

type WorkerMessage={id:number;texts:string[];document:boolean};
const selectionCounts={characters:123,pureCount:100,paragraphs:2};
const documentCounts={...selectionCounts,narrationCount:75,dialogueCount:25,averageParagraphLength:50};

class TestWorker{
  static instances:TestWorker[]=[];
  onmessage:((event:{data:unknown})=>void)|null=null;
  onerror:(()=>void)|null=null;
  messages:WorkerMessage[]=[];
  terminate=vi.fn();
  constructor(){TestWorker.instances.push(this);}
  postMessage(message:WorkerMessage){this.messages.push(message);}
  complete(){
    const {id,document}=this.messages.at(-1)!;
    this.onmessage?.({data:{id,value:document?documentCounts:selectionCounts}});
  }
}

describe('background statistics scheduling',()=>{
  beforeEach(()=>{vi.resetModules();vi.useFakeTimers();TestWorker.instances=[];vi.stubGlobal('Worker',TestWorker);});
  afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
  it('uses one worker, drops superseded pending documents before expanding text, and rejects stale results',async()=>{
    const {requestDocumentStatistics}=await import('./statisticsService');
    const {cachedDocumentStatistics}=await import('./statusModel');
    const docs=['old','superseded','latest'].map(text=>EditorState.create({doc:text.repeat(40000)}).doc),reads=docs.map(doc=>vi.spyOn(doc,'toString'));
    const first=vi.fn(),second=vi.fn(),last=vi.fn();
    const cancelFirst=requestDocumentStatistics(docs[0],first);vi.advanceTimersByTime(120);
    cancelFirst();const cancelSecond=requestDocumentStatistics(docs[1],second);cancelSecond();requestDocumentStatistics(docs[2],last);
    expect(TestWorker.instances).toHaveLength(1);expect(TestWorker.instances[0].messages).toHaveLength(1);
    TestWorker.instances[0].complete();expect(first).not.toHaveBeenCalled();expect(second).not.toHaveBeenCalled();
    expect(cachedDocumentStatistics(docs[0])).toBeUndefined();
    vi.advanceTimersByTime(120);expect(TestWorker.instances).toHaveLength(2);expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();expect(reads.map(read=>read.mock.calls.length)).toEqual([1,0,1]);
    TestWorker.instances[1].complete();expect(last).toHaveBeenCalledOnce();
    expect(last).toHaveBeenCalledWith({value:documentCounts});
    expect(cachedDocumentStatistics(docs[2])).toEqual(documentCounts);
  });
  it('shares full-document counts for total and full selection and caches the exact document only',async()=>{
    const {requestDocumentStatistics}=await import('./statisticsService');
    const doc=EditorState.create({doc:'same saved note'}).doc,total=vi.fn(),selection=vi.fn(),cached=vi.fn();
    requestDocumentStatistics(doc,total);requestDocumentStatistics(doc,selection);vi.advanceTimersByTime(120);
    const worker=TestWorker.instances[0];expect(worker.messages).toHaveLength(1);
    expect(worker.messages[0].document).toBe(true);worker.complete();
    expect(total).toHaveBeenCalledOnce();expect(selection).toHaveBeenCalledOnce();
    requestDocumentStatistics(doc,cached);expect(cached).toHaveBeenCalledWith({value:documentCounts});expect(worker.messages).toHaveLength(1);
    requestDocumentStatistics(EditorState.create({doc:'new note'}).doc,vi.fn());vi.advanceTimersByTime(120);expect(worker.messages).toHaveLength(2);
  });
  it('sends disjoint selected ranges separately so Markdown boundaries are preserved',async()=>{
    const {requestSelectionStatistics}=await import('./statisticsService');
    const doc=EditorState.create({doc:'**one**\n\n`two`'}).doc,listener=vi.fn();
    requestSelectionStatistics([doc.slice(0,7),doc.slice(9,14)],listener);vi.advanceTimersByTime(120);
    const worker=TestWorker.instances[0];expect(worker.messages[0]).toMatchObject({document:false,texts:['**one**','`two`']});
    worker.complete();expect(listener).toHaveBeenCalledWith({id:worker.messages[0].id,value:selectionCounts});
  });
});

describe('statistics worker results',()=>{
  it('matches synchronous writing metrics on a long document and keeps disjoint selections on the original shape',async()=>{
    vi.resetModules();
    const scope={onmessage:undefined as ((event:{data:WorkerMessage})=>void)|undefined,postMessage:vi.fn()};
    vi.stubGlobal('self',scope);
    try {
      await import('./statistics.worker');
      const {documentStatistics}=await import('./statusModel');
      const source='甲 “乙”\n\n> 丙 A2\n\n'.repeat(8000);
      expect(source.length).toBeGreaterThan(100000);
      scope.onmessage!({data:{id:1,texts:[source],document:true}});
      expect(scope.postMessage).toHaveBeenCalledWith({
        id:1,value:documentStatistics(EditorState.create({doc:source}).doc),
      });
      scope.onmessage!({data:{id:2,texts:['**one**','`two`'],document:false}});
      expect(scope.postMessage).toHaveBeenCalledWith({
        id:2,value:{characters:6,pureCount:6,paragraphs:2},
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

 describe('statistics resource release',()=>{
  beforeEach(()=>{vi.resetModules();vi.useFakeTimers();TestWorker.instances=[];vi.stubGlobal('Worker',TestWorker);});
  afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
  it('keeps shared visible subscribers alive and returns the idle worker after successful counts',async()=>{
    const {requestDocumentStatistics,statisticsIdleDelay}=await import('./statisticsService');
    const doc=EditorState.create({doc:'shared visible note'}).doc,remaining=vi.fn();
    const cancel=requestDocumentStatistics(doc,vi.fn());requestDocumentStatistics(doc,remaining);vi.advanceTimersByTime(120);const worker=TestWorker.instances[0];
    cancel();expect(worker.terminate).not.toHaveBeenCalled();worker.complete();expect(remaining).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(statisticsIdleDelay);expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('ignores late messages and errors from a cancelled worker while another visible document continues',async()=>{
    const {requestDocumentStatistics}=await import('./statisticsService');
    const cancelled=vi.fn(),visible=vi.fn(),cancel=requestDocumentStatistics(EditorState.create({doc:'old'}).doc,cancelled);vi.advanceTimersByTime(120);
    requestDocumentStatistics(EditorState.create({doc:'new visible'}).doc,visible);const old=TestWorker.instances[0];cancel();vi.advanceTimersByTime(120);const current=TestWorker.instances[1];
    old.complete();old.onerror?.();expect(cancelled).not.toHaveBeenCalled();expect(visible).not.toHaveBeenCalled();expect(current.terminate).not.toHaveBeenCalled();
    current.complete();expect(visible).toHaveBeenCalledOnce();
  });
  it('does not start a worker for a queued document whose last view closes',async()=>{
    const {requestDocumentStatistics}=await import('./statisticsService');const cancel=requestDocumentStatistics(EditorState.create({doc:'never visible again'}).doc,vi.fn());cancel();
    expect(vi.getTimerCount()).toBe(0);vi.runAllTimers();expect(TestWorker.instances).toHaveLength(0);
  });
});
