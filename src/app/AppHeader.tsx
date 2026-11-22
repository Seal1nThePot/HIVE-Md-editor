import {useShortcutPreferences} from '../features/settings/ShortcutPreferences';
import {shortcutLabel} from '../features/settings/shortcuts';
import { ChevronDown, CircleHelp, Icon, Lock, LockOpen, Save, Settings2, Minus, Square, X } from "../shared/icons";
import type { PanelWorkspaceApi } from '../features/workspace/PanelFrame';
import type { useFileWorkspace } from '../features/files/WorkspaceContext';
import {repositoryLabel} from '../features/files/WorkspaceContext';
import PanelSwitcher, { type PanelCategory } from '../features/workspace/PanelSwitcher';
import { activeModelLabel, type Config } from '../features/settings/modelConfig';
import type { SettingsSection } from '../features/settings/SettingsPage';
import {useDesktopPanels} from '../features/workspace/DesktopPanels';

type AppHeaderProps = {
    workspace: PanelWorkspaceApi;
    openChat: (tab?: 'conversation' | 'annotations') => void;
    openSettings: (section?: SettingsSection) => void;
    openHistory: () => void;
    save: () => Promise<void>;
    fileWorkspace: ReturnType<typeof useFileWorkspace>;
    config: Config;
    file: string;
    fileBusy: boolean;
    openingFile: boolean;
    chatOpen: boolean;
    leftOpen: boolean;
    setError: (message: string) => void;
    setHelp: (open: boolean) => void;
};

/** 顶栏：写作空间、保存/自动保存、帮助、模型、面板切换器、锁定/设置。 */
export function AppHeader({ workspace, openChat, openSettings, openHistory, save, fileWorkspace, config, file, fileBusy, openingFile, chatOpen, leftOpen, setError, setHelp }: AppHeaderProps) {
    const desktop=useDesktopPanels(),{bindings}=useShortcutPreferences();
    const modelLabel=activeModelLabel(config);
    return (
        <header className="app-header" onPointerDown={event=>{if(desktop.enabled)desktop.beginDrag('$main',event);}}
          onDoubleClick={event=>{if(desktop.enabled&&!(event.target as Element).closest('button,input,label,a,select,[data-no-drag]'))window.hiveDesktop?.windowCommand('maximize');}}>
        <div className="header-workspace">
        <div className="user-avatar" aria-label="用户头像">我</div>
        <button
          className="workspace-switcher"
          title={`仓库管理 · ${fileWorkspace.info.root}`}
          aria-label="仓库管理"
          onClick={() => {
            workspace.open('repositories');
          }}
        >
          <Icon name="panel.repositories" className="workspace-switcher-icon" />
          <b>{repositoryLabel(fileWorkspace.info.repositories.find(item=>item.id===fileWorkspace.info.id)||fileWorkspace.info)}</b>
          <ChevronDown className="workspace-switcher-chevron" aria-hidden="true" />
        </button>
        <div className="quick-file-actions" aria-label="文档保存与帮助操作">
          <div className="save-with-autosave">
            <button type="button" className="header-save-button" aria-label="保存正文" title={`保存 · ${shortcutLabel(bindings,'save')}`} disabled={!file||fileBusy} data-opening-file={file&&openingFile||undefined} onClick={()=>void save()}><Save size={16}/></button>
            <label className="auto-save-toggle" data-no-drag title={fileWorkspace.info.autoSave?'自动保存已开启 · 点击关闭':'自动保存已关闭 · 点击开启'}><input type="checkbox" role="switch" aria-label="自动保存正文" checked={fileWorkspace.info.autoSave} onChange={event=>void fileWorkspace.update({autoSave:event.target.checked}).catch(error=>setError(error.message))}/></label>
          </div>
          <button type="button" className="header-help" aria-label="使用指南" title="使用指南" onClick={() => setHelp(true)}><CircleHelp size={17}/></button>
          <button type="button" className="header-help" aria-label="历史记录" title="历史记录" onClick={openHistory}><Icon name="history.open" size={17}/></button>
        </div>
        </div>
        <div className="header-right"><div className="header-actions">

          <button
            className={"connection " + (!config.demo ? "live" : "")}
            title={modelLabel}
            onClick={() => {
              openSettings('models');
            }}
          >
            <i />
            <span className="connection-label">{modelLabel}</span>
            <ChevronDown size={12} />
          </button>
          <span className="header-divider" />
          <PanelSwitcher items={[
            {id:"files",label:"文档（文件列表）",open:leftOpen,category:'files',keywords:['目录','文件夹','浏览器']},
            {id:'repositories',label:'仓库管理',open:workspace.isOpen('repositories'),category:'files',keywords:['仓库','项目','目录','切换']},
            {id:"trash",label:"回收站",open:workspace.isOpen('trash'),category:'files',keywords:['恢复','删除','清理']},
            {id:"conversation",label:"对话",open:chatOpen,category:'ai',keywords:['聊天','模型']},
            {id:"annotations",label:"标注",open:workspace.isOpen("annotations"),category:'writing',keywords:['选区','批注']},
            {id:"outline",label:"大纲",open:workspace.isOpen("outline"),category:'writing',keywords:['节点','章节']},
            {id:'properties',label:'笔记属性',open:workspace.isOpen('properties'),category:'writing',keywords:['文档属性','元数据','frontmatter']},
            {id:"toc",label:"标题目录",open:workspace.isOpen("toc"),category:'writing',keywords:['标题','导航']},
            {id:"scratch",label:"草稿",open:workspace.isOpen("scratch"),category:'writing',keywords:['草稿纸','临时']},
            {id:"basis",label:"依据",open:workspace.isOpen("basis"),category:'ai',keywords:['参考','资料','上下文']},
            {id:"search",label:"查找替换",open:workspace.isOpen("search"),category:'tools',keywords:['查找','搜索','替换']},
          ].map(item=>({...item,category:item.category as PanelCategory,locked:workspace.isPositionLocked(item.id)}))} onToggleLock={workspace.togglePositionLock} onReveal={id=>{workspace.open(id);workspace.panel(id).raise();requestAnimationFrame(()=>{const element=workspace.panel(id).ref.current;if(element){element.tabIndex=-1;element.focus({preventScroll:true});element.classList.add('panel-located');setTimeout(()=>element.classList.remove('panel-located'),1200);}});}} onToggle={id=>{
            if(id==="conversation") {
              if(chatOpen)workspace.close(id);else openChat("conversation");
            } else workspace.toggle(id);
          }}/>
          <button
            className={'icon-button workspace-lock-button'+(workspace.locked?' active':'')}
            title={workspace.locked?'解锁工作区位置 · 面板仍可打开和收纳':'锁定工作区位置 · 浮窗仍可移动'}
            aria-label={workspace.locked?'解锁工作区位置':'锁定工作区位置'}
            aria-pressed={workspace.locked}
            onClick={workspace.toggleLocked}
          >{workspace.locked?<Lock size={16}/>:<LockOpen size={16}/>}</button>
          <button
            className="icon-button"
            title="设置"
            aria-label="设置"
            onClick={() => {
              openSettings('appearance');
            }}
          >
            <Settings2 size={17} />
          </button>
        </div>{desktop.enabled&&<div className="header-window-controls" aria-label="软件窗口操作">
          <button type="button" className="icon-button" aria-label="最小化主窗口" title="最小化" onClick={()=>window.hiveDesktop?.windowCommand('minimize')}><Minus size={16}/></button>
          <button type="button" className="icon-button" aria-label="最大化或还原主窗口" title="最大化／还原" onClick={()=>window.hiveDesktop?.windowCommand('maximize')}><Square size={15}/></button>
          <button type="button" className="icon-button header-window-close" aria-label="保存并退出软件" title="保存并退出" onClick={()=>window.hiveDesktop?.windowCommand('close')}><X size={17}/></button>
        </div>}</div>
      </header>
    );
}
