import {useFileWorkspace} from "../files/WorkspaceContext";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import {
  annotationSignature,
  subtractAnnotationRanges,
  mergeAnnotationRecords,
  mapAnnotations,
  orderedAnnotations,
  reorderAnnotations,
  textFingerprint,
  validateSubmission,
  type AnnotationSource,
  type SubmittedAnnotation,
  type TextAnnotation,
} from "./annotations";
import { canApply } from "../../shared/core";
import { setAnnotationMarks } from "./annotationDecorations";
import { pruneAnnotationCache } from "./annotationCache";
import type {Transaction} from '@codemirror/state';
import {mapStoredAnnotationRecord} from './storedAnnotationChanges';
type Dataset = {
  key: string;
  source: AnnotationSource;
  file: string;
  text: string;
  items: TextAnnotation[];
  baseItems: TextAnnotation[];
  revision: number;
  ready: boolean;
  seq: number;
  savedSeq: number;
  busy: boolean;
  loading?: boolean;
  timer?: ReturnType<typeof setTimeout>;
  error: string;
  cache?: Map<string, Dataset>;
};
const dataset = (
  source: AnnotationSource,
  file: string,
  text: string,
): Dataset => ({
  key: source + ":" + file,
  source,
  file,
  text,
  items: [],
  baseItems: [],
  revision: 0,
  ready: false,
  seq: 0,
  savedSeq: 0,
  busy: false,
  error: "",
});
export function useTextAnnotations(
  file: string,
  main: RefObject<EditorView | null>,
  scratch: RefObject<EditorView | null>,
  scratchReady: number,
  onError: (message: string, persistent?: boolean) => void,
) {
  const fileWorkspace=useFileWorkspace(),fetch=fileWorkspace.request;
  const data = useRef<Partial<Record<AnnotationSource, Dataset>>>({}),
    activeFile = useRef(file),
    errorRef = useRef(onError);
  activeFile.current = file;
  errorRef.current = onError;
  const lastMarkedIds = useRef<string[]>([]);
  const mounted = useRef(true);
  const [tick, setTick] = useState(0),
    [selected, setSelected] = useState<Set<string>>(new Set());
  const redraw = useCallback(() => {if(mounted.current)setTick((value) => value + 1);}, []);
  const persist = useRef<(record: Dataset) => Promise<void>>(async () => {});
  persist.current = async (record) => {
    if (
      !record.ready ||
      record.busy ||
      record.seq === record.savedSeq ||
      record.error
    )
      return;
    record.busy = true;
    const seq = record.seq,
      text = record.text,
      items = record.items.map((item) => ({ ...item }));
    try {
      const fingerprint = await textFingerprint(text);
      const post = (revision: number, snapshot: TextAnnotation[]) =>
        fetch("/api/annotations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: record.source,
            file: record.file,
            revision,
            fingerprint,
            items: snapshot,
          }),
        });
      let savedItems = items;
      let response = await post(record.revision, savedItems);
      if (response.status === 409) {
        const currentResponse = await fetch(
          "/api/annotations?source=" +
            record.source +
            "&file=" +
            encodeURIComponent(record.file),
        );
        const latest = await currentResponse.json();
        if (!currentResponse.ok) throw Object.assign(new Error(latest.error), {code:latest.code});
        const remote = (latest.items as TextAnnotation[]).map((item) => ({
          ...item,
          stale: item.stale || latest.fingerprint !== fingerprint,
        }));
        savedItems = mergeAnnotationRecords(
          record.baseItems || [],
          items,
          remote,
        );
        response = await post(latest.revision, savedItems);
      }
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error), {code:result.code});
      record.revision = result.revision;
      record.items =
        record.seq === seq
          ? savedItems
          : mergeAnnotationRecords(items, record.items, savedItems);
      record.baseItems = savedItems.map((item) => ({ ...item }));
      record.savedSeq = seq;
    } catch (error) {
      record.error = (error as Error).message;
      errorRef.current(record.error + " 当前标注仍保留在界面，可导出备份。", (error as {code?:string})?.code === 'HIVE_STATE_CORRUPT');
    } finally {
      record.busy = false;
      if(record.cache)pruneAnnotationCache(record.cache,data.current.document);
      if(mounted.current)redraw();
      if (record.seq !== record.savedSeq && !record.error) {
        if(mounted.current)record.timer = setTimeout(() => {record.timer=undefined;void persist.current(record);}, 300);
        else void persist.current(record);
      }
    }
  };
  useEffect(()=>{
    mounted.current=true;
    return ()=>{
      mounted.current=false;
      const records=new Set(Object.values(data.current).filter((record):record is Dataset=>!!record));
      for(const record of [...records])for(const cached of record.cache?.values()||[])records.add(cached);
      for(const record of records){
        if(record.timer){clearTimeout(record.timer);record.timer=undefined;}
        if(record.seq!==record.savedSeq&&!record.busy&&!record.error)void persist.current(record);
      }
    };
  },[]);
  useEffect(()=>fileWorkspace.register(async()=>{
    const records=new Set(Object.values(data.current).filter((record):record is Dataset=>!!record));
    for(const record of [...records])for(const cached of record.cache?.values()||[])records.add(cached);
    for(const record of records){
      if(record.busy)return '标注正在保存，请稍后再切换。';
      if(record.seq===record.savedSeq)continue;
      if(record.timer)clearTimeout(record.timer);
      await persist.current(record);
      if(record.seq!==record.savedSeq)return '有标注尚未保存，请先重试或导出备份。';
    }
  }),[]);
  const touch = useCallback(
    (record: Dataset) => {
      record.seq++;
      if (record.timer) clearTimeout(record.timer);
      if(mounted.current)record.timer = setTimeout(() => {record.timer=undefined;void persist.current(record);}, 500);
      else void persist.current(record);
      redraw();
    },
    [redraw],
  );
  const syncEditor = useCallback((source: AnnotationSource, editor: EditorView | null, expectedFile?: string) => {
    const record=data.current[source];
    if(!record?.ready || !editor || editor !== (source === "document" ? main.current : scratch.current) || (source === "document" && (!expectedFile || record.file !== expectedFile)) || editor.state.doc.toString() !== record.text) return;
    editor.dispatch({effects:setAnnotationMarks.of(record.items.filter(item=>canApply(item,record.text,record.file)).map(({id,from,to,note})=>({id,from,to,note})))});
  },[main,scratch]);
  async function load(record: Dataset) {
    if(record.loading)return;
    record.loading=true;
    try {
      const response = await fetch(
        "/api/annotations?source=" +
          record.source +
          "&file=" +
          encodeURIComponent(record.file),
      );
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error), {code:result.code});
      const capturedText = record.text;
      const fingerprint = await textFingerprint(capturedText);
      if (data.current[record.source] !== record) return;
      record.items = (result.items || []).map((item: TextAnnotation) => ({
        ...item,
        stale:
          item.stale ||
          record.text !== capturedText ||
          (!!result.fingerprint && result.fingerprint !== fingerprint) ||
          !canApply({ ...item, stale: false }, record.text, record.file),
      }));
      record.revision = result.revision;
      record.baseItems = (result.items || []).map((item: TextAnnotation) => ({
        ...item,
      }));
      record.ready = true;
      if(mounted.current)syncEditor(record.source,record.source === "document" ? main.current : scratch.current,record.file);
      if (
        result.fingerprint &&
        result.fingerprint !== fingerprint &&
        record.items.length
      )
        touch(record);
      redraw();
    } catch (error) {
      record.error = (error as Error).message;
      if (data.current[record.source] === record && mounted.current) {
        errorRef.current("标注载入失败：" + record.error, (error as {code?:string})?.code === 'HIVE_STATE_CORRUPT');
      }
      redraw();
    } finally { record.loading=false;if(record.cache)pruneAnnotationCache(record.cache,data.current.document); }
  }
  useEffect(() => {
    if (!file || !main.current) return;
    const old = data.current.document;
    if (old?.file === file) {
      const currentText=main.current.state.doc.toString();
      if(old.text!==currentText){old.text=currentText;if(old.ready){old.items=old.items.map(item=>({...item,stale:true}));touch(old);}}
      if(!old.ready&&!old.error)void load(old);
      return;
    }
    if (old?.ready) void persist.current(old);
    const cache = old?.cache || new Map<string, Dataset>();
    if (old) {
      old.cache = cache;
      cache.set(old.file, old);
    }
    const cached = cache.get(file);
    if (cached) {
      cache.delete(file);cache.set(file,cached);
      const currentText = main.current.state.doc.toString();
      if (cached.text !== currentText) {
        cached.text = currentText;
        cached.items = cached.items.map((item) => ({ ...item, stale: true }));
        touch(cached);
      }
      data.current.document = cached;
      pruneAnnotationCache(cache,cached);
      if(!cached.ready&&!cached.error)void load(cached);
      redraw();
      return;
    }
    const record = dataset("document", file, main.current.state.doc.toString());
    record.cache = cache;
    cache.set(file, record);
    data.current.document = record;
    pruneAnnotationCache(cache,record);
    void load(record);
    redraw();
  }, [file, scratchReady]);
  useEffect(() => {
    if (!scratch.current || data.current.scratch) return;
    const record = dataset(
      "scratch",
      "自由草稿",
      scratch.current.state.doc.toString(),
    );
    data.current.scratch = record;
    void load(record);
    redraw();
  }, [scratchReady]);
  const mapStoredDocument=useCallback((file:string,transaction:Transaction)=>{
    if(!transaction.docChanged)return;
    const active=data.current.document,record=active?.file===file?active:active?.cache?.get(file);
    if(record&&mapStoredAnnotationRecord(record,transaction)&&record.items.length)touch(record);
  },[touch]);
  const map = useCallback(
    (source: AnnotationSource, update: ViewUpdate) => {
      const record = data.current[source];
      if (
        !record ||
        update.view !== (source === "document" ? main.current : scratch.current) ||
        (source === "document" && record.file !== activeFile.current)
      )
        return;
      if(update.docChanged)record.text = update.state.doc.toString();
      if (update.docChanged && record.items.length) {
        record.items = mapAnnotations(record.items, update.changes);
        touch(record);
      }
    },
    [touch],
  );
  const mark = useCallback(
    (source: AnnotationSource, expectedFile?: string) => {
      const record = data.current[source],
        editor = source === "document" ? main.current : scratch.current;
      if (!record?.ready || !editor || (source === "document" && (record.file !== activeFile.current || (expectedFile !== undefined && record.file !== expectedFile))))
        throw new Error("标注正在载入，请稍后再试。");
      const ranges = editor.state.selection.ranges.filter(
        (range) => !range.empty,
      );
      if (!ranges.length)
        throw new Error("请先在正文或草稿中选中要标注的文字。");
      const createdAt = new Date().toISOString();
      const added = ranges.map((range) => ({
        id: crypto.randomUUID(),
        source,
        file: record.file,
        from: range.from,
        to: range.to,
        original: editor.state.sliceDoc(range.from, range.to),
        stale: false,
        note: "",
        createdAt,
      }));
      lastMarkedIds.current = added.map(item => item.id);
      record.items = [...record.items, ...added];
      record.text = editor.state.doc.toString();
      setSelected((set) => new Set([...set, ...added.map((item) => item.id)]));
      touch(record);
      return added[0].id;
    },
    [main, scratch, touch],
  );
  const unmark = useCallback((source: AnnotationSource, annotationId?: string, expectedFile?: string) => {
    const record = data.current[source], editor = source === "document" ? main.current : scratch.current;
    if (!record?.ready || !editor || (source === "document" && (record.file !== activeFile.current || (expectedFile !== undefined && record.file !== expectedFile)))) throw new Error("标注正在载入，请稍后再试。");
    const ranges = editor.state.selection.ranges.filter(range => !range.empty);
    const before = record.items;
    record.items = ranges.length ? subtractAnnotationRanges(before, ranges, editor.state.doc.toString()) : annotationId ? before.filter(item => item.id !== annotationId) : before;
    if (JSON.stringify(before) !== JSON.stringify(record.items)) { record.text = editor.state.doc.toString(); touch(record); }
  }, [main, scratch, touch]);
  function visibleRecords(){
    const {document,scratch}=data.current;
    return [document?.file===activeFile.current?document:undefined,scratch].filter((record):record is Dataset=>!!record);
  }
  const items=orderedAnnotations(visibleRecords().flatMap(record=>record.items));
  function reorder(id:string,before:string|null){
    const records=visibleRecords(),current=records.flatMap(record=>record.items);
    const next=new Map(reorderAnnotations(current,id,before).map(item=>[item.id,item]));
    for(const record of records){
      const updated=record.items.map(item=>next.get(item.id)||item);
      if(updated.some((item,index)=>item!==record.items[index])){record.items=updated;touch(record);}
    }
  }
  useEffect(() => {
    for (const source of ["document", "scratch"] as const) {
      const record = data.current[source],
        editor = source === "document" ? main.current : scratch.current;
      if (!record || !editor || (source === "document" && record.file !== file))
        continue;
      syncEditor(source,editor,record.file);
    }
  }, [tick, file, scratchReady]);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (
        [
          ...new Set([
            ...Object.values(data.current),
            ...(data.current.document?.cache?.values() || []),
          ]),
        ].some((record) => record.seq !== record.savedSeq)
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, []);
  function change(
    id: string,
    mutate: (item: TextAnnotation) => TextAnnotation | null,
  ) {
    for (const record of Object.values(data.current)) {
      if (!record.items.some((item) => item.id === id)) continue;
      record.items = record.items.flatMap((item) =>
        item.id === id
          ? ((next) => (next ? [next] : []))(mutate(item))
          : [item],
      );
      touch(record);
    }
  }
  function locate(item: TextAnnotation) {
    const editor = item.source === "document" ? main.current : scratch.current;
    if (!editor || item.stale)
      throw new Error("原文已变化，请重新选择目标并更新标注。");
    editor.dispatch({
      selection: { anchor: item.from, head: item.to },
      effects: EditorViewScroll(item.from),
    });
    editor.focus();
  }
  function findSubmitted(snapshot: SubmittedAnnotation): TextAnnotation | 'loading' | 'unavailable' {
    const record = data.current[snapshot.source];
    if (record?.file !== snapshot.file) return 'loading';
    if (record.error && !record.ready) return 'unavailable';
    if (!record.ready) return 'loading';
    const editor = snapshot.source === 'scratch' ? scratch.current : main.current;
    if (!editor) return 'loading';
    const item = record.items.find(item => item.id === snapshot.id);
    return item && canApply(item, editor.state.doc.toString(), snapshot.file) ? item : 'unavailable';
  }
  function submission(ids: string[]) {
    const wanted = new Set(ids),
      result: SubmittedAnnotation[] = [];
    for (const record of Object.values(data.current)) {
      const subset = record.items.filter((item) => wanted.has(item.id));
      if (subset.length)
        result.push(...validateSubmission(subset, record.text, record.file));
    }
    if (!result.length) throw new Error("请先勾选要发送的标注。");
    const byId=new Map(result.map(item=>[item.id,item]));
    return [...wanted].flatMap(id=>{const item=byId.get(id);return item?[item]:[];});
  }
  function reanchor(item: TextAnnotation) {
    const editor = item.source === "document" ? main.current : scratch.current,
      range = editor?.state.selection.main;
    if (!editor || !range || range.empty)
      throw new Error("请先在对应的正文或草稿中重新选择目标。");
    change(item.id, (old) => ({
      ...old,
      from: range.from,
      to: range.to,
      original: editor.state.sliceDoc(range.from, range.to),
      stale: false,
      respondedSignature: undefined,
    }));
  }
  return {
    retrySave: () => {
      for (const record of Object.values(data.current)) {
        record.error = "";
        if (record.ready) void persist.current(record);
        else void load(record);
      }
    },
    items,
    selected,
    mark,
    reorder,
    lastMarkedIds,
    syncEditor,mapStoredDocument,
    unmark,
    map,
    locate,
    findSubmitted,
    submission,
    reanchor,
    edit: (id: string, note: string) =>
      change(id, (item) => ({ ...item, note })),
    remove: (id: string) => change(id, () => null),
    toggle: (id: string) =>
      setSelected((set) => {
        const next = new Set(set);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      }),
    selectAll: () =>
      setSelected(
        new Set(items.filter((item) => !item.stale).map((item) => item.id)),
      ),
    responded: (submitted: SubmittedAnnotation[]) =>
      submitted.forEach((snapshot) =>
        change(snapshot.id, (item) => ({
          ...item,
          respondedSignature: annotationSignature(snapshot),
        })),
      ),
    saving: Object.values(data.current).some(
      (record) =>
        record.busy || (record.seq !== record.savedSeq && !record.error),
    ),
    saveError: Object.values(data.current).some((record) => !!record.error),
    ready: !!data.current.document?.ready && data.current.document.file === file,
  };
}
import { EditorView as View } from "@codemirror/view";
const EditorViewScroll = (position: number) =>
  View.scrollIntoView(position, { y: "center" });
