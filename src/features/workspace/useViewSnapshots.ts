import {captureEditorView} from '../editor/editorViewSnapshot';
import type { RefObject } from 'react';
import type { ViewUpdate } from '@codemirror/view';
import type { ApiClient } from '../../shared/api';
import type { Mode } from '../../shared/core';
import type { DiskFile } from '../../shared/fileTypes';
import type { EditorSession } from '../editor/editorSessionTypes';
import { makeState } from '../editor/Editor';
import { matchesViewEditor, omitTransientDocumentTabs, remapViewLayout, type ViewPreset, type ViewSnapshot } from './viewPresets';
import type { usePanelWorkspace } from './usePanelWorkspace';

const uid = () => crypto.randomUUID();

type ViewSnapshotsOptions = {
    workspace: ReturnType<typeof usePanelWorkspace>;
    sessions: RefObject<Map<string, EditorSession>>;
    activeSession: RefObject<string>;
    bindings: (id: string) => { onUpdate: (update: ViewUpdate) => void };
    activateEditor: (id: string) => void;
    api: ApiClient;
    appearance: {
        appearance: ViewSnapshot['appearance'];
        setAppearance: (value: ViewSnapshot['appearance']) => void;
    };
    statusPreferences: {
        items: ViewSnapshot['statusItems'];
        countMode: ViewSnapshot['statusCountMode'];
        setOptions: (options: { items: ViewSnapshot['statusItems']; countMode: NonNullable<ViewSnapshot['statusCountMode']> }) => void;
    };
    mode: Mode;
    currentMode: RefObject<Mode>;
    appAlive: RefObject<boolean>;
    viewApplying: RefObject<boolean>;
    running: RefObject<boolean>;
    switching: RefObject<boolean>;
    fileBusy: boolean;
    filter: string;
    setFilter: (value: string) => void;
    collapsed: Set<string>;
    setCollapsed: (value: Set<string>) => void;
    chatOrb: boolean;
    setChatOrb: (value: boolean) => void;
    orbPosition: RefObject<{ x: number; y: number } | undefined>;
    orbBounds: RefObject<{ width: number; height: number }>;
    redraw: () => void;
};

/** 视图快照的采集与应用：把「当前打开哪些标签、各自滚动到哪」存成可复用的视图预设。 */
export function useViewSnapshots({ workspace, sessions, activeSession, bindings, activateEditor, api, appearance, statusPreferences, mode, currentMode, appAlive, viewApplying, running, switching, fileBusy, filter, setFilter, collapsed, setCollapsed, chatOrb, setChatOrb, orbPosition, orbBounds, redraw }: ViewSnapshotsOptions) {
    function captureView(): ViewSnapshot {
        const externalTabs=new Set([...sessions.current.values()].filter(session=>session.external).map(session=>session.id));
        const layout = omitTransientDocumentTabs(workspace.capture(),externalTabs);
        const activeEditor=sessions.current.get(activeSession.current)?.trashPreview||externalTabs.has(activeSession.current)?
            [...layout.open,...layout.minimized].find(id=>sessions.current.has(id))??'editor':activeSession.current;
        const included = new Set([...layout.open, ...layout.minimized, activeEditor]);
        return {
            layout,
            editors: [...sessions.current.values()].filter(session => !session.trashPreview&&!session.external&&included.has(session.id)).map(session => {
                captureEditorView(session);
                const state = session.view?.state || session.state, range = state?.selection.main;
                return { id: session.id, file: session.disk?.path || null, imagePath:session.imagePath, anchor: range?.anchor || 0, head: range?.head || 0, scrollTop: session.restoreScroll ?? 0,scrollLeft:session.restoreScrollLeft??0, typewriter: !!session.typewriter, displayMode: session.displayMode || 'live', landing: !!session.landing };
            }),
            activeEditor,
            appearance: { ...appearance.appearance },
            statusItems: [...statusPreferences.items],
            statusCountMode: statusPreferences.countMode,
            filter,
            collapsed: [...collapsed],
            chatOrb,
            orbPosition: orbPosition.current ? { ...orbPosition.current } : undefined,
            orbBounds: { ...orbBounds.current },
        };
    }
    async function applyView(saved: ViewPreset) {
        if (workspace.locked)
            throw new Error('请先解锁工作区位置，再应用其他视图。');
        if (viewApplying.current)
            throw new Error('视图正在应用，请稍后再试。');
        viewApplying.current = true;
        try {
            if (saved.mode !== mode)
                throw new Error('请在这个视图所属的写作模式中应用。');
            if (fileBusy || switching.current)
                throw new Error('文件正在载入或保存，请稍后应用视图。');
            if (running.current)
                throw new Error('请先停止当前生成，再应用视图。');
            const mapping = new Map<string, string>(), used = new Set<string>(), created: EditorSession[] = [], missing = new Set<string>();
            for (const descriptor of saved.editors) {
                const same = [...sessions.current.values()].find(session => !used.has(session.id) && session.id === descriptor.id && matchesViewEditor(session, descriptor))
                    || [...sessions.current.values()].find(session => !used.has(session.id) && matchesViewEditor(session, descriptor));
                const id = same?.id || 'editor:' + uid();
                mapping.set(descriptor.id, id);
                used.add(id);
                if (!same && descriptor.file && ![...sessions.current.values()].some(session => session.disk?.path === descriptor.file))
                    missing.add(descriptor.file);
            }
            const paths = [...missing], results = await Promise.allSettled(paths.map(path => api<DiskFile>('/file?path=' + encodeURIComponent(path)))), loaded = new Map<string, DiskFile>();
            const failed: string[] = [];
            results.forEach((result, index) => {
                if (result.status === 'fulfilled')
                    loaded.set(paths[index], result.value);
                else
                    failed.push(paths[index] + '：' + result.reason.message);
            });
            if (failed.length)
                throw new Error('暂时无法恢复这个视图的文档。' + failed.slice(0, 3).join('；'));
            if (!appAlive.current || currentMode.current !== saved.mode)
                throw new Error('写作模式或空间已经变化，请重新选择视图。');
            for (const descriptor of saved.editors) {
                const existing = sessions.current.get(mapping.get(descriptor.id)!);
                if (existing && !matchesViewEditor(existing, descriptor))
                    throw new Error('打开的文档已变化，请重新应用视图。');
            }
            for (const descriptor of saved.editors) {
                const id = mapping.get(descriptor.id)!;
                if (sessions.current.has(id))
                    continue;
                if(descriptor.imagePath){await api('/image-file/info?path='+encodeURIComponent(descriptor.imagePath));if(!appAlive.current||currentMode.current!==saved.mode)throw new Error('写作空间已变化。');created.push({id,imagePath:descriptor.imagePath,disk:null,state:null,view:null,dirty:false});continue;}
                const source = [...sessions.current.values(), ...created].find(session => session.disk?.path === descriptor.file), data = source?.disk || loaded.get(descriptor.file || '') || null;
                const text = source ? (source.view?.state || source.state)?.doc.toString() || '' : data?.text || '';
                const state = makeState(text, bindings(id).onUpdate,undefined,descriptor.displayMode), anchor = Math.min(descriptor.anchor, state.doc.length), head = Math.min(descriptor.head, state.doc.length);
                created.push({ id, disk: data ? { ...data } : null, state: state.update({ selection: { anchor, head } }).state, view: null, dirty: text !== (data?.text || ''), restoreScroll: descriptor.scrollTop,restoreScrollLeft:descriptor.scrollLeft||0, landing: !!descriptor.landing });
            }
            created.forEach(session => sessions.current.set(session.id, session));
            activateEditor(mapping.get(saved.activeEditor)!);
            for (const descriptor of saved.editors) {
                const session = sessions.current.get(mapping.get(descriptor.id)!)!, state = session.view?.state || session.state;
                session.typewriter = descriptor.typewriter === true;
                session.displayMode = descriptor.displayMode || 'live';
                if (!state)
                    continue;
                const selection = { anchor: Math.min(descriptor.anchor, state.doc.length), head: Math.min(descriptor.head, state.doc.length) };
                if (session.view) {
                    const editor = session.view;
                    editor.dispatch({ selection });
                    requestAnimationFrame(() => { if (session.view === editor){editor.scrollDOM.scrollTop = descriptor.scrollTop;editor.scrollDOM.scrollLeft=descriptor.scrollLeft||0;} });
                }
                else {
                    session.state = state.update({ selection }).state;
                    session.restoreScroll = descriptor.scrollTop;session.restoreScrollLeft=descriptor.scrollLeft||0;
                }
            }
            workspace.restoreLayout(remapViewLayout(saved.layout, mapping));
            appearance.setAppearance({ ...saved.appearance });
            statusPreferences.setOptions({ items: [...saved.statusItems], countMode: saved.statusCountMode || 'characters' });
            setFilter(saved.filter);
            setCollapsed(new Set(saved.collapsed));
            setChatOrb(saved.chatOrb);
            orbPosition.current = saved.orbPosition ? { ...saved.orbPosition } : undefined;
            orbBounds.current = { ...saved.orbBounds };
            redraw();
        }
        finally {
            viewApplying.current = false;
        }
    }
    return { captureView, applyView };
}
