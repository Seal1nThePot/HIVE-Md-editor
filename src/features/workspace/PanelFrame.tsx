import { ContentsPanel, Icon, NoteProperties, Maximize2, PanelLeftOpen, Minus, X, Square } from "../../shared/icons";
import type { ReactNode, RefObject } from 'react';
import {useWindowAnnotations} from '../annotations/windowAnnotations';
import type { AnnotationSource } from '../annotations/annotations';
import type { EditorSession } from '../editor/editorSessionTypes';
import DisplayModeControl from '../editor/DisplayModeControl';
import type { RibbonCommand } from '../ribbon/Ribbon';
import PanelControl from './PanelControl';
import type { usePanelWorkspace } from './usePanelWorkspace';
import { DesktopPanel, useDesktopPanels } from './DesktopPanels';
import type {PanelAction} from './PanelControl';

export function nativeWindowActions(id?:string):PanelAction[] {
    return [
        {label:'最小化窗口',icon:<Minus size={14}/>,run:()=>window.hiveDesktop?.windowCommand('minimize',id)},
        ...(id?[]:[{label:'最大化／还原窗口',icon:<Square size={14}/>,run:()=>window.hiveDesktop?.windowCommand('maximize')}]),
        ...(!id?[{label:'保存并退出 HIVE markdown editor',icon:<X size={14}/>,run:()=>window.hiveDesktop?.windowCommand('close')}]:[]),
    ];
}

export type PanelWorkspaceApi = ReturnType<typeof usePanelWorkspace>;

/** 面板外框需要知道的上下文：工作区布局、标签页清单与几个打开/关闭动作。 */
export type PanelChrome = {
    workspace: PanelWorkspaceApi;
    sessions: RefObject<Map<string, EditorSession>>;
    editorIds: string[];
    panelLabel: (id: string) => string;
    closeEditor: (id: string) => void;
    minimizeEditor: (id: string) => void;
    activateEditor: (id: string) => void;
    redraw: () => void;
    activeTextSource: RefObject<AnnotationSource>;
    ribbonCommand: (command: RibbonCommand) => void;
};

export const emptyPanelFooter = (title: string) => <div className="panel-status-footer panel-status-footer-empty" aria-label={`${title}底栏`} />;

export function PanelControls({ chrome, id, groupMembers }: { chrome: PanelChrome; id: string; groupMembers?: string[] }) {
    const desktop = useDesktopPanels(), detached = desktop.windows.has(id);
    groupMembers=groupMembers||desktop.paneMembers(id);
    const { workspace, sessions, editorIds, panelLabel, closeEditor, minimizeEditor, activateEditor, redraw, activeTextSource, ribbonCommand } = chrome;
    const panel = workspace.panel(id), isEditor = sessions.current.has(id);
    const trashPreview=!!sessions.current.get(id)?.trashPreview;
    const label = isEditor ? `正文 ${editorIds.indexOf(id) + 1}` : panelLabel(id);
    const primary = groupMembers?.includes('editor') || panel.primary;
    const close = () => { for (const member of groupMembers || [id])
        sessions.current.has(member) ? closeEditor(member) : workspace.panel(member).close(); };
    const minimize = () => { for (const member of groupMembers || [id])
        sessions.current.has(member) ? minimizeEditor(member) : workspace.panel(member).minimize(); };
    const float = () => {
        if(detached){workspace.returnNativePanel(id);return;}
        if(groupMembers&&groupMembers.length>1)workspace.groupFloat(id);else workspace.floatNativePanel(id);
    };
    const controls = <PanelControl panelId={id} label={label} floating={panel.floating} primary={primary} movable={groupMembers ? groupMembers.every(member => workspace.panel(member).movable) : panel.movable} canDock={panel.canDock} onToggleFloat={groupMembers ? () => workspace.groupFloat(id) : panel.toggleFloat} onOpen={groupMembers ? () => workspace.groupDock(id) : panel.openDocked} collapseEdge={panel.collapseEdge}
        onClose={close} onCloseCurrent={isEditor?()=>closeEditor(id):panel.close} closeCurrentDisabled={panel.primary} onMinimize={minimize}
        floatAction={desktop.enabled ? { label: detached ? '移回主窗口' : groupMembers&&groupMembers.length>1 ? '整组浮动' : '浮动面板', icon: detached ? <PanelLeftOpen size={14}/> : <Maximize2 size={14}/>, run: float, disabled:!detached&&(primary||!panel.movable||!!groupMembers?.some(member=>!workspace.panel(member).movable)) } : undefined}
        memberActions={groupMembers ? [
            ...(desktop.enabled ? [] : [{ label: '单独浮动', disabled: panel.primary || !panel.movable, run: panel.openFloating }]),
            { label: '收纳当前窗口', disabled: panel.primary, run: isEditor ? () => minimizeEditor(id) : panel.minimize },
            { label: '关闭当前窗口', disabled: panel.primary, run: isEditor ? () => closeEditor(id) : panel.close },
            { label: '打开当前窗口并停靠', disabled: panel.primary || !panel.canDock, run: panel.openDocked },
        ] : undefined}
        actions={[...(detached?nativeWindowActions(desktop.owner(id)):[]),...(isEditor&&!trashPreview ? [
            { label: '插入笔记属性', icon: <NoteProperties size={14} />, disabled: !sessions.current.get(id)?.view, run: () => { activateEditor(id); activeTextSource.current = 'document'; ribbonCommand('properties'); } },
            { label: '标题目录', icon: <ContentsPanel size={14} />, checked: workspace.isOpen('toc'), run: () => { activateEditor(id); workspace.toggle('toc'); } },
        ] : [])]} detached={detached} />;
    return isEditor&&!trashPreview
        ? <div className="document-panel-controls"><DisplayModeControl label={label} displayMode={sessions.current.get(id)?.displayMode || 'live'} onDisplayMode={mode => { sessions.current.get(id)!.displayMode = mode; redraw(); }} typewriter={!!sessions.current.get(id)?.typewriter} onTypewriter={enabled => { sessions.current.get(id)!.typewriter = enabled; redraw(); }} />{controls}</div>
        : controls;
}

/** 停靠/浮动面板的外框：标题栏 + 面板控制按钮 + 底栏 + 拖拽把手。 */
export function PanelFrame({ chrome, id, title, className, children }: { chrome: PanelChrome; id: string; title: string; className: string; children: ReactNode }) {
    const panel = chrome.workspace.panel(id),{markedPanels}=useWindowAnnotations();
    return <DesktopPanel id={id} title={title} open={chrome.workspace.isOpen(id)} visible={panel.visible}><aside key={id} ref={panel.ref} data-panel-id={id} aria-label={`${title}面板`}
        className={`workspace-panel independent-workspace-panel ${className} ${panel.grouped ? 'panel-grouped' : ''} ${panel.floating ? "panel-floating" : "panel-docked"}`}
        style={panel.style} onPointerDownCapture={panel.raise}>
        <div className="independent-panel-header panel-drag-header" data-window-annotation={markedPanels.indexOf(id)+1||undefined} data-lock-panel={id} data-position-locked={panel.positionLocked || undefined} title={panel.lockHint} onPointerDown={panel.beginDrag}>
            <b>{title}</b><PanelControls chrome={chrome} id={id} />
            {panel.positionLocked&&<Icon name="panel.positionLocked" className="panel-position-lock-icon" size={11}/>}
        </div>{children}{id !== "scratch" && emptyPanelFooter(title)}{panel.handles}</aside></DesktopPanel>;
}
