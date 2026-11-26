import ImageFileView from '../features/files/ImageFileView';
import {retireDeletedImage} from '../features/files/imageSession';
import {resolveLinkTarget} from '../features/editor/linkNavigation';
import {openExternalHttpLink} from '../shared/externalLinks';
import {useApplyTheme} from '../features/theme/applyTheme';
import {flushThemeFiles} from '../features/theme/templateFiles';
import {flushThemePreferences} from '../features/theme/themeStore';
import {applyStoredDocumentChange,mapStoredSessionContext} from '../features/editor/storedDocumentChanges';
import {Transaction,type EditorState} from '@codemirror/state';
import {captureEditorView} from '../features/editor/editorViewSnapshot';
import {findAnnotatedNote,planAnnotatedDocuments,planAnnotatedTrash,planNoteOutline,planNoteProperties,requestApi,runAnnotatedRepositories,type DocumentsToolResult,type NoteFindResult,type NoteOutlineToolResult,type NotePropertiesToolResult,type NoteSnapshotToolResult,type RepositoriesToolResult,type TrashToolResult} from './api';
import {activeEditor} from '../features/editor/activeEditor';
import {type ChatAnnotationBatch,type ChatMessageDetails,type Message} from '../features/chat/chatTypes';
import {trashPreviewTabPrefix,type EditorSession} from '../features/editor/editorSessionTypes';
import type {Dialog} from '../features/editor/editorDialogTypes';
import {useDocumentPersistence} from '../features/files/useDocumentPersistence';
import {useFileActions} from '../features/files/useFileActions';
import {useViewSnapshots} from '../features/workspace/useViewSnapshots';
import {PanelFrame,PanelControls,emptyPanelFooter,type PanelChrome} from '../features/workspace/PanelFrame';
import {AppHeader} from './AppHeader';
import {WindowAnnotationProvider,useWindowAnnotations,useWindowAnnotationGesture,type WindowMark,type WorkspaceAnnotationTarget} from '../features/annotations/windowAnnotations';
import {workspaceAnnotationAttachment} from '../features/annotations/workspaceAnnotationAttachment';
import {useAnnotationActions} from '../features/annotations/useAnnotationActions';
import HistoryPage,{type HistoryPageProps,type HistoryTab} from '../features/history/HistoryPage';
import {historyTextChanges,historyTextPatch,planHistoryText} from '../features/history/historyText';
import type {HistoryActor,HistoryOutline,HistoryRecord,HistorySection} from '../features/history/historyTypes';
import {useHistoryJournal} from '../features/history/useHistoryJournal';
import {useHumanHistory} from '../features/history/useHumanHistory';
import {notePropertiesTransaction,readNoteProperties} from '../features/editor/noteProperties';
import {generateWriting,stopWritingGeneration,type GenerationOptions,type WritingRequestOrigin} from '../features/chat/writingGeneration';
import {createProposalActions,replayPolishProposal} from '../features/chat/proposalActions';
import {runEditorCommand} from '../features/ribbon/editorCommands';
// Load the complete style stack with App, including in already-open Vite sessions.
import "./styles.css";
import "../features/annotations/annotations.css";
import "../features/workspace/workbench-v3.css";
import "../features/workspace/free-workspace.css";
import "../features/workspace/panel-chrome.css";
import "../features/editor/editor-tabs.css";
import {documentMatchesText} from '../features/editor/documentText';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import {WorkspaceProvider, useFileWorkspace, type WorkspaceInfo} from "../features/files/WorkspaceContext";
import type {AnnotationContext} from '../features/editor/EditorContextMenu';
import EditorStatusBar, {useStatusPreferences} from "../features/editor/EditorStatusBar";
import "../features/files/files.css";
import TrashPanel,{type TrashRecord} from '../features/files/TrashPanel';
import TrashDocumentPreview,{loadTrashDocument} from '../features/files/TrashDocumentPreview';
import RepositoryPanel from '../features/files/RepositoryPanel';
import FileExplorer,{type FileAction} from "../features/files/FileExplorer";
import FilePicker from '../features/files/FilePicker';
import {readRecentDocuments,rememberRecentDocument} from '../features/files/recentDocuments';
import NewTabPage,{NewTabButton} from '../features/editor/NewTabPage';
import {flattenEntries,parentPath,type Entry} from "../features/files/explorerState";
import QuickOpenPanel from '../features/files/QuickOpenPanel';
import {useQuickOpen} from '../features/files/useQuickOpen';
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import {undo as undoDocument,redo as redoDocument} from '@codemirror/commands';
import {
  ArrowLeft,
  CheckCheck,
  ChevronRight,
  ContentsPanel,
  DocumentsPanel,
  FileImage,
  Highlighter,
  Icon,
  iconComponent,
  MessageSquare,
  NoteProperties,
  OutlinesPanel,
  RotateCcw,
  ScratchPanel,
  Trash2,
  X,
} from "../shared/icons";
import Editor,{rebindDocumentUpdates} from "../features/editor/Editor";
import type {InlineProposal} from "../features/editor/proposalInline";
import {ProposalOverlay} from "../features/editor/ProposalOverlay";
import DisplayModeControl from '../features/editor/DisplayModeControl';
import {prepareDocumentTabClose} from '../features/editor/closeDocumentTab';
import FindReplacePanel from '../features/editor/FindReplacePanel';
import NotePropertiesPanel from '../features/editor/NotePropertiesDialog';
import EditorInsertDialog,{type InsertTarget} from '../features/editor/EditorInsertDialog';
import TableOfContents from '../features/outline/TableOfContentsPanel';
import type {RibbonCommand} from '../features/ribbon/Ribbon';
import Ribbon from "../features/ribbon/Ribbon";
import WritingOutline from "../features/outline/WritingOutlineV2";
import { targetForNode,type WritingNode } from "../features/outline/writingNodes";
import { useWritingNodes } from "../features/outline/useWritingNodes";
import { usePanelWorkspace, type PanelWorkspacePlacement } from "../features/workspace/usePanelWorkspace";
import { isEditorPanel, PRIMARY_EDITOR } from "../features/workspace/workspacePolicy";
import { findPanelGroup, omitWorkspacePanels } from "../features/workspace/workspaceState";
import PanelControl from "../features/workspace/PanelControl";
import ViewControls from "../features/workspace/ViewControls";
import PanelIconRail from "../features/workspace/PanelIconRail";
import type {DockEdge} from "../features/workspace/panelLayout";
import WritingModeControl from "../features/chat/WritingModeControl";
import GlobalToolbar from "../features/chat/GlobalToolbar";
import {useReferenceSources,type AttachmentReferenceSource,type ReferenceSource,type WorkspaceReferenceSource} from '../features/chat/referenceSources';
import {REFERENCE_DRAG_TYPE,readReferenceDrag} from '../features/files/referenceDrag';
import {CHAPTER_DRAG_TYPE,appendDraftContext,chapterForQuickAI,readChapterDrag,type ChapterDrag} from '../features/chat/contextDraft';
import type {DragEvent as ReactDragEvent} from 'react';
import {useModelReasoning} from '../features/chat/modelReasoning';
import ChatComposer from "../features/chat/ChatComposer";
import {ChatActionStrip} from '../features/chat/ChatActionStrip';
import {useAIButtonLayout,type AIButtonId,type AIButtonRegion} from '../features/chat/aiButtonLayout';
import {ChatAttachmentList} from '../features/chat/ChatAttachmentList';
import {appendChatAttachments,type ChatAttachment} from '../features/chat/chatAttachments';
import {chatPromptSetter,consumeChatDraft,forkChatReply,hasChatDraft,newConversation,recoverChatDraft,restoreParkedDraft,retractChatReply,withoutRetriedPrompt,type ChatDraft,type Conversation} from '../features/chat/chatConversations';
import {isNoteTool,isWindowTool,resolveChatTarget,type ChatTarget} from '../features/chat/chatTarget';
import {ChatMarkdown} from '../features/chat/ChatMarkdown';
import {ChatAnnotationBatchView,ChatAnnotationEntries} from '../features/chat/ChatAnnotationEntries';
import '../features/chat/chat-messages.css';
import InputBasisPanel,{type InputBasisRequest} from '../features/chat/InputBasisPanel';
import WorkspaceTabs from "../features/workspace/WorkspaceTabs";
import RailEdgeHandle from "../features/workspace/RailEdgeHandle";
import {ShortcutPreferencesProvider,useShortcutPreferences} from '../features/settings/ShortcutPreferences';
import {matchesShortcut,shortcutLabel} from '../features/settings/shortcuts';
import SettingsPage, {type SettingsSection} from "../features/settings/SettingsPage";
import {usePlugins} from '../features/settings/usePlugins';
import {initialConfig, parseModelChoice, selectedModelEntry, type Config, type ModelProbeRequest, type ModelProbeResult} from "../features/settings/modelConfig";
import { useAppearance } from "../features/settings/useAppearance";
import {useAnnotationPreferences} from '../features/settings/useAnnotationPreferences';
import {usePanelIconDragPreferences} from '../features/settings/usePanelIconDragPreferences';
import {useAIResponsePreferences} from '../features/settings/useAIResponsePreferences';
import InlineAnnotationEditor, {
  type InlineAnnotationRequest,
} from "../features/annotations/InlineAnnotationEditor";
import ScratchPad from "../features/scratch/ScratchPad";
import { useTextAnnotations } from "../features/annotations/useTextAnnotations";
import AnnotationPanel from "../features/annotations/AnnotationPanel";
import FloatingOrb from "../features/chat/FloatingOrb";
import { createPortal } from 'react-dom';
import { DesktopPanel, DesktopPanelsProvider, useDesktopPanels } from '../features/workspace/DesktopPanels';
import {
  type AnnotationSource,
  type SubmittedAnnotation,
  type TextAnnotation,
} from "../features/annotations/annotations";
import {
  canApplyToDocument,
  previewIntact,
  headings,
  mapAnchor,
  minimalReplacement,
  modeLabels,
  type Anchor,
  type Mode,
  type Proposal,
  type UndoEdit,
} from "../shared/core";

const uid = () => crypto.randomUUID();
const FileTextIcon=iconComponent('file.text');
const railIcons:Record<string,typeof FileTextIcon>={
  files:DocumentsPanel,'quick-open':DocumentsPanel,repositories:iconComponent('panel.repositories'),conversation:MessageSquare,
  outline:OutlinesPanel,toc:ContentsPanel,scratch:ScratchPanel,annotations:Highlighter,properties:NoteProperties,
  basis:iconComponent('panel.basis'),search:iconComponent('editor.findReplace'),trash:Trash2,
};

type RepositoryPanelPlacement=PanelWorkspacePlacement & {activeEditor:string};

export default function App() {
  useApplyTheme();
  const [current,setCurrent]=useState<{info:WorkspaceInfo;placement?:RepositoryPanelPlacement}|null>(null);
  const [error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  const capturePlacement=useRef<(()=>RepositoryPanelPlacement)|null>(null);
  useEffect(()=>{let alive=true;fetch('/api/workspace').then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error);if(alive){setCurrent({info:data});setError('');}}).catch(error=>{if(alive)setError(error.message);});return()=>{alive=false;};},[attempt]);
  if(!current)return <div className="workspace-loading" role="status">{error||'正在打开写作空间…'}{error&&<button onClick={()=>setAttempt(value=>value+1)}>重试</button>}</div>;
  const {info,placement}=current;
  function changeWorkspace(next:WorkspaceInfo){
    setCurrent({info:next,placement:next.id===info.id?placement:capturePlacement.current?.()});
  }
  return <WorkspaceProvider key={info.id} info={info} onChange={changeWorkspace}><ShortcutPreferencesProvider><WindowAnnotationProvider><DesktopPanelsProvider>
    <WritingApp initialPlacement={placement} capturePlacement={capturePlacement}/>
  </DesktopPanelsProvider></WindowAnnotationProvider></ShortcutPreferencesProvider></WorkspaceProvider>;
}
function WritingApp({initialPlacement,capturePlacement}:{
  initialPlacement?:RepositoryPanelPlacement;
  capturePlacement:RefObject<(()=>RepositoryPanelPlacement)|null>;
}) {
  const desktopPanels = useDesktopPanels();
  const {bindings:shortcutBindings}=useShortcutPreferences();
  const {markedPanels,marks,remove:removeWindowMark}=useWindowAnnotations();
  const closing = useRef(false);
  const [closingWindow,setClosingWindow] = useState(false);
  const fileWorkspace=useFileWorkspace(),request=fileWorkspace.request;
  const requestModel: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Hive-Model-Session', conversationId);
    return request(input, {...init, headers});
  };
  const history=useHistoryJournal();
  const humanHistory=useHumanHistory(history);
  useEffect(()=>{void history.read();},[history.read]);
  const api=<T,>(url:string,body?:unknown)=>requestApi<T>(request,url,body);
  const statusPreferences=useStatusPreferences();
  const plugins=usePlugins();
  const statusPlugins=plugins.catalog?.plugins.filter(plugin=>plugin.enabled);
  const switching=useRef(false),structuring=useRef(false);

  const workbenchRef = useRef<HTMLDivElement>(null);
  const appearanceSettings=useAppearance();
  const annotationPreferences=useAnnotationPreferences();
  const panelIconDragPreferences=usePanelIconDragPreferences();
  const aiButtonLayout=useAIButtonLayout();
  const aiResponsePreferences=useAIResponsePreferences();
  const workspace = usePanelWorkspace(workbenchRef, id => {if(sessions.current.has(id))activateEditor(id);},28*appearanceSettings.appearance.uiScale/100,appearanceSettings.appearance.panelLockGesture,initialPlacement);
  const [initialSessions]=useState(()=>new Map<string,EditorSession>(
    [...new Set([PRIMARY_EDITOR,...(initialPlacement?.layout.open??[]),...(initialPlacement?.layout.minimized??[])])]
      .filter(isEditorPanel)
      .map(id=>[id,{id,disk:null,state:null,view:null,dirty:false,landing:true}]),
  ));
  const sessions = useRef(initialSessions);
  const [recentOpen,setRecentOpen]=useState(false),[newNoteBusy,setNewNoteBusy]=useState(false),[renameRequest,setRenameRequest]=useState<{path:string;key:string}>();
  const creatingNote=useRef(false);
  const activeSession = useRef(initialPlacement?.activeEditor??PRIMARY_EDITOR), syncingSessions = useRef(false);
  useLayoutEffect(()=>{
    capturePlacement.current=()=>{
      const placement=workspace.capturePlacement();
      const layout=omitWorkspacePanels(placement.layout,id=>id!=='repositories'&&!id.startsWith(trashPreviewTabPrefix)&&!sessions.current.get(id)?.external);
      const openEditors=layout.open.filter(isEditorPanel);
      const primaryTab=findPanelGroup(layout.tree,PRIMARY_EDITOR)?.active??PRIMARY_EDITOR;
      const activeEditor=[activeSession.current,primaryTab].find(id=>openEditors.includes(id))??openEditors[0]??PRIMARY_EDITOR;
      // The repository owns the sessions. A retained editor slot starts on a blank landing page.
      return {...placement,layout,activeEditor};
    };
  });
  const active = useMemo(() => activeEditor(sessions, activeSession), [sessions, activeSession]);
  const {view, disk, editorState} = active;
  const activeEditorId = activeSession.current;
  const currentSession = active.session;
  const file = currentSession?.imagePath || currentSession?.disk?.path || "";
  const dirty = currentSession?.dirty ?? false;
  const sessionCallbacks = useRef({update: (_id: string, _update: ViewUpdate) => {}, ready: (_id: string, _view: EditorView | null) => {},prepareScratch:null as (()=>Promise<boolean>)|null});
  const sessionBindings = useRef(new Map<string, {onUpdate:(update:ViewUpdate)=>void;onReady:(view:EditorView|null)=>void}>());
  const sessionScrollBindings=useRef(new Map<string,()=>void>());
  function bindings(id: string) {
    if (!sessionBindings.current.has(id)) sessionBindings.current.set(id, {onUpdate: update => sessionCallbacks.current.update(id, update), onReady: view => sessionCallbacks.current.ready(id, view)});
    return sessionBindings.current.get(id)!;
  }
  const editorIds = [...sessions.current.keys()];
  const canDetachDocumentTab=desktopPanels.enabled&&editorIds.filter(id=>workspace.isOpen(id)).length>=2;
  function panelLabel(id:string) {
    const session=sessions.current.get(id);
    if(session?.trashPreview)return '回收站 · '+(session.trashPreview.path.split('/').at(-1)||session.trashPreview.path);
    if(session)return session.landing?'新标签页':(session.imagePath||session.disk?.path||session.external?.disk.path)?.split('/').at(-1)||'未命名稿';
    return ({files:'文档','quick-open':'快速打开文档',repositories:'仓库管理',conversation:'对话',outline:'大纲',toc:'标题目录',scratch:'草稿',annotations:'标注',basis:'依据',search:'查找替换',trash:'回收站',properties:'笔记属性'} as Record<string,string>)[id]||id;
  }
  const leftPanel = workspace.panel("files"), rightPanel = workspace.panel("conversation");
  const conversationHasNativeTabs = (desktopPanels.paneMembers('conversation')?.length ?? 0) > 1;
  const leftOpen = workspace.isOpen("files"), chatOpen = workspace.isOpen("conversation");
  const [focusFileSearch,setFocusFileSearch]=useState(false);
  useEffect(()=>{
    if(!focusFileSearch)return;
    const control=leftPanel.ref.current?.querySelector<HTMLInputElement|HTMLButtonElement>('input[aria-label="筛选文件"],button[aria-label="查找文件"]');
    if(!control?.isConnected||control.disabled||!control.getClientRects().length)return;
    if(control.ownerDocument!==document)desktopPanels.focus('files');
    if(control.tagName==='BUTTON')control.click();else control.focus({preventScroll:true});
    setFocusFileSearch(false);
  });
  const scratchView = useRef<EditorView | null>(null),
    activeTextSource = useRef<AnnotationSource>("document"),
    orbBounds = useRef({ width: 344, height: 520 });
  const searchInScratch=activeTextSource.current==='scratch';
  const searchEditor=searchInScratch?scratchView.current:view.current;
  const propertyTargetAvailable=useRef(false);
  const orbPosition = useRef<{ x: number; y: number } | undefined>(undefined);
  const proposal = useRef<Proposal | null>(null),
    undo = useRef<UndoEdit[]>([]),
    requestAnchor = useRef<Anchor | null>(null);
  const controller = useRef<AbortController | null>(null),
    generation = useRef(0),
    running = useRef(false);
  const writingOrigin=useRef<WritingRequestOrigin|null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null),
    importRef = useRef<HTMLInputElement>(null),
    messagesEnd = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<Entry[]>([]),
    [root, setRoot] = useState(""),
    [tick, setTick] = useState(0);
  const quickOpen=useQuickOpen(fileWorkspace.info.id,entries);
  const [quickOpenError,setQuickOpenError]=useState('');
  useEffect(()=>{if(file)rememberRecentDocument(fileWorkspace.info.id,file);},[fileWorkspace.info.id,file]);
  const [scratchReady, setScratchReady] = useState(0);
  const [chatTab, setChatTab] = useState<"conversation" | "annotations">(
      "conversation",
    ),
    [annotationInstruction, setAnnotationInstruction] = useState(""),
    [annotationFocus, setAnnotationFocus] = useState<{id:string;nonce:number}|null>(null),
    [annotationBatch, setAnnotationBatch] = useState<ChatAnnotationBatch|null>(null),
    [annotationLocation, setAnnotationLocation] = useState<{snapshot:SubmittedAnnotation;tabId?:string}|null>(null),
    [chatOrb, setChatOrb] = useState(false);
  const [outline, setOutline] = useState<ReturnType<typeof headings>>([]),
    [selection, setSelection] = useState({ from: 0, to: 0, text: "" }),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState(""),[trashRevision,setTrashRevision]=useState(0);
  const [writingNodeId, setWritingNodeId] = useState<string | null>(null),
    [inlineRequest, setInlineRequest] =
      useState<InlineAnnotationRequest | null>(null);
  const [annotationTool,setAnnotationTool] = useState(false);
  useWindowAnnotationGesture(desktopPanels.windows,(id):WindowMark=>{
    const mark={id,workspaceId:fileWorkspace.info.id};
    const session=sessions.current.get(activeEditorId);
    if(!isNoteTool(id)||!session?.disk?.path||session.landing||activeSession.current!==activeEditorId)return mark;
    if(id==='search'&&(searchInScratch||!searchEditor||session.view!==searchEditor))return mark;
    if(id==='properties'&&(searchInScratch||!propertyTargetAvailable.current))return mark;
    if(id==='outline'&&!/\.md$/i.test(session.disk.path))return mark;
    return {...mark,document:{sessionId:activeEditorId,file:session.disk.path}};
  },{enabled:annotationTool,has:isMarkdownTab,stage:stageDocumentTab,canMarkWindow:isWindowTool,labelForWindow:panelLabel,stageWorkspaceTarget});
  // Several panels in the same native group share its document and annotation UI.
  const annotationOwners=new Map<string,Document>([['',document]]);
  for(const [id,popup] of desktopPanels.windows)annotationOwners.set(desktopPanels.owner(id),popup.document);
  const [historyOpen,setHistoryOpen]=useState(false),[historyBusy,setHistoryBusy]=useState(false),[historyError,setHistoryError]=useState('');
  const [historyLaunch,setHistoryLaunch]=useState<{tab:HistoryTab;version:number}>({tab:'snapshot',version:0});
  const [historyConflict,setHistoryConflict]=useState<HistoryPageProps['conflict']>();
  const historyRunning=useRef(false);
  const [trashDeleteRequest,setTrashDeleteRequest]=useState<import('../features/files/TrashPanel').TrashConfirmationRequest|null>(null);
  const trashDocumentReads=useRef(new Map<string,AbortController>());
  useEffect(()=>()=>{for(const controller of trashDocumentReads.current.values())controller.abort();},[]);
  const [repositoryFollowUp,setRepositoryFollowUp]=useState<{mark:WindowMark;name:string}|null>(null);
  const dismissInlineRequest = useCallback((request: InlineAnnotationRequest) => {
    setInlineRequest(current => current?.nonce === request.nonce ? null : current);
  }, []);
  const [conversationId,setConversationId]=useState<string>(uid);
  const [chatManagerOpen,setChatManagerOpen]=useState(false);
  const [conversations,setConversations]=useState(()=>[newConversation(conversationId,'对话 1')]);
  const conversation=conversations.find(chat=>chat.id===conversationId)!;
  const {draft,messages,lastRequest}=conversation, prompt=draft.text;
  const hasUnsentDraft=conversations.some(chat=>hasChatDraft(chat.draft)||chat.parked.some(hasChatDraft));
  const unsentDraft=useRef(hasUnsentDraft);unsentDraft.current=hasUnsentDraft;
  const updateChat=(id:string,update:(chat:Conversation)=>Conversation)=>setConversations(chats=>chats.map(chat=>chat.id===id?update(chat):chat));
  const updateConversation=(update:(chat:Conversation)=>Conversation)=>updateChat(conversationId,update);
  const setPrompt=chatPromptSetter(updateConversation);
  const [mode,setMode]=useState<Mode>('discuss');
  const [activeRun,setActiveRun]=useState<{chatId:string;target:ChatTarget;cancellable:boolean}|null>(null);
  const busy=!!activeRun, chatBusy=activeRun?.chatId===conversationId;
  const [stream,setStream]=useState<{text:string;documentFile?:string}|null>(null);
  const physicalToolMarks=marks.filter(mark=>isWindowTool(mark.id));
  const draftMark=draft.route?.kind==='window'?draft.route.mark:undefined;
  const toolMarks=draftMark?[draftMark,...physicalToolMarks.filter(mark=>mark.id!==draftMark.id)]:physicalToolMarks;
  const chatTarget=targetForChat();
  const displayedTarget=chatBusy?activeRun.target:chatTarget;
  const currentMode=useRef(mode),viewApplying=useRef(false),appAlive=useRef(true);currentMode.current=mode;
  useEffect(()=>{appAlive.current=true;return()=>{appAlive.current=false;};},[]);
  useEffect(()=>fileWorkspace.register(async()=>{humanHistory.flushAll();await history.wait();}),[fileWorkspace]);
  const [config, setConfig] = useState<Config>(initialConfig),
    [settings, setSettings] = useState(false),
    [settingsSection, setSettingsSection] = useState<SettingsSection>('models'),
    [settingsRestoreKey, setSettingsRestoreKey] = useState(0),
    [configBusy, setConfigBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null),
    [error, setErrorToast] = useState<{message:string;persistent:boolean} | null>(null),
    [notice, setNotice] = useState(""),
    [help, setHelp] = useState(false);
  const setError=useCallback((message:string,persistent=false)=>setErrorToast(message?{message,persistent}:null),[]);
  const [fileActivity, setFileActivity] = useState<'idle'|'opening'|'busy'>('idle'),
    [confirm, setConfirm] = useState<{
      text: string;
      action: () => void;
    } | null>(null);
  const fileBusy=fileActivity!=='idle';
  const setFileBusy=(busy:boolean,openingFile:boolean)=>setFileActivity(busy?(openingFile?'opening':'busy'):'idle');
  const references=useReferenceSources(fileWorkspace.info.id,file||'@'+activeEditorId);
  const reasoning=useModelReasoning(!config.demo?config.selection:null,!config.demo?selectedModelEntry(config):undefined);
  function addReference(source:WorkspaceReferenceSource,openBasis=true){
    void addReferenceBatch([source],openBasis).then(([result])=>{
      if(!result.ok)setError(result.path+'：'+result.error);
      else if(!openBasis)inform(result.warning||'已将 1 项加入参考资料。');
    }).catch(error=>setError((error as Error).message));
  }
  const annotations = useTextAnnotations(
    file,
    view,
    scratchView,
    scratchReady,
    setError,
  );
  const {markText,showLocalAnnotation,unmarkText,locateAnnotation,reanchorAnnotation,sendAnnotations,cancelAnnotations}=useAnnotationActions({
    annotations,view,scratchView,activeTextSource,disk,file,activeSession,workspace,chooseSidebar,setError,setInlineRequest,setAnnotationFocus:id=>setAnnotationFocus({id,nonce:Date.now()}),generate,openChat,annotationInstruction,
    onCancelAnnotations:ids=>{
      if(writingOrigin.current?.annotationIds.some(id=>ids.includes(id)))stop();
      let cleared=false;
      for(const session of sessions.current.values()){
        const candidate=proposalFor(session.id);
        if(candidate?.placement!=='comparison'||!candidate.annotationIds?.some(id=>ids.includes(id)))continue;
        if(session.id===activeSession.current)proposal.current=null;
        else if(session.context)session.context.proposal=null;
        cleared=true;
      }
      if(cleared)redraw();
    },
  });
  const writingOutline = useWritingNodes(/\.md$/i.test(file)?file:'', view, setError);
  const redraw = () => setTick((t) => t + 1);
  const {captureView,applyView}=useViewSnapshots({
    workspace,sessions,activeSession,bindings,activateEditor,api,
    appearance:appearanceSettings,statusPreferences,mode,currentMode,appAlive,viewApplying,running,switching,
    fileBusy,filter,setFilter,collapsed,setCollapsed,chatOrb,setChatOrb,orbPosition,orbBounds,redraw,
  });
  const chrome:PanelChrome={workspace,sessions,editorIds,panelLabel,closeEditor,minimizeEditor,activateEditor,redraw,activeTextSource,ribbonCommand};
  const inform = (text: string) => {
    setNotice(text);
  };
  const add = (role: Message["role"], content: string, details?: ChatMessageDetails) => {
    const message={id:uid(),role,content,...details};
    updateConversation(chat=>({...chat,messages:[...chat.messages,message]}));
  };
  function addTurnMessage(turnId:string,role:Message['role'],content:string,details:ChatMessageDetails,sent?:ChatDraft,retryTurnId?:string){
    const message:Message={id:uid(),role,content,...details,turnId,draft:sent};
    updateConversation(chat=>({...chat,messages:[...withoutRetriedPrompt(chat.messages,retryTurnId),message]}));
  }
  const setLastRequest=(request:InputBasisRequest)=>updateConversation(chat=>({...chat,lastRequest:request}));
  const endChatRun=()=>setActiveRun(null);
  const showStream = (text:string,documentFile?:string) => setStream(text?{text,documentFile}:null);
  const dialogRef=useRef(dialog);dialogRef.current=dialog;
  function handleStoredChange(id:string,transaction:Transaction,mapAnnotations=true){
    const path=sessions.current.get(id)?.disk?.path;if(path&&mapAnnotations)annotations.mapStoredDocument(path,transaction);
    if(activeSession.current!==id)return;
    const derived=applyStoredDocumentChange({proposal,requestAnchor,undo},transaction);
    if(derived){setOutline(derived.outline);setSelection(derived.selection);}
  }
  function applyNoteTransaction(session:EditorSession,transaction:Transaction){
    if(session.view){session.view.dispatch(transaction);return;}
    function applyStored(owner:EditorSession,change:Transaction,updateMarks:boolean){
      owner.state=change.state;
      owner.dirty=!documentMatchesText(change.state.doc,owner.disk?.text||'');
      owner.contentVersion=(owner.contentVersion||0)+1;
      if(owner.disk?.path)humanHistory.track(owner.id,owner.disk.path,change);
      mapStoredSessionContext(owner.context,change);
      handleStoredChange(owner.id,change,updateMarks);
    }
    applyStored(session,transaction,true);
    syncingSessions.current=true;
    try{
      for(const other of sessions.current.values()){
        if(other===session||other.disk?.path!==session.disk?.path||!other.state?.doc.eq(transaction.startState.doc))continue;
        const effect={changes:transaction.changes,userEvent:'input.shared-document'};
        if(other.view)other.view.dispatch(effect);
        else applyStored(other,other.state.update(effect),false);
      }
    }finally{syncingSessions.current=false;}
    redraw();
  }
  function recordHistory(record:Omit<HistoryRecord,'id'|'createdAt'|'status'>){
    const id=uid();
    void history.append({...record,id,createdAt:new Date().toISOString(),status:'applied'}).catch(error=>{
      if(appAlive.current)setError('操作已完成，历史记录保存失败：'+(error as Error).message);
    });
    return id;
  }
  // 建议只是正文里的预览，落盘时机必须由用户自己决定：有未确认的建议就不存盘。
  const proposalFor = useCallback((id: string) => id === activeSession.current ? proposal.current : sessions.current.get(id)?.context?.proposal ?? null, []);
  const pendingProposal = useCallback((id: string) => {
    if(proposalFor(id))return true;
    const path=sessions.current.get(id)?.disk?.path;
    return !!path&&[...sessions.current.values()].some(session=>session.disk?.path===path&&proposalFor(session.id));
  }, [proposalFor]);
  const reviewTarget=useRef<string|null>(null);
  function revealProposal(id:string,editor:EditorView){
    const pending=proposalFor(id);
    if(!pending)return;
    const position=Math.max(0,Math.min(pending.from,editor.state.doc.length));
    editor.dispatch({effects:EditorView.scrollIntoView(position,{y:'center'})});
  }
  const {savingPaths,fileConflicts,saveSession,applyDiskFile}=useDocumentPersistence({
    api, appAlive, workspace: fileWorkspace.info, sessions, switching, structuring,
    fileBusy, tick, autoSave: fileWorkspace.info.autoSave, pendingProposal,
    setFileBusy, setEntries, setError, inform, redraw, onStoredChange: handleStoredChange,
  });
  const onUpdate = useCallback((update: ViewUpdate) => {
    annotations.map("document", update);
    if(update.selectionSet&&update.view.hasFocus)activeTextSource.current='document';
    if (update.docChanged) {
      if (proposal.current)
        proposal.current = mapAnchor(proposal.current, update.changes);
      if (requestAnchor.current)
        requestAnchor.current = mapAnchor(
          requestAnchor.current,
          update.changes,
        );
      undo.current = undo.current.map((a) => mapAnchor(a, update.changes));
      setOutline(headings(update.state));
      setTick((t) => t + 1);
    }
    if (update.docChanged || update.selectionSet) {
      if(update.selectionSet&&!update.docChanged)redraw();
      const s = update.state.selection.main;
      setSelection({
        from: s.from,
        to: s.to,
        text: update.state.sliceDoc(s.from, s.to),
      });
    }
  }, []);
  const onScratchEditor = useCallback((editor: EditorView | null,save?:()=>Promise<boolean>) => {
    scratchView.current = editor;
    sessionCallbacks.current.prepareScratch=save||null;
    if (editor) setScratchReady((value) => value + 1);
  }, []);
  const onScratchUpdate = useCallback((update: ViewUpdate) => {
    annotations.map("scratch", update);
    if(update.selectionSet&&update.view.hasFocus)activeTextSource.current='scratch';
    if(update.docChanged||update.selectionSet)redraw();
  }, []);
  function ribbonCommand(command:RibbonCommand,replaceSearch=false){
    if(activeTextSource.current==='document'&&sessions.current.get(activeSession.current)?.trashPreview)return;
    if(command==='properties'){workspace.open('properties');return;}
    const source=activeTextSource.current,editor=source==='scratch'?scratchView.current:view.current;
    if(!editor)return;
    const id=activeSession.current,path=source==='scratch'?'自由草稿.md':sessions.current.get(id)?.disk?.path||'';
    const target:InsertTarget={editor,file:path,valid:()=>source==='scratch'?scratchView.current===editor:sessions.current.get(id)?.view===editor&&(sessions.current.get(id)?.disk?.path||'')===path,...(source==='scratch'?{prepare:async()=>await sessionCallbacks.current.prepareScratch?.()||false}:{})};
    runEditorCommand(command,{target,onDialog:setDialog,onError:setError,openSearch:()=>{workspace.open('search');requestAnimationFrame(()=>{const owner=desktopPanels.windows.get('search')?.document||document;const input=owner.querySelector<HTMLInputElement>(replaceSearch?'[data-replace-input]':'[data-find-input]');input?.focus();input?.select();});}});
  }
  sessionCallbacks.current.ready = (id, next) => {
    const session = sessions.current.get(id)!;
    if (!next && session.view) captureEditorView(session);
    sessionScrollBindings.current.get(id)?.();sessionScrollBindings.current.delete(id);
    session.view = next;
    if(next)session.state=next.state;
    if(next){
      const top=session.restoreScroll,left=session.restoreScrollLeft,target=session.restoreScrollTarget;
      const window=next.dom.ownerDocument.defaultView!;
      if(target?.doc===next.state.doc){
        next.dispatch({effects:target.effect});
        // The layout query flushes CodeMirror's pending scroll measurement before paint.
        next.lineBlockAtHeight(top||0);
      }else if(top||left){
        // View presets store pixel offsets. Measure the new document before applying them.
        next.lineBlockAtHeight(top||0);
        next.scrollDOM.scrollTop=top||0;next.scrollDOM.scrollLeft=left||0;
      }
      const remember=()=>captureEditorView(session);next.scrollDOM.addEventListener('scroll',remember);
      let frame:number|undefined;
      if(reviewTarget.current===id)frame=window.requestAnimationFrame(()=>{
        if(session.view!==next)return;
        if(reviewTarget.current===id){
          reviewTarget.current=null;
          if(activeSession.current===id){revealProposal(id,next);return;}
        }
      });
      sessionScrollBindings.current.set(id,()=>{next.scrollDOM.removeEventListener('scroll',remember);if(frame!==undefined)window.cancelAnimationFrame(frame);});
    }
    if (activeSession.current === id && next && !session.external) {
      annotations.syncEditor("document", next, session.disk?.path);
      setScratchReady(value => value + 1);
    }
  };
  sessionCallbacks.current.update = (id, update) => {
    const session = sessions.current.get(id)!;
    if(update.docChanged&&session.disk?.path&&!syncingSessions.current)
      for(const transaction of update.transactions)humanHistory.track(id,session.disk.path,transaction);
    session.state = update.state;
    if(update.docChanged)session.contentVersion=(session.contentVersion||0)+1;
    if(update.docChanged)session.dirty = !documentMatchesText(update.state.doc,session.external?.disk.text ?? session.disk?.text ?? "");
    if(session.external){if(update.docChanged)redraw();return;}
    if (update.docChanged && !syncingSessions.current && session.disk) {
      syncingSessions.current = true;
      try {
        for (const other of sessions.current.values()) {
          if (other.id === id || other.disk?.path !== session.disk.path || !other.state?.doc.eq(update.startState.doc)) continue;
          if (other.view) other.view.dispatch({changes:update.changes,userEvent:"input.shared-document"});
          else {const transaction=other.state.update({changes:update.changes,userEvent:'input.shared-document'});other.state=transaction.state;other.contentVersion=(other.contentVersion||0)+1;other.dirty=!documentMatchesText(other.state.doc,other.disk.text);mapStoredSessionContext(other.context,transaction);handleStoredChange(other.id,transaction,activeSession.current!==id);}
        }
      } finally { syncingSessions.current = false; }
    }
    if (activeSession.current !== id && update.docChanged && session.context) {
      if (session.context.proposal) session.context.proposal=mapAnchor(session.context.proposal,update.changes);
      session.context.undo=session.context.undo.map(value=>mapAnchor(value,update.changes));
    }
    if (activeSession.current === id) onUpdate(update);
    else if (update.docChanged || update.selectionSet) redraw();
  };
  function activateEditor(id: string) {
    const next=sessions.current.get(id)!;
    if((next.trashPreview||next.external)&&activeTextSource.current!=='document'){activeTextSource.current='document';if(id===activeSession.current)redraw();}
    if (id === activeSession.current) return;
    const previous = sessions.current.get(activeSession.current)!;
    captureEditorView(previous);
    previous.context = {proposal:proposal.current,undo:undo.current,writingNodeId};
    if (requestAnchor.current && running.current) stop();
    activeSession.current=id;
    proposal.current=next.context?.proposal||null; undo.current=next.context?.undo||[];
    setWritingNodeId(next.context?.writingNodeId||null);
    setOutline(next.state&&!next.external?headings(next.state):[]);
    const range=next.external?undefined:next.state?.selection.main;
    setSelection(range&&next.state?{from:range.from,to:range.to,text:next.state.sliceDoc(range.from,range.to)}:{from:0,to:0,text:""});
    setInlineRequest(null);setScratchReady(value=>value+1);setError("");
  }
  function showHistory(tab:HistoryTab='snapshot'){
    if(historyRunning.current)return;
    humanHistory.flushAll();
    setHistoryLaunch(previous=>({tab,version:previous.version+1}));
    if(tab==='ai'&&desktopPanels.windows.has('conversation'))window.hiveDesktop?.windowCommand('focus');
    setHistoryError('');setHistoryOpen(true);void history.read();
  }
  function runChatAction(id:AIButtonId){
    if(id==='sessions')setChatManagerOpen(open=>!open);
    else if(id==='references')workspace.reveal('basis');
    else showHistory('ai');
  }
  function chatActions(region:AIButtonRegion){
    return <ChatActionStrip region={region} items={aiButtonLayout.layout[region]}
      sessionsOpen={chatManagerOpen} sessionLabel={conversation.label} onAction={runChatAction}/>;
  }
  function closeHistory(){if(!historyRunning.current){setHistoryConflict(undefined);setHistoryOpen(false);}}
  async function historyTask(run:()=>Promise<void>){
    if(historyRunning.current)return;
    historyRunning.current=true;setHistoryBusy(true);setHistoryError('');
    try{await run();}
    catch(error){if(appAlive.current)setHistoryError((error as Error).message);}
    finally{historyRunning.current=false;if(appAlive.current)setHistoryBusy(false);}
  }
  function hasOtherHistoryProposal(session:EditorSession,permit?:(proposal:Proposal)=>boolean){
    const path=session.disk?.path;
    return [...sessions.current.values()].some(candidate=>{
      if(candidate.disk?.path!==path)return false;
      const pending=proposalFor(candidate.id);
      return !!pending&&(candidate!==session||!permit?.(pending));
    });
  }
  function historyTarget(path:string,permit?:(proposal:Proposal)=>boolean){
    const open=[...sessions.current.values()].filter(session=>session.disk?.path===path&&workspace.isOpen(session.id));
    const owner=open.find(session=>{const pending=proposalFor(session.id);return pending&&permit?.(pending);});
    const session=owner||open.find(session=>session.id===activeSession.current)||open[0];
    const state=session?.view?.state||session?.state;
    if(!session||!state)throw new Error('请先打开对应笔记。');
    if(hasOtherHistoryProposal(session,permit))throw new Error('这篇笔记还有未确认的建议，请先审阅。');
    if(savingPaths.current.has(path)||fileConflicts[path])throw new Error('请先完成保存，或处理这篇笔记的磁盘冲突。');
    return {session,state};
  }
  async function findHistoryTarget(path:string,permit?:(proposal:Proposal)=>boolean){
    if(permit){
      const owner=[...sessions.current.values()].find(session=>{
        const pending=session.disk?.path===path&&proposalFor(session.id);
        return pending&&permit(pending);
      });
      if(owner&&!workspace.isOpen(owner.id)&&workspace.openDocumentTab(owner.id)!=='succeeded')throw new Error('无法打开历史记录对应的建议标签页。');
    }
    if(![...sessions.current.values()].some(session=>session.disk?.path===path&&workspace.isOpen(session.id)))
      await openExplorerFile(path,true);
    return historyTarget(path,permit);
  }
  function verifyHistoryTarget(session:EditorSession,state:EditorState,permit?:(proposal:Proposal)=>boolean){
    if(!appAlive.current||sessions.current.get(session.id)!==session||!workspace.isOpen(session.id)||
      (session.view?.state||session.state)?.doc!==state.doc||hasOtherHistoryProposal(session,permit))
      throw new Error('等待期间笔记或建议已变化，请重新核对历史记录。');
    const path=session.disk?.path;
    if(path&&(savingPaths.current.has(path)||fileConflicts[path]))throw new Error('请先完成保存，或处理这篇笔记的磁盘冲突。');
  }
  async function saveHistoryOutline(actor:HistoryActor,nodes:WritingNode[]){
    const before=await writingOutline.readFor(file);
    const after=await writingOutline.save(nodes);
    if(JSON.stringify(before.nodes)!==JSON.stringify(after.nodes))recordHistory({actor,file,kind:'outline',label:'修改写作大纲',changes:{outline:{before,after}}});
  }
  async function createNoteSnapshot(session:EditorSession,state:EditorState,actor:HistoryActor){
    const path=session.disk?.path;
    if(!path)throw new Error('请先打开要创建快照的笔记。');
    const outline=await writingOutline.readFor(path);
    verifyHistoryTarget(session,state);
    if(session.disk?.path!==path)throw new Error('等待期间笔记路径已变化，请重试。');
    await history.saveSnapshot({id:uid(),file:path,actor,createdAt:new Date().toISOString(),label:actor==='ai'?'AI 创建的快照':'人工创建的快照',text:state.doc.toString(),outline});
  }
  async function restoreNoteSnapshot(id:string){
    const snapshot=await history.snapshot(id);
    const {session,state}=historyTarget(snapshot.file);
    const currentOutline=await writingOutline.readFor(snapshot.file);
    verifyHistoryTarget(session,state);
    if(state.readOnly)throw new Error('当前正文只读，请切换到可编辑的显示模式。');
    const sameOutline=JSON.stringify(currentOutline.nodes)===JSON.stringify(snapshot.outline.nodes);
    const after=sameOutline?currentOutline:await writingOutline.saveFor(snapshot.file,snapshot.outline.nodes,currentOutline.revision);
    const edit=minimalReplacement({from:0,to:state.doc.length,original:state.doc.toString(),file:snapshot.file,stale:false},snapshot.text);
    const latest=session.view?.state||session.state;
    let change:Transaction|undefined;
    try{
      verifyHistoryTarget(session,state);
      if(session.disk?.path!==snapshot.file||latest?.readOnly)throw new Error('等待期间笔记或编辑状态已变化。');
      if(snapshot.text!==state.doc.toString()){
        change=latest!.update({changes:{from:edit.from,to:edit.to,insert:edit.text},userEvent:'input.history.snapshot',annotations:Transaction.addToHistory.of(false)});
        applyNoteTransaction(session,change);
      }
    }catch(error){
      if(!sameOutline)await writingOutline.saveFor(snapshot.file,currentOutline.nodes,after.revision);
      throw error;
    }
    if(change||!sameOutline)recordHistory({actor:'human',file:snapshot.file,kind:'snapshot-restore',label:'还原文件快照',changes:{
      ...(change?{text:historyTextChanges(change)}:{}),...(!sameOutline?{outline:{before:currentOutline,after}}:{}),
    }});
  }
  function outlineHistoryText(outline:HistoryOutline){
    return outline.nodes.map(node=>'#'.repeat(node.level)+' '+node.title+(node.description?'\n'+node.description:'')).join('\n');
  }
  async function replayFileHistory(record:HistoryRecord,reverse:boolean){
    const change=record.changes.file;
    if(!change)throw new Error('这项操作没有可恢复的文件。');
    let action:FileAction;
    if(['create','duplicate','restore','trash'].includes(change.action)){
      const restore=change.action==='trash'?reverse:!reverse;
      if(restore&&!change.id)throw new Error('这次操作的回收站条目已不存在。');
      action=restore?{action:'restore',id:change.id}:{action:'trash',path:change.path};
    }else if((change.action==='move'||change.action==='rename')&&change.from){
      const path=reverse?change.path:change.from,to=reverse?change.from:change.path;
      action=change.action==='move'?{action:'move',path,parent:to.split('/').slice(0,-1).join('/')}:{action:'rename',path,name:to.split('/').at(-1)};
    }else throw new Error('这项操作没有可恢复的内容。');
    const next=reverse?'reverted':'applied';
    await history.setStatus(record.id,next,record.status);
    let result:Awaited<ReturnType<typeof manageFile>>;
    try{result=await manageFile(action,{quiet:true,actor:null});}
    catch(error){await history.setStatus(record.id,record.status,next);throw error;}
    if(result.id)await history.setStatus(record.id,next,next,false,result.id);
    if(action.action==='restore')setTrashRevision(value=>value+1);
  }
  async function replayHistory(actor:HistoryActor,id:string,reverse:boolean){
    const record=await history.entry(id);
    const expected=reverse?'applied':'reverted',next=reverse?'reverted':'applied';
    if(record.actor!==actor||record.status!==expected)throw new Error('操作历史状态已变化，请刷新后重试。');
    if(record.kind==='file'){await replayFileHistory(record,reverse);return;}
    if(!record.file||(!record.changes.text&&!record.changes.outline))throw new Error('这项操作没有可恢复的内容。');
    const canRedoPolish=(candidate:Proposal)=>!reverse&&candidate.placement==='comparison'&&candidate.historyId===record.id&&
      candidate.text===record.changes.text?.[0]?.after&&!candidate.refinementNote?.trim();
    const {session,state}=await findHistoryTarget(record.file,canRedoPolish);
    if(record.changes.text&&state.readOnly)throw new Error('当前正文只读，请切换到可编辑的显示模式。');
    if(actor==='human'&&record.changes.text&&!record.changes.outline&&humanHistory.group(session.id,reverse)===id){
      const command=reverse?undoDocument:redoDocument;
      if(!command({state,dispatch:transaction=>applyNoteTransaction(session,transaction)}))throw new Error('当前正文无法执行这项撤销或重做。');
      await history.wait();
      return;
    }
    const path=record.file;
    const textPlan=record.changes.text?planHistoryText(state.doc,record.changes.text,reverse):null;
    const sections:HistorySection[]=[...(textPlan?.conflicts||[])];
    const outlineChange=record.changes.outline;
    const currentOutline=outlineChange?await writingOutline.readFor(path):null;
    const nextOutline=outlineChange?(reverse?outlineChange.before:outlineChange.after):null;
    if(outlineChange&&currentOutline&&nextOutline){
      const expectOutline=reverse?outlineChange.after:outlineChange.before;
      if(JSON.stringify(currentOutline.nodes)!==JSON.stringify(expectOutline.nodes))
        sections.push({title:'写作大纲',before:outlineHistoryText(currentOutline),after:outlineHistoryText(nextOutline)});
    }
    const apply=async()=>{
      verifyHistoryTarget(session,state,canRedoPolish);
      if(session.disk?.path!==path)throw new Error('历史记录对应的笔记路径已变化。');
      await history.setStatus(id,next,expected);
      let committedOutline:HistoryOutline|undefined;
      try{
        if(currentOutline&&nextOutline)committedOutline=await writingOutline.saveFor(path,nextOutline.nodes,currentOutline.revision);
        verifyHistoryTarget(session,state,canRedoPolish);
        const latest=session.view?.state||session.state;
        if(session.disk?.path!==path||!latest||textPlan&&latest.readOnly)throw new Error('等待期间笔记或编辑状态已变化。');
        if(textPlan){
          const prior=proposalFor(session.id),redoing=prior&&canRedoPolish(prior);
          applyNoteTransaction(session,latest.update({changes:textPlan.changes,userEvent:'input.history.replay',annotations:Transaction.addToHistory.of(false)}));
          const reopened=replayPolishProposal(record,textPlan,reverse);
          if(reopened||redoing){
            const activeOwner=activeSession.current===session.id;
            const edits=(activeOwner?undo.current:session.context?.undo??[]).filter(edit=>edit.historyId!==id);
            if(activeOwner){proposal.current=reopened;undo.current=edits;}
            else session.context={writingNodeId:null,...session.context,proposal:reopened,undo:edits};
            redraw();
          }
        }
      }catch(error){
        try{if(committedOutline&&currentOutline)await writingOutline.saveFor(path,currentOutline.nodes,committedOutline.revision);}
        finally{await history.setStatus(id,expected,next);}
        throw error;
      }
      setHistoryConflict(undefined);
    };
    if(sections.length)setHistoryConflict({title:reverse?'撤回前核对冲突':'重新应用前核对冲突',sections,
      onCancel:()=>setHistoryConflict(undefined),onConfirm:()=>void historyTask(apply)});
    else await apply();
  }
  function closeEditor(id: string) {
    if(!desktopPanels.attach(id))return false;
    const session=sessions.current.get(id);if(session){captureEditorView(session);session.contentVersion=(session.contentVersion||0)+1;}
    if(workspace.close(id)!=='succeeded')return false;
    if(activeSession.current===id)workspace.open(editorIds.find(value=>value!==id&&workspace.isOpen(value))||'editor');
    return true;
  }
  function minimizeEditor(id:string) {
    if(!desktopPanels.attach(id))return;
    const session=sessions.current.get(id);if(session){captureEditorView(session);session.contentVersion=(session.contentVersion||0)+1;}
    workspace.minimize(id);
    if(activeSession.current===id){const next=editorIds.find(value=>value!==id&&workspace.isOpen(value));if(next)workspace.open(next);}
  }

  function finalizeTrashedSessions(affected:EditorSession[], safe:(session:EditorSession)=>boolean) {
    const disposable=affected.filter(session=>safe(session)&&!session.view?.composing&&!desktopPanels.isComposing()), kept=affected.filter(session=>!disposable.includes(session));
    const closing=new Set(disposable.map(session=>session.id));
    if(closing.has(activeSession.current)){
      const next=[...sessions.current.keys()].find(id=>!closing.has(id)&&workspace.isOpen(id)) || 'editor';
      if(next!==activeSession.current&&sessions.current.has(next)){workspace.open(next);activateEditor(next);}
    }
    let retained=0;
    for(const session of kept){
      if(retireDeletedImage(session))continue;
      retained++;
      session.disk=null;session.dirty=true;
    }
    for(const session of disposable){
      // A native host can refuse to return its editor (for example during IME
      // composition). Keep that live editor rather than discarding its state.
      if(session.id!=='editor'&&!closeEditor(session.id)){
        if(retireDeletedImage(session))continue;
        session.disk=null;session.dirty=true;retained++;
        continue;
      }
      session.contentVersion=(session.contentVersion||0)+1;
      session.imagePath=undefined;session.disk=null;session.state=null;session.view=null;session.dirty=false;session.landing=true;
      session.context=undefined;session.restoreScroll=undefined;session.restoreScrollLeft=undefined;session.restoreScrollTarget=undefined;
      if(activeSession.current===session.id){
        proposal.current=null;undo.current=[];
        setWritingNodeId(null);
        setOutline([]);setSelection({from:0,to:0,text:''});setInlineRequest(null);
      }
    }
    redraw();
    return retained;
  }

  const { refresh, openFile, safeSwitch, openSaveAs, save, openBlankTab, createQuickNote, openExplorerFile, openDocumentPath, manageFile, preflightFileActions, reloadFromDisk, switchWorkspace, removeRepository, submitDialog, importFile } = useFileActions({
    api, appAlive, promptRef, hasUnsentChatDraft:()=>unsentDraft.current, dialogRef, uid, workspace, sessions, activeSession, activeTextSource,
    proposal, undo, prompt, dialog, running, requestAnchor, structuring, switching, viewApplying,
    creatingNote, savingPaths, fileWorkspace, saveSession, finalizeTrashedSessions, applyDiskFile,
    onApplied:(action,result,actor)=>{
      if(result.type==='folder'){
        if((action.action==='rename'||action.action==='move')&&result.from)quickOpen.updatePath(result.from,result.path);
        if(action.action==='trash')quickOpen.updatePath(result.path);
      }
      const label=({create:'创建文件或文件夹',trash:'移入回收站',restore:'从回收站恢复',rename:'重命名',move:'移动',duplicate:'复制'} as Record<string,string>)[action.action];
      if(label&&result.path&&(action.action!=='rename'&&action.action!=='move'||result.from))recordHistory({actor,kind:'file',file:result.path,label,
        changes:{file:{action:action.action,path:result.path,id:result.id||action.id,from:result.from}}});
    },
    annotations, references, bindings, stop, redraw, inform, setError, setFileBusy, setNewNoteBusy,
    setEntries, setRoot, setConfirm, setDialog, setFilter, setRenameRequest, setCollapsed,
    setTrashRevision, setInlineRequest, setOutline, setSelection, setWritingNodeId,
  });
  async function openAndCount(path:string,newTab=false,reuseExisting=false){
    await openExplorerFile(path,newTab,reuseExisting);
    if(appAlive.current&&!switching.current&&[...sessions.current.values()].some(session=>session.disk?.path===path))quickOpen.visit(parentPath(path));
  }
  async function openTrashedDocument(item:TrashRecord){
    const unavailable=()=>structuring.current||switching.current||viewApplying.current||!!requestAnchor.current&&running.current;
    const checkRoom=()=>{
      if(workspace.capture().open.filter(id=>sessions.current.has(id)).length>=48)throw new Error('打开的文档标签已达 48 个，请先关闭不再使用的标签页。');
    };
    if(unavailable())throw new Error('请等待当前文稿操作完成，再打开回收站预览。');
    if(trashDocumentReads.current.has(item.id))return;
    const existing=[...sessions.current.values()].find(session=>session.trashPreview?.id===item.id&&workspace.isOpen(session.id));
    if(existing){workspace.reveal(existing.id);return;}
    checkRoom();
    const controller=new AbortController();
    trashDocumentReads.current.set(item.id,controller);
    try{
      const preview=await loadTrashDocument(request,item.id,controller.signal);
      if(controller.signal.aborted||!appAlive.current||switching.current)return;
      if(unavailable())throw new Error('当前文稿状态已变化，请重新打开回收站预览。');
      checkRoom();
      const id=trashPreviewTabPrefix+uid();
      sessions.current.set(id,{id,disk:null,state:null,view:null,dirty:false,trashPreview:preview});
      if(workspace.openDocumentTab(id,activeSession.current)!=='succeeded'){
        sessions.current.delete(id);
        throw new Error('无法打开回收站文稿，请完成当前窗口操作后重试。');
      }
      redraw();
    }finally{trashDocumentReads.current.delete(item.id);}
  }
  function openDocumentList() {
    workspace.open('files');
    setFocusFileSearch(true);
  }
  function exportMarkdown() {
    const session=sessions.current.get(activeSession.current),state=session?.view?.state||session?.state;
    if(!state||proposal.current||fileBusy)return;
    if(desktopPanels.isComposing()) {setError('请先完成当前输入法组词，再导出文档。');return;}
    const format=session?.disk;
    const text=state.doc.toString();
    const contents=(format?.bom?'\uFEFF':'')+(format?.eol==='CRLF'?text.replace(/\r?\n/g,'\r\n'):text);
    const url=URL.createObjectURL(new Blob([contents],{type:'text/markdown;charset=utf-8'}));
    const link=document.createElement('a');
    link.href=url;
    link.download=((format?.path.split('/').at(-1)||'未命名').replace(/\.md$/i,''))+'-副本.md';
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  const recentEntries=useMemo(()=>{
    if(!recentOpen)return [];
    const files=new Map(flattenEntries(entries).filter(entry=>entry.type==='file').map(entry=>[entry.path,entry]));
    return readRecentDocuments(fileWorkspace.info.id).flatMap(path=>{
      const entry=files.get(path);
      return entry?[entry]:[];
    });
  },[entries,fileWorkspace.info.id,recentOpen]);
  async function openRecentDocument(path:string) {
    const existing=[...sessions.current.values()].find(session=>(session.imagePath||session.disk?.path)===path&&workspace.isOpen(session.id));
    if(existing)workspace.open(existing.id);
    else await openExplorerFile(path,!sessions.current.get(activeSession.current)?.landing);
    const id=activeSession.current;
    requestAnimationFrame(()=>{if(activeSession.current===id)sessions.current.get(id)?.view?.focus();});
  }
  function referenceTarget(){
    const owner=activeSession.current,session=sessions.current.get(owner),ownerPath=session?.disk?.path;
    const original={doc:(session?.view?.state||session?.state)?.doc,version:session?.contentVersion||0,proposal:proposal.current,prompt:promptRef.current?.value??prompt};
    return ()=>{
      if(appAlive.current===false||activeSession.current!==owner||sessions.current.get(owner)!==session||session?.disk?.path!==ownerPath||
        (session?.view?.state||session?.state)?.doc!==original.doc||(session?.contentVersion||0)!==original.version||proposal.current!==original.proposal||(promptRef.current?.value??prompt)!==original.prompt)
        throw new Error('依据目标正文或会话已变化，请在当前正文中重新添加。');
      if(running.current||structuring.current||switching.current||viewApplying.current||savingPaths.current.size)
        throw new Error('AI 或文件操作正在进行，请结束后再添加依据。');
    };
  }
  async function addReferenceBatch(sources:WorkspaceReferenceSource[],openBasis=true,requireTarget=referenceTarget()){
    const actions=sources.map(source=>({action:'basis',path:source.path,type:source.type}));
    await preflightFileActions(actions);
    requireTarget();
    const tree=await api<{entries:Entry[]}>('/tree');
    requireTarget();
    await preflightFileActions(actions);
    requireTarget();
    const present=new Map(tree.entries.flatMap(function walk(entry):Entry[]{return [entry,...(entry.children||[]).flatMap(walk)];}).map(entry=>[entry.path,entry.type]));
    const accepted=sources.filter(source=>present.get(source.path)===source.type);
    const added=references.addSources(accepted);
    let index=0;
    const results=sources.map(source=>present.get(source.path)===source.type?added[index++]:{path:source.path,ok:false,error:'文件已移走、删除或类型已变化，请刷新列表。'});
    if(openBasis&&results.some(result=>result.ok))workspace.open('basis');
    return results;
  }
  const externalReferenceImport=useRef(false);
  async function removeReferenceAttachment(id:string){
    const response=await request('/api/references/attachments/'+encodeURIComponent(id),{method:'DELETE'});
    if(!response.ok)throw new Error('本机参考附件清理失败。');
  }
  function updateReferenceSources(next:ReferenceSource[]){
    const retained=new Set(next.flatMap(source=>source.type==='attachment'?[source.id]:[]));
    if(!references.setSources(next))return;
    for(const source of references.sources){
      if(source.type==='attachment'&&!retained.has(source.id))
        void removeReferenceAttachment(source.id).catch(error=>{if(appAlive.current)setError((error as Error).message);});
    }
  }
  async function addExternalReferences(files:File[]){
    if(externalReferenceImport.current){setError('另一批参考资料正在导入，请稍后重试。');return;}
    if(!files.length){setError('未取得文件，请从资源管理器拖入 Markdown 文档。');return;}
    const requireTarget=referenceTarget(),failures:string[]=[];
    let added=0;
    externalReferenceImport.current=true;
    try{
      for(const file of files){
        requireTarget();
        if(!/\.md$/i.test(file.name)||file.size>2_000_000){
          failures.push(file.name+'：请选择 2 MB 以内的 Markdown 文档。');
          continue;
        }
        if(references.sources.length+added>=32){
          failures.push('依据最多容纳 32 项，请先移除不再使用的资料。');
          break;
        }
        let attachment:AttachmentReferenceSource|undefined;
        try{
          const response=await request('/api/references/attachments?name='+encodeURIComponent(file.name),
            {method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
          const data=await response.json();
          if(!response.ok)throw new Error(data.error||'添加附件失败。');
          attachment=data as AttachmentReferenceSource;
          requireTarget();
          const [result]=references.addSources([attachment]);
          if(!result.ok)throw new Error(result.error);
          added++;
        }catch(error){
          if(attachment)await removeReferenceAttachment(attachment.id).catch(()=>{});
          failures.push(file.name+'：'+(error as Error).message);
        }
      }
    }catch(error){failures.push((error as Error).message);}
    finally{externalReferenceImport.current=false;}
    if(!appAlive.current)return;
    if(added)inform('已将 '+added+' 项加入参考资料。');
    if(failures.length)setError(failures.join('；'));
  }
  const [chatDropTarget,setChatDropTarget]=useState(false);
  function isMarkdownTab(id:string){
    const session=sessions.current.get(id);
    return !!session&&!session.landing&&!session.imagePath&&!session.trashPreview&&!session.external&&(!session.disk||/\.md$/i.test(session.disk.path));
  }
  function stageAttachment(attachment:Omit<ChatAttachment,'id'>){
    const snapshot={...attachment,id:uid()};
    updateConversation(chat=>({...chat,draft:{...chat.draft,attachments:[...chat.draft.attachments,snapshot]}}));
    openChat('conversation');
  }
  function stageDocumentTab(id:string){
    const session=sessions.current.get(id),state=session?.view?.state??session?.state;
    if(!isMarkdownTab(id)||!state)return;
    const path=session?.disk?.path||'';
    stageAttachment({kind:'document',file:path,label:panelLabel(id),text:state.doc.toString(),
      reference:path?{workspaceId:fileWorkspace.info.id,path}:undefined});
  }
  function stageWorkspaceTarget(target:WorkspaceAnnotationTarget){
    if(switching.current||closing.current)return;
    void workspaceAnnotationAttachment(target,{
      workspaceId:fileWorkspace.info.id,entries,repositories:fileWorkspace.info.repositories,request,
      findOpenDocument:path=>{
        const active=sessions.current.get(activeSession.current);
        const matches=[...sessions.current.values()].filter(session=>session.disk?.path===path);
        const session=active?.disk?.path===path?active:matches.find(candidate=>candidate.dirty)??matches[0];
        return (session?.view?.state??session?.state)?.doc.toString();
      },
    }).then(attachment=>{
      if(appAlive.current&&!switching.current&&!closing.current)stageAttachment(attachment);
    }).catch(error=>{
      if(appAlive.current&&!switching.current)setError(error instanceof Error?error.message:'无法添加标注。');
    });
  }
  function stageEditorSelection(id:string,text:string,table?:{ordinal:number}){
    const file=sessions.current.get(id)?.disk?.path||'';
    if(table)stageAttachment({kind:'table',file,label:`表格 ${table.ordinal+1} · ${panelLabel(id)}`,text});
    else addContextDraft(`正文选区 · ${file||'未命名稿'}`,text);
  }
  function addContextDraft(label:string,text:string){
    if(!text.trim())return;
    setPrompt(previous=>appendDraftContext(previous,label,text));
    openChat('conversation');
    setTimeout(()=>{const input=promptRef.current;if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length);}},0);
    inform('已添加到 AI 输入框。');
  }
  function addChapterDraft(chapter:ChapterDrag){
    const session=sessions.current.get(chapter.editor),state=session?.view?.state||session?.state;
    const valid=!!state&&(session?.disk?.path||'')===chapter.file;
    const text=valid?chapterForQuickAI(state,chapter.heading):'';
    if(!text){setError('章节或正文已变化，请在标题目录中重新选择。');return;}
    addContextDraft(`章节 · ${chapter.heading.title||'未命名标题'}`,text);
  }
  function chatDropType(transfer:DataTransfer){
    return [CHAPTER_DRAG_TYPE,REFERENCE_DRAG_TYPE,'Files'].find(type=>Array.from(transfer.types).includes(type));
  }
  async function dropIntoChat(event:ReactDragEvent<HTMLElement>){
    setChatDropTarget(false);
    const transfer=event.dataTransfer,kind=chatDropType(transfer),workspaceId=fileWorkspace.info.id;
    if(!kind)return;
    event.preventDefault();event.stopPropagation();
    if(kind===CHAPTER_DRAG_TYPE){
      const chapter=readChapterDrag(transfer.getData(kind),workspaceId);
      if(chapter)addChapterDraft(chapter);else setError('请从当前仓库的标题目录拖入章节。');
      return;
    }
    if(kind===REFERENCE_DRAG_TYPE){
      const source=readReferenceDrag(transfer.getData(kind),workspaceId);
      if(!source){setError('请拖入当前仓库中的 Markdown 文档或文件夹。');return;}
      addReference(source,false);
      return;
    }
    await addExternalReferences([...transfer.files]);
  }
  const closingDocumentTab=useRef(false),closeTabFileBusy=useRef(fileBusy);
  closeTabFileBusy.current=fileBusy;
  async function closeDocumentTab(id:string) {
    const session=sessions.current.get(id);
    if(!session||closingDocumentTab.current)return;
    const originalPath=session.disk?.path,originalVersion=session.contentVersion||0,originalProposal=proposalFor(id);
    const valid=()=>sessions.current.get(id)===session&&session.disk?.path===originalPath&&(session.contentVersion||0)===originalVersion&&proposalFor(id)===originalProposal;
    const composing=()=>desktopPanels.isComposing()||!!session.view?.composing;
    const blocked=()=>!!requestAnchor.current&&running.current||structuring.current||switching.current||viewApplying.current||creatingNote.current||closeTabFileBusy.current||!!dialogRef.current;
    const retainedProposal=()=>!!originalProposal&&!!session.disk&&!!(session.view?.state||session.state);
    const pending=()=>!!proposalFor(id)&&!retainedProposal();
    const dirty=()=>session.dirty&&!retainedProposal();
    closingDocumentTab.current=true;
    try {
      const result=await prepareDocumentTabClose({blocked,composing,pending,dirty,save:()=>saveSession(id,true),valid});
      if(result!=='ready'){
        setError(result==='composing'?'请先完成当前输入法组词，再关闭标签页。':result==='blocked'?'请先停止正文生成或等待当前操作完成，再关闭标签页。':result==='pending'?'这条待审建议暂时无法保留，请先在正文中处理。':result==='unsaved'?'文档未能保存或保存期间有新修改，请先处理保存冲突或另存，再关闭标签页。':'标签页状态已变化，请处理当前操作后重试。');return;
      }
      if(composing()){setError('请先完成当前输入法组词，再关闭标签页。');return;}
      if(!valid()||blocked()||pending()||dirty()){setError('标签页状态已变化，请处理当前操作后重试。');return;}
      if(id!=='editor'&&!closeEditor(id))return;
      humanHistory.forget(id);
      setError('');
      if(session.trashPreview||session.external){sessions.current.delete(id);redraw();return;}
      if(originalProposal&&retainedProposal()){
        if(id!=='editor'){
          redraw();
          return;
        }
        // The primary slot must remain in the layout. Move the intact draft and
        // its undo history to a closed document session before showing the landing page.
        captureEditorView(session);
        const reviewId='editor:'+uid();
        const context=activeSession.current===id?{proposal:originalProposal,undo:undo.current,writingNodeId}:session.context!;
        const state=rebindDocumentUpdates(session.state!,bindings(reviewId).onUpdate);
        sessions.current.set(reviewId,{...session,id:reviewId,state,view:null,context});
      }
      session.contentVersion=(session.contentVersion||0)+1;
      session.imagePath=undefined;session.disk=null;session.state=null;session.view=null;session.dirty=false;session.landing=true;
      session.context=undefined;session.restoreScroll=undefined;session.restoreScrollLeft=undefined;session.restoreScrollTarget=undefined;
      if(activeSession.current===id){
        proposal.current=null;undo.current=[];
        setWritingNodeId(null);
        setOutline([]);setSelection({from:0,to:0,text:''});setInlineRequest(null);
      }
      redraw();
    } finally {closingDocumentTab.current=false;}
  }
  function stop() {
    stopWritingGeneration({generation,controller,requestAnchor,running,proposal,origin:writingOrigin},{setBusy:endChatRun,setStream:showStream});
  }
  useEffect(() => {
    let cancelled = false;
    const onError=(error:Error)=>{if(!cancelled)setError(error.message);};
    void refresh().catch(onError);
    void api<Config>('/config').then(next=>{if(!cancelled)setConfig(current=>next.revision>=current.revision?next:current);}).catch(onError);
    return () => {
      cancelled = true;
      generation.current++;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4200);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(()=>{
    if(!error||error.persistent)return;
    const timer=setTimeout(()=>setErrorToast(current=>current===error?null:current),2000);
    return ()=>clearTimeout(timer);
  },[error]);
  function chooseSidebar(next: "files" | "outline" | "scratch") {
    workspace.open(next);
  }
  useEffect(() => {
    if (chatOpen && chatTab === "conversation")
      messagesEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, chatBusy, chatOpen, chatTab]);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (hasUnsentDraft||[...sessions.current.values()].some(session => session.dirty||proposalFor(session.id))) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty,hasUnsentDraft,proposalFor]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if(event.defaultPrevented||event.isComposing||desktopPanels.isComposing())return;
      const target=event.target as HTMLElement|null;
      const doc=target?.ownerDocument||window.document;
      if(target?.closest?.('[data-panel-id="settings"]'))return;
      const dialogOpen=!!target?.closest?.('[role="dialog"],dialog[open]')||!!doc.querySelector('[role="dialog"]:not([data-panel-id="settings"]),dialog[open]');
      const matches=(id:Parameters<typeof matchesShortcut>[1])=>matchesShortcut(shortcutBindings,id,event);
      const hasLocalTarget=target?.closest?.('.cm-content,.find-replace-content');
      const editing=target?.closest?.('input,textarea');
      if(!dialogOpen&&!dialog&&!confirm&&!help&&!recentOpen){
        if(matches('newNote')&&!target?.closest?.('.file-explorer [role="treeitem"]')){
          event.preventDefault();event.stopPropagation();
          if(!event.repeat&&!fileBusy&&!newNoteBusy&&!busy)void createQuickNote();
        }else if(matches('openFiles')){
          event.preventDefault();event.stopPropagation();
          if(!event.repeat)openDocumentList();
        }else if(matches('find')&&!hasLocalTarget&&!editing){
          event.preventDefault();event.stopPropagation();ribbonCommand('find');
        }
      }
      if(matches('save')){
        event.preventDefault();event.stopPropagation();
        if(activeTextSource.current==='scratch')void sessionCallbacks.current.prepareScratch?.();else void save();
      }else if(matches('callAI')){
        event.preventDefault();event.stopPropagation();
        openChat("conversation");
        if(selection.text)setMode("edit");
        setTimeout(()=>promptRef.current?.focus(),0);
      }else if(matches('stopGeneration')&&running.current){
        if(event.key==='Escape')return;
        event.preventDefault();event.stopPropagation();stop();
        inform("已停止。正文没有改变。");
      }
      if(!hasLocalTarget&&event.shiftKey&&(event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='r')event.preventDefault();
    };
    const stopByEscape = (event:KeyboardEvent) => {
      if(event.defaultPrevented||event.key!=='Escape'||!running.current||!matchesShortcut(shortcutBindings,'stopGeneration',event))return;
      stop();inform("已停止。正文没有改变。");
    };
    const windows=[...new Set([window,...desktopPanels.windows.values()])];
    windows.forEach(win=>{win.addEventListener("keydown",key,true);win.addEventListener("keydown",stopByEscape);});
    return () => windows.forEach(win=>{win.removeEventListener("keydown",key,true);win.removeEventListener("keydown",stopByEscape);});
  });

  useEffect(()=>window.hiveDesktop?.onServiceError(()=>setError('本地服务已停止。未保存内容仍保留在窗口中，请导出或复制备份后重新启动。')),[]);
  useEffect(()=>fileWorkspace.register(async()=>desktopPanels.isComposing()?'请先完成当前输入法组词，再切换文件夹或退出。':undefined));
  useEffect(()=>window.hiveDesktop?.onCloseRequested(()=>{
    if(closing.current)return;
    closing.current=true;setClosingWindow(true);
    const documents=[document,...[...desktopPanels.windows.values()].map(popup=>popup.document)];
    const previousInert=documents.map(doc=>doc.body.inert);
    documents.forEach(doc=>{doc.body.inert=true;});
    void (async()=>{
      let timeout:ReturnType<typeof setTimeout>|undefined;
      try{
        if(running.current||switching.current||structuring.current||viewApplying.current||fileBusy)throw new Error('请先停止 AI 生成或等待当前文件操作完成，再退出。');
        if(hasUnsentDraft||[...sessions.current.values()].some(session=>proposalFor(session.id)))throw new Error('请先发送或清空未发送的消息，并处理待审建议，再退出。');
        if(desktopPanels.isComposing()||[...sessions.current.values()].some(session=>session.view?.composing)||scratchView.current?.composing)throw new Error('请先完成当前输入法组词，再退出。');
        if(savingPaths.current.size)throw new Error('文件正在保存，请稍后重试退出。');
        const prepare=async()=>{
          await fileWorkspace.flush();
          for(const session of sessions.current.values())if(session.dirty&&!await saveSession(session.id,true))throw new Error('有正文未能保存，请先处理冲突或另存副本，再退出。');
          await fileWorkspace.flush();
        };
        await Promise.race([prepare(),new Promise<never>((_resolve,reject)=>{timeout=setTimeout(()=>reject(new Error('保存等待超时，内容仍保留在窗口中。请检查服务和保存状态后重试退出。')),20000);})]);
        if([...sessions.current.values()].some(session=>session.dirty)||savingPaths.current.size)throw new Error('还有内容正在保存，请稍后重试退出。');
        flushThemePreferences();
        await flushThemeFiles();
        window.hiveDesktop?.finishClose(true);
      }catch(error){setError((error as Error).message);window.focus();window.hiveDesktop?.finishClose(false);}
      finally{clearTimeout(timeout);documents.forEach((doc,index)=>{doc.body.inert=previousInert[index];});closing.current=false;setClosingWindow(false);}
    })();
  }));
  useEffect(()=>{
    if(!closingWindow)return;
    const block=(event:Event)=>{event.preventDefault();event.stopImmediatePropagation();};
    const documents=[document,...[...desktopPanels.windows.values()].map(popup=>popup.document)];
    for(const doc of documents)for(const type of ['beforeinput','keydown','paste','drop'])doc.addEventListener(type,block,true);
    return()=>{for(const doc of documents)for(const type of ['beforeinput','keydown','paste','drop'])doc.removeEventListener(type,block,true);};
  },[closingWindow,desktopPanels.windows]);
  useEffect(()=>{if(help||confirm||recentOpen||dialog&&!dialog.target)window.focus();},[settings,help,confirm,recentOpen,dialog]);

  function openSettings(section:SettingsSection='models') {setSettingsSection(section);setSettingsRestoreKey(value=>value+1);setSettings(true);if(settings)desktopPanels.focus('settings');}
  async function updateSettings(route:string,body:unknown) {
    setConfigBusy(true);
    try {const next=await api<Config>(route,body);setConfig(current=>next.revision>=current.revision?next:current);}
    finally {setConfigBusy(false);}
  }
  async function selectChatModel(choice: string) {
    if(choice==='settings'){openSettings('models');return;}
    setError('');
    try {await updateSettings('/config',{revision:config.revision,demo:choice==='demo',...(choice==='demo'?{}:{selection:parseModelChoice(choice)})});}
    catch(error){setError((error as Error).message);}
  }
  // 快捷栏的按钮＝一步执行：切到该模式，并立刻对当前文档/选区跑一轮。
  function runFromDock(next: Mode) {
    setMode(next);
    if(next!=="discuss")workspace.open(activeSession.current);
    void generate({ mode: next, allowEmptyPrompt: true });
  }
  function chooseMode(next: Mode) {
    if(next!=="discuss")workspace.open(activeSession.current);
    setMode(next);
    openChat("conversation");
    setTimeout(() => promptRef.current?.focus(), 0);
  }
  function openChat(
    tab: "conversation" | "annotations" = "conversation",
    position?: { x: number; y: number },
  ) {
    if (tab === "annotations") { setAnnotationBatch(null); workspace.reveal("annotations"); return; }
    setChatTab("conversation");
    if (chatOrb || position) {
      const width = Math.min(orbBounds.current.width, window.innerWidth - 16),
        height = Math.min(orbBounds.current.height, window.innerHeight - 16);
      const point = position ||
        orbPosition.current || {
          x: window.innerWidth - 72,
          y: window.innerHeight - 170,
        };
      rightPanel.floatAt({
        x: Math.max(
          8,
          Math.min(window.innerWidth - width - 8, point.x - width + 46),
        ),
        y: Math.max(
          8,
          Math.min(window.innerHeight - height - 8, point.y - height + 46),
        ),
        width,
        height,
      });
    }
    setChatOrb(false);
    workspace.reveal("conversation");
  }
  function revealConversation() {
    if (workspace.autoHideItems.some(item=>item.id==='conversation')) {
      setChatTab('conversation');
      setChatOrb(false);
      workspace.reveal('conversation');
    } else openChat('conversation');
    if (!chatOpen) setTimeout(()=>promptRef.current?.focus(),0);
  }
  const annotationNavigation = useRef(0);
  async function locateSubmittedAnnotation(snapshot:SubmittedAnnotation) {
    const ticket = ++annotationNavigation.current;
    setAnnotationLocation(null);
    try {
      if (snapshot.source === 'scratch') {
        workspace.reveal('scratch');
        setAnnotationLocation({snapshot});
        return;
      }
      const active = sessions.current.get(activeSession.current);
      const existing = active?.disk?.path===snapshot.file ? active : [...sessions.current.values()].find(
        session=>session.disk?.path===snapshot.file&&workspace.isOpen(session.id),
      );
      if (existing) workspace.reveal(existing.id);
      else await openExplorerFile(snapshot.file,true);
      if (ticket!==annotationNavigation.current||!appAlive.current) return;
      const tabId = activeSession.current;
      if (sessions.current.get(tabId)?.disk?.path!==snapshot.file) {
        setError('未能打开标注所在的文稿。');
        return;
      }
      setAnnotationLocation({snapshot,tabId});
    } catch (error) {
      if (ticket===annotationNavigation.current&&appAlive.current)
        setError('无法定位文本标注：'+(error as Error).message);
    }
  }
  useEffect(()=>{
    if (!annotationLocation) return;
    const {snapshot,tabId}=annotationLocation;
    if (tabId && (activeEditorId!==tabId||file!==snapshot.file)) {
      setAnnotationLocation(null);
      return;
    }
    const item=annotations.findSubmitted(snapshot);
    if (item==='loading') return;
    setAnnotationLocation(null);
    if (item==='unavailable') {
      setError('原标注已移动、删除或失效，请在文稿中核对。');
      return;
    }
    try {
      activeTextSource.current=snapshot.source;
      annotations.locate(item);
    } catch(error) { setError((error as Error).message); }
  },[annotationLocation,activeEditorId,file,annotations.findSubmitted,annotations.locate,setError]);
  useEffect(()=>{
    if (!annotationLocation) return;
    const timeout=setTimeout(()=>{
      setAnnotationLocation(current=>current===annotationLocation?null:current);
      setError('标注位置暂未载入，请稍后重试。');
    },8000);
    return ()=>clearTimeout(timeout);
  },[annotationLocation,setError]);
  const annotationPanelOpen=workspace.isOpen('annotations');
  useEffect(()=>{if(!annotationPanelOpen)setAnnotationBatch(null);},[annotationPanelOpen]);
  const chatFileOpener = useRef(openDocumentPath);
  chatFileOpener.current = openDocumentPath;
  const openChatDocument = useCallback((source:string,target:string)=>{
    try {
      const path=resolveLinkTarget(source,target);
      void chatFileOpener.current(path).catch(error=>setError(error.message));
    } catch(error) { setError((error as Error).message); }
  },[setError]);
  function openEditorDocument(id:string,target:string){
    try{
      const session=sessions.current.get(id);
      const path=resolveLinkTarget(session?.disk?.path||session?.external?.disk.path||'',target);
      activateEditor(id);
      void openDocumentPath(path).catch(error=>setError(error.message));
    }catch(error){setError((error as Error).message);}
  }
  const openChatExternal = useCallback((target:string)=>{
    void openExternalHttpLink(target).then(opened=>{if(!opened)setError('无法打开外部链接。');});
  },[setError]);
  function locate(pos: number) {
    workspace.open(activeSession.current);
    const v = view.current;
    if (!v) return;
    v.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    v.focus();
  }
  const currentHeading = outline.filter((h) => h.from <= selection.from).at(-1);
  const currentWritingNode =
    writingOutline.nodes.find((node) => node.id === writingNodeId) ||
    writingOutline.nodes.find(
      (node) =>
        currentHeading &&
        targetForNode(node, outline)?.from === currentHeading.from,
    );
  const p = proposal.current;
  const reviewSessions=editorIds.filter(id=>id!==activeEditorId&&proposalFor(id));
  const writingBusy=busy&&!!requestAnchor.current;
  function reviewProposal(id:string){
    const session=sessions.current.get(id);
    if(!session||!proposalFor(id))return;
    reviewTarget.current=id;
    if(workspace.isOpen(id))workspace.open(id);
    else if(workspace.openDocumentTab(id)!=='succeeded'){
      reviewTarget.current=null;
      setError('无法打开待审建议，请完成输入法组词或当前窗口操作后重试。');
      return;
    }
    if(session.view){reviewTarget.current=null;revealProposal(id,session.view);}
  }

  function targetForChat({windowMarks=toolMarks,annotated=draft.route?.kind==='annotations'?draft.route.items:undefined}: {
    windowMarks?:readonly WindowMark[];annotated?:SubmittedAnnotation[]|null;
  }={}):ChatTarget {
    const session=sessions.current.get(activeSession.current);
    return resolveChatTarget({marks:windowMarks,workspaceId:fileWorkspace.info.id,documentFile:session?.disk?.path,hasDocument:!!(session?.view||session?.state)&&!session.landing,
      annotations:annotated??undefined,panelLabel,lookupNote:(id,path)=>{
        const note=sessions.current.get(id);
        return workspace.isOpen(id)&&note?.disk?.path===path?(note.view?.state??note.state??undefined):undefined;
      }});
  }

  function forkReply(replyId:string) {
    const chat=forkChatReply(conversation,replyId,uid(),`对话 ${conversations.length+1}`);
    if(!chat)return;
    setConversations(chats=>[...chats,chat]);
    setConversationId(chat.id);
    setChatManagerOpen(true);
  }

  function retractReply(replyId:string) {
    if(chatBusy)return;
    updateConversation(chat=>retractChatReply(chat,replyId));
    promptRef.current?.focus();
  }

  function generate(options?:GenerationOptions) {
    if(busy||running.current||structuring.current||switching.current)return;
    const nextMode=options?.annotations?'discuss':options?.mode??mode;
    if(nextMode!=='discuss'&&sessions.current.get(activeSession.current)?.trashPreview){setError('请打开可编辑的文稿后再运行此功能。');return;}
    if(nextMode!=='discuss'&&pendingProposal(activeSession.current)&&!p){
      setError('这个文件还有待审建议，请在对话中打开原标签页审阅。');
      return;
    }
    const target=targetForChat({windowMarks:[],annotated:options?.annotations??null});
    if(target.kind==='invalid'||target.kind==='window')return;
    const resendingAnnotations=draft.route?.kind==='annotations'&&options?.annotations===draft.route.items;
    const sentDraft:ChatDraft=options?.annotations
      ? {text:options.instruction??'',attachments:resendingAnnotations?draft.attachments:[],route:{kind:'annotations',items:options.annotations}}
      : {text:draft.text,attachments:draft.attachments};
    const consumesComposer=!options?.revision&&(!options?.annotations||resendingAnnotations);
    const retryTurnId=consumesComposer?draft.retryTurnId:undefined;
    const turnId=uid();
    const addTurn:(typeof add)=(role,content,details)=>{
      const text=options?.revision?.instruction||sentDraft.text||details?.annotationBatch?.instruction||(sentDraft.attachments.length?'':content);
      const sent=role==='user'?{...sentDraft,text,attachments:options?.revision?[]:sentDraft.attachments}:undefined;
      addTurnMessage(turnId,role,content,{...details,documentFile:target.file},sent,sent?retryTurnId:undefined);
    };
    return generateWriting({
      document:{view,disk,sessions,activeSession,file:target.file||'',outline,currentHeading,currentWritingNode},
      model:{config,reasoningEffort:reasoning.effort,responsePreferences:aiResponsePreferences.preferences},
      conversation:{mode,prompt:sentDraft.text,messages:withoutRetriedPrompt(messages,retryTurnId),setPrompt,setLastRequest,add:addTurn,
        attachments:options?.revision?[]:sentDraft.attachments,targetLabel:target.label,
        consumeDraft:()=>{if(consumesComposer)updateConversation(chat=>({...chat,draft:consumeChatDraft(chat.draft,draft)}));},
        restoreDraft:()=>{if(consumesComposer)updateConversation(chat=>recoverChatDraft(chat,{...draft,retryTurnId:turnId}));},
      },
      lifecycle:{running,generation,controller,requestAnchor,proposal,origin:writingOrigin},
      references,writingOutline,request:requestModel,annotationResponded:annotations.responded,
      ui:{setError,setBusy:value=>setActiveRun(value?{chatId:conversationId,target,cancellable:true}:null),setStream:showStream,openPanel:workspace.open,inform,redraw},
    },{...options,sourceAnnotationIds:nextMode==='edit'&&!options?.revision?polishSourceAnnotations():undefined});
  }

  function polishSourceAnnotations(){
    const range=view.current?.state.selection.main,path=disk.current?.path;
    return range&&!range.empty&&path?annotations.items.filter(item=>item.source==='document'&&item.file===path&&!item.stale&&item.from===range.from&&item.to===range.to).map(item=>item.id):[];
  }

  async function submitChat() {
    if(busy||running.current)return;
    if(structuring.current||switching.current){setError('请等待当前文件操作完成。');return;}
    const resolved=targetForChat();
    if(resolved.kind==='invalid'){setError(resolved.error);return;}
    if(resolved.kind==='annotations'){await generate({annotations:resolved.items,instruction:prompt});return;}
    if(resolved.kind==='document'){await generate();return;}
    const instruction=prompt.trim();
    if(!instruction)return;
    const {mark,noteState}=resolved,{workspaceId,document:target}=mark;
    if(target&&mark.id!=='search'&&pendingProposal(target.sessionId)){setError('这篇笔记还有未确认的建议，请先审阅。');return;}
    const model={instruction:appendChatAttachments(instruction,draft.attachments),selection:config.selection??undefined};
    if(model.instruction.length>8000){setError('窗口操作要求及附件合计超过 8000 字符，请缩小本轮内容后重试。');return;}
    setError('');
    const id=++generation.current,abort=new AbortController(),turnId=uid();
    controller.current=abort;
    running.current=true;
    setActiveRun({chatId:conversationId,target:resolved,cancellable:true});
    const releasePlanner=()=>{controller.current=null;running.current=false;};
    const workspaceTarget={...model,target:{workspaceId}};
    try {
      let result:NoteFindResult|DocumentsToolResult|TrashToolResult|RepositoriesToolResult|NotePropertiesToolResult|NoteOutlineToolResult|NoteSnapshotToolResult;
      if(target&&noteState){
        const noteTarget={workspaceId,file:target.file};
        const text=noteState.doc.toString();
        if(mark.id==='search')result=await findAnnotatedNote(requestModel,{...model,target:{...noteTarget,text}},abort.signal);
        else if(mark.id==='properties')result=await planNoteProperties(requestModel,{...model,target:noteTarget,fields:readNoteProperties(text).map(({key,type})=>({key,type}))},abort.signal);
        else result=await planNoteOutline(requestModel,{...model,target:noteTarget,text},abort.signal);
      }else if(mark.id==='files'){
        result=await planAnnotatedDocuments(requestModel,workspaceTarget,abort.signal);
      }else if(mark.id==='trash'){
        result=await planAnnotatedTrash(requestModel,workspaceTarget,abort.signal);
      }else{
        result=await runAnnotatedRepositories(requestModel,{...workspaceTarget,target:{workspaceId,revision:fileWorkspace.info.revision},pendingName:repositoryFollowUp?.mark===mark?repositoryFollowUp.name:undefined},abort.signal);
      }
      if(generation.current!==id||!appAlive.current)return;
      releasePlanner();
      setActiveRun(current=>current?.chatId===conversationId?{...current,cancellable:false}:current);
      const reply=await applyWindowToolResult(mark,result,noteState);
      if(generation.current!==id||!appAlive.current)return;
      addTurnMessage(turnId,'user',instruction,{documentFile:resolved.file},{text:draft.text,attachments:draft.attachments,route:{kind:'window',mark}},draft.retryTurnId);
      addTurnMessage(turnId,'assistant',reply,{documentFile:resolved.file});
      setLastRequest({messages:[{role:'user',content:model.instruction}],mode:'discuss',node:resolved.label,scope:'标注的窗口 · '+resolved.label,file:resolved.file||''});
      updateConversation(chat=>({...chat,draft:consumeChatDraft(chat.draft,draft)}));
      if(result.kind==='repository-location-required')setRepositoryFollowUp({mark,name:result.name});
      else {setRepositoryFollowUp(current=>current?.mark===mark?null:current);removeWindowMark(mark);}
    } catch(error) {
      if(generation.current===id&&appAlive.current&&(error as Error).name!=='AbortError')setError((error as Error).message);
    } finally {
      if(generation.current===id){releasePlanner();endChatRun();}
    }
  }

  async function applyWindowToolResult(mark:WindowMark,result:NoteFindResult|DocumentsToolResult|TrashToolResult|RepositoriesToolResult|NotePropertiesToolResult|NoteOutlineToolResult|NoteSnapshotToolResult,noteState?:EditorState):Promise<string> {
    switch(result.kind){
      case 'find-note':{
        if(mark.id!=='search'||result.file!==mark.document?.file)throw new Error('查找结果与标注的笔记不一致，请重试。');
        const summary=result.matches.length?`${result.matches.length}${result.truncated?'＋':''} 处匹配`:'未找到匹配';
        return [`${result.file} · 「${result.query}」${summary}`,...result.matches.map(match=>`第 ${match.line} 行，第 ${match.column} 列 · ${match.snippet}`)].join('\n');
      }
      case 'folder-list':
        return result.entries.length?['文件夹「'+(result.folder||'仓库根目录')+'」',...result.entries.map(entry=>entry.name+(entry.type==='folder'?'/':''))].join('\n'):'文件夹「'+(result.folder||'仓库根目录')+'」为空。';
      case 'document-create':{
        const created=await manageFile({action:'create',parent:result.parent,name:result.name,type:result.type},{quiet:true,actor:'ai'});
        return '已新建 '+created.path+'。'+(created.warning||'');
      }
      case 'document-trash':{
        const moved=await manageFile({action:'trash',path:result.path},{quiet:true,actor:'ai'});
        return '已移入回收站 '+result.path+'。'+(moved.warning||'');
      }
      case 'trash-restore':{
        const outcomes:string[]=[];
        for(const item of result.items){
          if(!appAlive.current)break;
          try{const restored=await manageFile({action:'restore',id:item.id},{quiet:true,actor:'ai'});outcomes.push('已恢复 '+restored.path+'。'+(restored.warning||''));}
          catch(error){outcomes.push('无法恢复 '+item.path+' · '+(error as Error).message);}
        }
        setTrashRevision(value=>value+1);
        return outcomes.join('\n');
      }
      case 'trash-confirm-delete':
        if(trashDeleteRequest)throw new Error('请先处理当前的永久删除请求。');
        workspace.open('trash');
        setTrashDeleteRequest({workspaceId:mark.workspaceId,items:result.items});
        return '请在回收站确认要永久删除的 '+result.items.length+' 项。';
      case 'repository-list':
        return result.repositories.map(repository=>repository.name+' · '+repository.path).join('\n');
      case 'repository-location-required':
        return result.question;
      case 'repository-created':
        fileWorkspace.adopt(result.workspace);
        recordHistory({actor:'ai',kind:'file',label:'创建并登记仓库',changes:{file:{action:'repository-create',path:result.repository.root}}});
        return '已创建仓库 '+(result.repository.name?result.repository.name+' · ':'')+result.repository.root;
      case 'note-properties':
      case 'create-note-snapshot':
      case 'note-outline':{
        const target=mark.document;
        const session=target&&sessions.current.get(target.sessionId);
        const state=session?.view?.state||session?.state;
        if(!target||!session||!state||!noteState||result.file!==target.file||session.disk?.path!==target.file||!workspace.isOpen(session.id)||state.doc!==noteState.doc||pendingProposal(session.id))
          throw new Error('标注的笔记内容或会话已变化，请核对后重试。');
        if(result.kind==='create-note-snapshot'){
          await createNoteSnapshot(session,state,'ai');
          return '已创建 '+target.file+' 的文件快照。';
        }
        if(result.kind==='note-outline'){
          const nodes=result.nodes.map(node=>({...node,id:node.id||uid()}));
          if(JSON.stringify(nodes)===JSON.stringify(result.before.nodes))return '写作大纲没有需要修改的内容。';
          const after=await writingOutline.saveFor(target.file,nodes,result.before.revision);
          recordHistory({actor:'ai',file:target.file,kind:'outline',label:'修改写作大纲',changes:{outline:{before:result.before,after}}});
          return '已更新 '+target.file+' 的写作大纲。';
        }
        const rows=readNoteProperties(state.doc.toString());
        for(const operation of result.operations){
          const index=rows.findIndex(row=>row.key===operation.key);
          if(operation.op==='remove'){if(index!==-1)rows.splice(index,1);continue;}
          const old=rows[index];
          const row={...old,id:old?.id||uid(),key:operation.key,type:operation.type||old?.type||'text',value:operation.value};
          if(index===-1)rows.push(row);else rows[index]=row;
        }
        const edit=notePropertiesTransaction(state,rows);
        if(!edit)return '笔记属性没有需要修改的内容。';
        const change=state.update({...edit,userEvent:'input.ai.properties',annotations:Transaction.addToHistory.of(false)});
        applyNoteTransaction(session,change);
        recordHistory({actor:'ai',file:target.file,kind:'properties',label:'修改笔记属性',changes:{text:historyTextChanges(change)}});
        return '已修改 '+target.file+' 的笔记属性，可在保存文稿时一并落盘。';
      }
    }
  }
  const {accept,reject,undoAI,editCandidate,editRefinementNote}=createProposalActions({view,disk,proposal,undo,writingOutline:{...writingOutline,save:nodes=>saveHistoryOutline('ai',nodes)},add,setError,inform,redraw,setMode,openChat:()=>openChat('conversation'),promptRef,
    onAccepted:(accepted,doc)=>recordHistory({actor:'ai',kind:'text',file:accepted.file,label:'保留 AI 正文建议',
      changes:{text:[{...historyTextPatch(doc,accepted.from,accepted.to,accepted.text),before:accepted.original}],
        ...(accepted.placement==='comparison'?{polish:{id:accepted.id,reason:accepted.reason,node:accepted.node,annotationIds:accepted.annotationIds}}:{})}}),
    onReverted:id=>void history.setStatus(id,'reverted','applied',true).catch(()=>{}),
  });

  
  function iconRail(edge:DockEdge){
    const items=workspace.autoHideItems.filter(item=>item.edge===edge).map(item=>{
      const session=sessions.current.get(item.id);
      return {...item,label:panelLabel(item.id),Icon:session?(session.imagePath?FileImage:FileTextIcon):railIcons[item.id]||FileTextIcon,number:session?editorIds.indexOf(item.id)+1:undefined};
    });
    if(!items.length)return null;
    const scale=appearanceSettings.appearance.uiScale/100;
    return <div className="rail-edge-wrap"><PanelIconRail minimumTriggerMs={panelIconDragPreferences.preferences.minimumTriggerMs} holdDelayMs={panelIconDragPreferences.preferences.holdDelayMs} holdStyle={panelIconDragPreferences.preferences.holdStyle} edge={edge} items={items} scale={scale} onToggle={workspace.toggleAutoHide} onMove={workspace.repositionAutoHide} onDock={workspace.openDocked}/>{(edge==='left'||edge==='right')&&<RailEdgeHandle edge={edge} scale={scale} disabled={!workspace.canPullRail(edge)} onCommit={width=>workspace.dockAutoHideRail(edge,width)}/>}</div>;
  }
  const stale = p
    ? !previewIntact(p, view.current?.state.doc, file)
    : false;
  // 建议就地显示在正文锚点后面，不再用底部浮层压住文字。
  const inlineProposal=useMemo<InlineProposal|null>(()=>p?{id:p.id,from:p.from,to:p.to,mode:modeLabels[p.mode],count:p.count,text:p.text,original:p.original,reason:p.reason,stale,node:p.node,placement:p.placement,refinementNote:p.refinementNote}:null,[p,stale]);
  return (
    <div className="app-shell" data-revision={tick}>
      <AppHeader
        workspace={workspace} openChat={openChat} openSettings={openSettings} openHistory={showHistory} switchRepository={switchWorkspace}
        save={save} fileWorkspace={fileWorkspace} config={config}
        file={file} fileBusy={fileBusy} openingFile={fileActivity==='opening'} chatOpen={chatOpen} leftOpen={leftOpen} setError={setError} setHelp={setHelp}/>
      <Ribbon visible={appearanceSettings.appearance.ribbonVisible} collapsed={appearanceSettings.appearance.ribbonCollapsed}
        onCommand={ribbonCommand} editorReady={activeTextSource.current==='scratch'?workspace.isOpen('scratch')&&!!scratchView.current:!!view.current}
        fileActions={{new:{run:()=>void createQuickNote(),disabled:fileBusy||newNoteBusy||busy},open:{run:openDocumentList},
          export:{run:exportMarkdown,disabled:!editorState.current||!!proposal.current||fileBusy},recent:{run:()=>setRecentOpen(true)}}}
        onCollapsedChange={value=>appearanceSettings.setAppearance(old=>({...old,ribbonCollapsed:value}))}
        onVisibilityChange={value=>{appearanceSettings.setAppearance(old=>({...old,ribbonVisible:value}));if(!value){inform('已隐藏顶部编辑栏，可在设置 → 界面中重新显示。');document.querySelector<HTMLButtonElement>('button[aria-label="设置"]')?.focus();}}}
        onSettings={()=>openSettings('appearance')} viewControls={<ViewControls mode={mode} workspaceId={fileWorkspace.info.id} onCapture={captureView} onApply={applyView}/>}/>
      <div className="workbench-host nearby-workbench-host">
        <div className="nearby-workbench-middle">
        {iconRail('left')}
      <div className="workbench free-workbench" ref={workbenchRef}>
        <DesktopPanel id="files" title="文档" open={leftOpen}><aside
          data-panel-id="files" aria-label="文档面板"
          ref={leftPanel.ref}
          className={
            "sidebar workspace-panel " + (leftPanel.grouped?'panel-grouped ':'') +
            (leftPanel.floating ? "panel-floating" : "panel-docked")
          }
          style={leftPanel.style}
          onPointerDownCapture={leftPanel.raise}
        >
          <div
            className="sidebar-title panel-drag-header" data-window-annotation={markedPanels.indexOf('files')+1||undefined} data-lock-panel="files" data-position-locked={leftPanel.positionLocked||undefined}
            onPointerDown={leftPanel.beginDrag}
            title={leftPanel.lockHint}
          >
            <b>文档</b>
            <PanelControls chrome={chrome} id="files" />
            {leftPanel.positionLocked&&<Icon name="panel.positionLocked" className="panel-position-lock-icon" size={11}/>}
          </div>
          <div
            className="sidebar-content"
            id="sidebar-panel-files"
            aria-label="文档列表"
          >
            <FileExplorer onRefresh={refresh} entries={entries} workspaceId={fileWorkspace.info.id} root={root} file={file} dirty={dirty} filter={filter} setFilter={setFilter} collapsed={collapsed} setCollapsed={setCollapsed} renameRequest={renameRequest}
              treeReady={!!root} onOpenRepositories={()=>workspace.open('repositories')}
              onOpen={openAndCount} onOpenPath={openDocumentPath} onAction={manageFile} onPreflight={preflightFileActions} onReferenceBatch={addReferenceBatch}
              onFolderVisit={path=>{if(!annotationTool)quickOpen.visit(path);}} onQuickOpenDrop={path=>setQuickOpenError(quickOpen.bind([path]))}
              onReferenceDrop={(source,destination)=>addReference(source,destination==='basis')} onAI={path=>{const entry=entries.flatMap(function walk(value):Entry[]{return [value,...(value.children||[]).flatMap(walk)];}).find(entry=>entry.path===path);if(entry)addReference({path,type:entry.type});}}/>
          </div>
          <input
            ref={importRef}
            type="file"
            accept=".md,text/markdown"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void importFile(f);
            }}
          />
          <div className="sidebar-trash-footer panel-status-footer" aria-label="文档底栏"><button type="button" aria-label="回收站" title="打开回收站" aria-pressed={workspace.isOpen('trash')} onClick={()=>workspace.open('trash')}><Trash2 size={14}/></button></div>
          {leftPanel.handles}
        </aside></DesktopPanel>
        {editorIds.map((id,index)=>{
          const session=sessions.current.get(id)!,documentPanel=workspace.panel(id);
          const external=session.external,documentPath=session.disk?.path||external?.disk.path;
          return (<DesktopPanel key={id} id={id} title={`${panelLabel(id)} · 正文 ${index+1}`} open={workspace.isOpen(id)} visible={documentPanel.visible}><main data-panel-id={id} aria-label={`正文编辑区 ${index+1}`}
          className={
            "document-pane workspace-panel " + (documentPanel.grouped?'panel-grouped ':'') + (activeEditorId === id ? "active-editor " : "") +
            (documentPanel.floating ? "panel-floating" : "panel-docked")
          }
          ref={documentPanel.ref}
          style={documentPanel.style}
          onPointerDownCapture={()=>{activateEditor(id);documentPanel.raise();}} onFocusCapture={()=>activateEditor(id)}
        >
          <div
            className="document-tabs panel-drag-header" data-window-annotation={markedPanels.indexOf(id)+1||undefined} data-lock-panel={id} data-position-locked={documentPanel.positionLocked||undefined}
            onPointerDown={documentPanel.beginDrag}
            title={documentPanel.primary?'正文主版面 · 位置固定':documentPanel.lockHint}
            data-position-fixed={!documentPanel.movable||undefined}
          >
            <div className="document-tab" data-document-tab={id} data-tab-detachable={canDetachDocumentTab||undefined} title={`${session.trashPreview?'只读 · '+session.trashPreview.path:session.landing?'新标签页':session.imagePath||documentPath||'未命名稿'}${canDetachDocumentTab?' · 拖动移出此标签':''}`} onPointerDown={event=>{
              if(!canDetachDocumentTab)return;event.stopPropagation();workspace.beginTabDrag(id,event,{fromTab:true,onFinish:()=>{}});
            }}>
              <span>{panelLabel(id)}</span>
              {session.dirty && <i className="dirty-dot" />}
              <button type="button" className="document-tab-close" data-no-drag aria-label={`关闭${panelLabel(id)}标签页`} title="关闭标签页" onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();void closeDocumentTab(id);}}><X size={13}/></button>
            </div>
            <NewTabButton onClick={()=>openBlankTab(id)} disabled={writingBusy||newNoteBusy||fileBusy}/>
            <div className="tab-spacer" />
            <button
              className="icon-button"
              aria-label="撤回 AI 修改"
              title="撤回最近一次 AI 修改"
              onClick={undoAI}
              disabled={activeEditorId===id?!undo.current.length:!session.context?.undo.length}
            >
              <RotateCcw size={15} />
            </button>
            <PanelControls chrome={chrome} id={id} />
            {documentPanel.positionLocked&&<Icon name="panel.positionLocked" className="panel-position-lock-icon" size={11}/>}
          </div>
          {documentPath&&fileConflicts[documentPath]&&<div className="file-conflict" role="alert"><span>{fileConflicts[documentPath]}</span><button type="button" onClick={()=>reloadFromDisk(id)}>重新读取磁盘</button>{!external&&<button type="button" onClick={()=>{activateEditor(id);openSaveAs(documentPath);}}>另存本地副本</button>}</div>}
          {external?<><div className="external-document-bar">
            <span title={external.disk.path}>{external.editable?'仓库外文稿':'仓库外 · 只读预览'} · {external.disk.path}</span>
            {external.editable?<button type="button" disabled={!session.dirty||fileBusy} onClick={()=>void saveSession(id)}>保存到原文件</button>:
              <button type="button" onClick={()=>{external.editable=true;redraw();}}>切换到编辑</button>}
          </div>
            <Editor initialState={session.state} displayMode={external.editable?'live':'preview'}
              onReady={bindings(id).onReady} onUpdate={bindings(id).onUpdate} onError={setError}
              onOpenLink={target=>openEditorDocument(id,target)}/>
            {emptyPanelFooter(external.editable?(session.dirty?'有未保存的修改':'已保存'):'只读预览')}
          </>:session.trashPreview?<><TrashDocumentPreview preview={session.trashPreview}/>{emptyPanelFooter('回收站只读预览')}</>:session.imagePath?<><ImageFileView key={fileWorkspace.info.id+session.imagePath} path={session.imagePath} workspaceId={fileWorkspace.info.id}/>{emptyPanelFooter("图片")}</>:session.landing?<><NewTabPage active={activeEditorId===id} busy={newNoteBusy||fileBusy||busy} onCreate={()=>void createQuickNote(id)} onOpen={openDocumentList}/>{emptyPanelFooter("新标签页")}</>:<>
                {<Editor initialState={session.state} keepAlive={busy&&activeEditorId===id||!!dialog?.target&&dialog.target.editor===session.view} documentFile={session.disk?.path||''} onOpenLink={target=>openEditorDocument(id,target)} onDraftSelection={(text,table)=>stageEditorSelection(id,text,table)} annotationTool={annotationTool} searchActive={workspace.isOpen('search')&&activeEditorId===id&&activeTextSource.current==='document'} onFind={replace=>{activateEditor(id);activeTextSource.current='document';ribbonCommand('find',replace);}} displayMode={session.displayMode||'live'} splitOrder={appearanceSettings.appearance.splitOrder} typewriter={!!session.typewriter} onReady={bindings(id).onReady} onUpdate={bindings(id).onUpdate} onFocus={()=>{if(activeTextSource.current!=='document'){activeTextSource.current='document';redraw();}}} onMarkSelection={()=>{activateEditor(id);markText('document',sessions.current.get(id)?.disk?.path||'');}} onUnmarkSelection={annotationId=>{activateEditor(id);unmarkText('document',annotationId,sessions.current.get(id)?.disk?.path||'');}} onShowAnnotations={context=>{activateEditor(id);showLocalAnnotation('document',context,sessions.current.get(id)?.disk?.path||'');}} onError={setError} inlineProposal={activeEditorId===id?inlineProposal:null}/>}
              {activeEditorId===id&&<ProposalOverlay view={view.current} proposal={inlineProposal} accept={accept} reject={adjust=>{
                const origin=writingOrigin.current;
                if(origin?.proposalId&&origin.proposalId===p?.id)stop();
                reject(adjust);
              }} editCandidate={editCandidate} editRefinementNote={editRefinementNote}
                refineCandidate={instruction=>{if(p)void generate({mode:'edit',revision:{proposalId:p.id,instruction},allowEmptyPrompt:true});}} busy={busy}/>
              }
          <EditorStatusBar status={session.disk?`自由写作 · ${session.dirty?'有未保存的修改':'已保存'}`:'未打开文档'} aiStatus={activeEditorId===id?(writingBusy?'AI 正在生成':p?stale?'建议已被改动，请核对':'预览中：✓ 保留 / ✗ 撤掉，未保存':undefined):session.context?.proposal?'1 条建议等待审阅':undefined} state={session.view?.state||session.state} eol={session.disk?.eol} bom={session.disk?.bom} preferences={statusPreferences} plugins={statusPlugins} onSettings={()=>openSettings('appearance')}/>
          </>}
          {documentPanel.handles}
        </main></DesktopPanel>
);
        })}
          <DesktopPanel id="conversation" title="对话" open={chatOpen}><aside data-panel-id="conversation" aria-label="对话面板"
            ref={rightPanel.ref}
            data-reference-drop="chat" data-reference-workspace={fileWorkspace.info.id}
            data-chat-drop={chatDropTarget||undefined}
            onDragOver={event=>{if(!chatDropType(event.dataTransfer))return;event.preventDefault();event.dataTransfer.dropEffect='copy';setChatDropTarget(true);}}
            onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setChatDropTarget(false);}}
            onDrop={event=>void dropIntoChat(event)}
            className={
              "chat-panel compact-chat workspace-panel " + (rightPanel.grouped?'panel-grouped ':'') +
              (rightPanel.floating
                ? "panel-floating floating"
                : "panel-docked docked")
            }
            style={rightPanel.style}
            onPointerDownCapture={rightPanel.raise}
          >
            <div
              className="chat-header panel-drag-header" data-window-annotation={markedPanels.indexOf('conversation')+1||undefined} data-lock-panel="conversation" data-position-locked={rightPanel.positionLocked||undefined}
              onPointerDown={rightPanel.beginDrag}
              title={rightPanel.lockHint}
            >
              {!conversationHasNativeTabs&&<WritingModeControl mode={mode} onMode={chooseMode}/>}
              <PanelControls chrome={chrome} id="conversation" />
              {rightPanel.positionLocked&&<Icon name="panel.positionLocked" className="panel-position-lock-icon" size={11}/>}
            </div>
            <div className="chat-context">
              {conversationHasNativeTabs&&<WritingModeControl mode={mode} onMode={chooseMode}/>}
              <Icon name="file.text" size={13}/>
              <span aria-label="AI 操作目标" title={displayedTarget.file}>{displayedTarget.label}</span>
            </div>
            {chatManagerOpen&&<div className="chat-session-switcher" role="region" aria-label="会话管理">
              <select aria-label="切换聊天" value={conversationId} onChange={event=>setConversationId(event.target.value)}>
                {conversations.map(chat=><option key={chat.id} value={chat.id}>{chat.label}{activeRun?.chatId===chat.id?' · 回复中':''}</option>)}
              </select>
            </div>}
            <div className="chat-action-layout">
            {chatActions('left')}
            <div className="conversation-view">
              <div className="messages">
                {messages.filter(message=>message.id!=="welcome"&&message.role!=="system").map((message) => (
                  <div key={message.id} className={"message " + message.role}>
                    <ChatMarkdown text={message.annotationBatch?.instruction ?? message.content} documentFile={message.documentFile}
                      onOpenExternal={openChatExternal} onOpenDocument={openChatDocument}/>
                    {message.annotationBatch&&<ChatAnnotationEntries batch={message.annotationBatch}
                      onLocate={item=>void locateSubmittedAnnotation(item)}
                      onOpenBatch={()=>{setAnnotationBatch(message.annotationBatch!);workspace.reveal('annotations');}}/>}
                    {message.draft&&<ChatAttachmentList attachments={message.draft.attachments}/>}
                    {message.role==='assistant'&&message.turnId&&<div className="chat-reply-actions">
                      <button type="button" className="text-button" disabled={chatBusy} onClick={()=>retractReply(message.id)}>撤回</button>
                      <button type="button" className="text-button" onClick={()=>forkReply(message.id)}>分支到新聊天</button>
                    </div>}
                  </div>
                ))}
                {chatBusy && (
                  <div className="message assistant thinking">
                    <span className="chat-reply-status">正在回复…</span>
                    {stream&&<ChatMarkdown text={stream.text} documentFile={stream.documentFile}
                      onOpenExternal={openChatExternal} onOpenDocument={openChatDocument}/>}
                  </div>
                )}
                {reviewSessions.map(id=>(
                  <div className="chat-context" key={id}>
                    <Icon name="document.pendingProposal" size={13}/>
                    <span title={sessions.current.get(id)?.disk?.path}>{sessions.current.get(id)?.disk?.path}</span>
                    <button type="button" onClick={()=>reviewProposal(id)}>审阅建议<ChevronRight size={12}/></button>
                  </div>
                ))}
                <div ref={messagesEnd} />
              </div>
              <div className="chat-bottom">
                {toolMarks.length>0&&<div className="window-tool-targets">{toolMarks.map(mark=><button key={mark.id} type="button" className="text-button" title={mark.document?.file} aria-label={'移除'+panelLabel(mark.id)+'窗口标注'} onClick={()=>{
                  setRepositoryFollowUp(current=>current?.mark===mark?null:current);
                  removeWindowMark(mark);
                  if(draftMark===mark)updateConversation(chat=>({...chat,draft:{...chat.draft,route:undefined}}));
                }}>{panelLabel(mark.id)}{isNoteTool(mark.id)?' · '+(mark.document?.file.split('/').at(-1)||'尚未绑定笔记'):''} <X size={12}/></button>)}</div>}
                {draft.route?.kind==='annotations'&&<div className="window-tool-targets"><button type="button" className="text-button" aria-label="移除文本标注" onClick={()=>updateConversation(chat=>({...chat,draft:{...chat.draft,route:undefined}}))}>{draft.route.items.length} 条文本标注 <X size={12}/></button></div>}
                {conversation.parked.length>0&&<button type="button" className="text-button" onClick={()=>updateConversation(restoreParkedDraft)}>恢复先前草稿（{conversation.parked.length}）</button>}
                <ChatComposer key={conversationId} inputRef={promptRef} value={prompt} onChange={setPrompt} onSend={()=>void submitChat()} onStop={()=>{if(controller.current){stop();inform("已停止生成。");}}} canStop={chatBusy&&activeRun.cancellable}
                  attachments={draft.attachments} onRemoveAttachment={id=>updateConversation(chat=>({...chat,draft:{...chat.draft,attachments:chat.draft.attachments.filter(item=>item.id!==id)}}))} allowAttachmentOnly={chatTarget.kind==='document'}
                  busy={chatBusy} disabled={busy&&!chatBusy||chatTarget.kind==='document'&&mode!=='discuss'&&(!disk.current||pendingProposal(activeEditorId))} placeholder={toolMarks.some(mark=>mark===repositoryFollowUp?.mark)?'回复创建仓库的位置…':toolMarks.length?'输入对标注窗口的操作要求…':chatTarget.kind==='annotations'?'输入对文本标注的指示…':mode==="edit"?"输入修改要求…":mode==="outline"?"这一节想怎么写…":mode==="continue"?"接下来想写什么…":"输入消息…"}
                  config={config} modelBusy={configBusy} reasoningEffort={reasoning.effort} onReasoningChange={reasoning.setEffort} onModelChange={choice=>void selectChatModel(choice)}/>{reasoning.saveError&&<p role="status">{reasoning.saveError}</p>}
              </div>
            </div>
            {chatActions('right')}
            </div>
            {aiButtonLayout.layout.bottom.length?chatActions('bottom'):emptyPanelFooter("对话")}
            {rightPanel.handles}
          </aside></DesktopPanel>
        <PanelFrame chrome={chrome} id="repositories" title="仓库管理" className="repositories-workspace">{workspace.isOpen('repositories')&&<RepositoryPanel annotationMode={annotationTool} onSwitch={switchWorkspace} onRemove={removeRepository} onReturn={()=>workspace.close('repositories')}/>}</PanelFrame>
        <PanelFrame chrome={chrome} id="quick-open" title="快速打开文档" className="quick-open-workspace">{workspace.isOpen('quick-open')&&
          <QuickOpenPanel workspaceId={fileWorkspace.info.id} indexes={quickOpen} request={requestModel} modelConfigured={!config.demo}
            onOpen={path=>openAndCount(path,false,true)} onClose={()=>workspace.close('quick-open')} dropError={quickOpenError} onDropError={setQuickOpenError}/>}
        </PanelFrame>
        <PanelFrame chrome={chrome} id="toc" title="标题目录" className="toc-workspace"><TableOfContents key={activeEditorId+':'+file} file={file} items={outline} current={currentHeading?.from} onLocate={locate}
          onDraft={heading=>addChapterDraft({workspace:fileWorkspace.info.id,editor:activeEditorId,file,heading})}
          onDragSection={(heading,event)=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData(CHAPTER_DRAG_TYPE,JSON.stringify({workspace:fileWorkspace.info.id,editor:activeEditorId,file,heading} satisfies ChapterDrag));}}/></PanelFrame>
        <PanelFrame chrome={chrome} id="outline" title="大纲" className="outline-workspace"><div className="sidebar-content">            <WritingOutline
              key={JSON.stringify([fileWorkspace.info.id,file])}
              items={outline}
              nodes={/\.md$/i.test(file)?writingOutline.nodes:[]}
              selectedId={currentWritingNode?.id || null}
              onSelect={setWritingNodeId}
              onSave={nodes=>saveHistoryOutline('human',nodes)}
              busy={writingOutline.busy}
              ready={/\.md$/i.test(file)&&writingOutline.ready}
              onRetry={writingOutline.retry}
              onLocate={locate}
              onWrite={(id) => {
                setWritingNodeId(id);
                const target = writingOutline.nodes.find(
                  (node) => node.id === id,
                );
                const heading = target
                  ? targetForNode(target, outline)
                  : undefined;
                if (heading) locate(heading.from);
                chooseMode("outline");
              }}
            />
</div></PanelFrame>
        <PanelFrame chrome={chrome} id="scratch" title="草稿" className="scratch-workspace"><ScratchPad keepAlive={!!dialog?.target&&dialog.target.editor===scratchView.current} annotationTool={annotationTool}
              active={workspace.isOpen("scratch")}
              onError={setError}
              onEditor={onScratchEditor}
              onEditorUpdate={onScratchUpdate}
              onMarkSelection={()=>markText('scratch')}
              onUnmarkSelection={annotationId=>unmarkText('scratch',annotationId)}
              onShowAnnotations={context=>showLocalAnnotation('scratch',context)}
              onEditorFocus={()=>{if(activeTextSource.current!=='scratch'){activeTextSource.current='scratch';redraw();}}}
              searchActive={workspace.isOpen('search')&&activeTextSource.current==='scratch'}
              onDraftSelection={text=>addContextDraft('正文选区 · 自由草稿',text)}
              onFind={replace=>{activeTextSource.current='scratch';ribbonCommand('find',replace);}}
              onSaved={() =>
                void refresh().catch((error) => setError(error.message))
              }
              onOpenFile={() => safeSwitch(() => void openFile("自由草稿.md"))}
            />
</PanelFrame>
        <PanelFrame chrome={chrome} id="annotations" title="标注" className="annotations-workspace">{annotationBatch
                ? <ChatAnnotationBatchView batch={annotationBatch} onLocate={item=>void locateSubmittedAnnotation(item)} onBack={()=>setAnnotationBatch(null)}/>
                : <AnnotationPanel focusRequest={annotationFocus}
                items={annotations.items}
                selected={annotations.selected}
                toggle={annotations.toggle}
                selectAll={annotations.selectAll}
                remove={annotations.remove}
                reorder={annotations.reorder}
                locate={locateAnnotation}
                reanchor={reanchorAnnotation}
                onSend={sendAnnotations}
                busy={busy}
                saveError={annotations.saveError}
                retrySave={annotations.retrySave}
              />}
</PanelFrame>
        <PanelFrame chrome={chrome} id="properties" title="笔记属性" className="properties-workspace"><NotePropertiesPanel target={(()=>{if(activeTextSource.current==='scratch'){const editor=scratchView.current;if(!editor)return null;return {editor,file:'自由草稿.md',valid:()=>activeTextSource.current==='scratch'&&scratchView.current===editor};}const session=sessions.current.get(activeEditorId),editor=session?.view,path=session?.disk?.path;if(!editor||!path||session?.landing)return null;return {editor,file:path,valid:()=>activeTextSource.current==='document'&&activeSession.current===activeEditorId&&sessions.current.get(activeEditorId)?.view===editor&&sessions.current.get(activeEditorId)?.disk?.path===path};})()} targetKey={activeTextSource.current==='scratch'?'scratch:自由草稿.md':'document:'+activeEditorId+':'+file} onApplied={()=>inform('笔记属性已应用。')} onTargetAvailability={ready=>{propertyTargetAvailable.current=ready;}}/></PanelFrame>
        <PanelFrame chrome={chrome} id="basis" title="依据" className="basis-workspace"><InputBasisPanel request={lastRequest} file={file} mode={mode} sources={references.sources} entries={entries} workspaceId={fileWorkspace.info.id} onChange={updateReferenceSources} onExternalDrop={addExternalReferences}/>{references.saveError&&<p role="status">{references.saveError}</p>}</PanelFrame>
        <PanelFrame chrome={chrome} id="trash" title="回收站" className="trash-workspace"><TrashPanel open={workspace.isOpen('trash')} refreshKey={trashRevision} onPreview={openTrashedDocument} onRestore={id=>manageFile({action:'restore',id})} onChanged={()=>setTrashRevision(value=>value+1)} deleteRequest={trashDeleteRequest} onDeleteRequestShown={shown=>setTrashDeleteRequest(current=>current===shown?null:current)}
          onDeleted={items=>{for(const item of items)recordHistory({actor:'human',kind:'file',file:item.path,label:'永久删除',changes:{file:{action:'permanent-delete',path:item.path,id:item.id}}});}}/></PanelFrame>
        <PanelFrame chrome={chrome} id="search" title="查找替换" className="find-replace-workspace"><FindReplacePanel editor={searchEditor} open={workspace.isOpen('search')} onClose={()=>workspace.close('search')} label={searchInScratch?'自由草稿.md':file.split('/').at(-1)||'未命名稿'}/></PanelFrame>
        {workspace.tabGroups.map(group=><WorkspaceTabs key={group.id} group={group} style={group.style} label={panelLabel} onSelect={workspace.open}
          positionLocked={workspace.isPositionLocked(group.active)} lockHint={workspace.panel(group.active).lockHint} onNewTab={group.panels.every(id=>sessions.current.has(id))?()=>openBlankTab(group.active):undefined} newTabDisabled={writingBusy||newNoteBusy||fileBusy}
          onTabDrag={canDetachDocumentTab&&group.panels.every(id=>sessions.current.has(id))?workspace.beginTabDrag:undefined} isDirty={id=>!!sessions.current.get(id)?.dirty}
          onCloseTab={group.panels.every(id=>sessions.current.has(id))?id=>void closeDocumentTab(id):undefined}
          onRaise={workspace.panel(group.active).raise} onDrag={workspace.beginGroupDrag} handles={workspace.panel(group.active).groupHandles} controls={<PanelControls chrome={chrome} id={group.active} groupMembers={group.panels} />}/>)}
        {workspace.chrome}
        {!workspace.openIds.length && <div className="empty-workspace"><p>单击边缘图标，或从「视图 → 面板」打开需要的面板。</p><button onClick={()=>workspace.open("editor")}>打开正文编辑区</button></div>}
      </div>
        {iconRail('right')}
        </div>
      </div>
      {chatOrb && appearanceSettings.appearance.floatingToolbarVisible!==false && (
        <FloatingOrb
          busy={busy}
          initialPosition={orbPosition.current}
          onPosition={(position) => {
            orbPosition.current = position;
          }}
          onOpen={(position) => openChat(chatTab, position)}
        />
      )}
      {[...annotationOwners].map(([host,ownerDocument])=><InlineAnnotationEditor key={host} ownerDocument={ownerDocument} scopeKey={JSON.stringify([fileWorkspace.info.id,activeEditorId,file])}
        items={annotations.items.filter(item=>(item.source==='document'?view.current:scratchView.current)?.dom.ownerDocument===ownerDocument)}
        request={inlineRequest&&annotations.items.some(item=>item.id===inlineRequest.id&&(item.source==='document'?view.current:scratchView.current)?.dom.ownerDocument===ownerDocument)?inlineRequest:null}
        editorFor={(source) => {const editor=source==='document'?view.current:scratchView.current;return editor?.dom.ownerDocument===ownerDocument?editor:null;}}
        onDismiss={dismissInlineRequest}
        onEdit={annotations.edit}
        onSend={sendAnnotations}
        onCancel={cancelAnnotations}
        onReveal={()=>window.hiveDesktop?.windowCommand('focus',host||undefined)}
        onRemove={annotations.remove} onFocusGlobal={id=>{setAnnotationBatch(null);setAnnotationFocus({id,nonce:Date.now()});}} onOpenGlobal={id=>{setAnnotationBatch(null);setAnnotationFocus({id,nonce:Date.now()});workspace.open('annotations');}}
        saving={annotations.saving}
        busy={busy}
        toolActive={annotationTool}
        bubblePlacement={annotationPreferences.preferences.bubblePlacement}
      />)}
      {closingWindow&&([document,...[...desktopPanels.windows.values()].map(popup=>popup.document)]).map((doc,index)=>createPortal(<div className="desktop-closing" role="status">正在保存并退出…</div>,doc.body,`closing-${index}`))}
      {appearanceSettings.appearance.floatingToolbarVisible!==false&&<GlobalToolbar mode={mode} continuationLimit={config.continuationLimit} aiOpen={chatOpen&&!desktopPanels.hiddenWindows.has('conversation')} annotationTool={annotationTool} onAnnotate={()=>{
        setAnnotationTool(active=>!active);
      }}
        onRun={runFromDock} busy={busy} onToggleAi={revealConversation}/>}
      {notice && (
        <div className="toast" role="status">
          <CheckCheck size={16} />
          {notice}
        </div>
      )}
      {error && (
        <div className="error-toast" role="alert">
          <span>{error.message}</span>
          {error.persistent&&<button type="button" className="text-button" onClick={()=>setError('')}>关闭</button>}
        </div>
      )}
      {historyOpen&&<dialog className="history-host" aria-label="历史记录" ref={node=>{if(node&&!node.open)node.showModal();}}
        onCancel={event=>{if(event.target!==event.currentTarget)return;event.preventDefault();closeHistory();}}>
        <button type="button" className="icon-button history-close" aria-label="关闭历史记录" disabled={historyBusy} onClick={closeHistory}><X size={17}/></button>
        <HistoryPage key={historyLaunch.version} initialTab={historyLaunch.tab} activeFile={currentSession?.disk?.path||''} busy={historyBusy} error={historyError||history.error}
          entries={{snapshot:history.summary.snapshots.filter(entry=>entry.file===currentSession?.disk?.path).map(entry=>({...entry,restorable:true})),
            human:history.summary.entries.filter(entry=>entry.actor==='human').map(entry=>({...entry,undoable:entry.reversible&&entry.status==='applied',redoable:entry.reversible&&entry.status==='reverted'})),
            ai:history.summary.entries.filter(entry=>entry.actor==='ai').map(entry=>({...entry,undoable:entry.reversible&&entry.status==='applied',redoable:entry.reversible&&entry.status==='reverted'}))}}
          onCreate={()=>void historyTask(async()=>{const {session,state}=historyTarget(file);await createNoteSnapshot(session,state,'human');})}
          onRestore={id=>void historyTask(()=>restoreNoteSnapshot(id))}
          onUndo={(actor,id)=>void historyTask(()=>replayHistory(actor,id,true))}
          onRedo={(actor,id)=>void historyTask(()=>replayHistory(actor,id,false))} conflict={historyConflict}/>
      </dialog>}
      {settings && <SettingsPage panelIconDragPreferences={panelIconDragPreferences} annotationPreferences={annotationPreferences} aiButtonLayout={aiButtonLayout} aiResponsePreferences={aiResponsePreferences} plugins={plugins} config={config} initialSection={settingsSection} restoreKey={settingsRestoreKey} appearance={appearanceSettings} statusPreferences={statusPreferences} busy={configBusy}
        historyLimits={history.summary.limits} onSaveHistoryLimits={async limits=>{humanHistory.flushAll();await history.setLimits(limits);}}
        onRequest={updateSettings} onProbe={(body:ModelProbeRequest,signal?:AbortSignal)=>requestApi<ModelProbeResult>(request,'/model-services/probe',body,signal)}
        onReload={async()=>{const next=await api<Config>('/config');setConfig(current=>next.revision>=current.revision?next:current);}} onClose={()=>setSettings(false)}/>}
      {recentOpen&&<FilePicker entries={recentEntries} onOpen={openRecentDocument} onClose={()=>setRecentOpen(false)}/>}
      {dialog&&(dialog.kind==='image'||dialog.kind==='table')&&dialog.target&&<EditorInsertDialog kind={dialog.kind} target={dialog.target} onClose={()=>setDialog(null)} onInserted={()=>{const target=dialog.target!;setDialog(null);if(dialog.kind==='image')void refresh().catch(error=>setError(error.message));requestAnimationFrame(()=>{if(target.valid())target.editor.focus();});inform(dialog.kind==='image'?'已插入图片。':'已插入表格。');}}/>}
      {dialog && dialog.kind!=='image'&&dialog.kind!=='table'&&dialog.kind!=='properties'&&(
        <div className="modal-backdrop">
          <form className="modal small-modal" onSubmit={submitDialog}>
            <div className="simple-modal-heading">
              <h2>{dialog.title}</h2>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭文件操作"
                onClick={() => setDialog(null)}
              >
                <X size={18} />
              </button>
            </div>
            <label>
              {dialog.kind === "folder" ? "文件夹名称" : "工作空间内的相对路径"}
              <input
                aria-label="文件路径"
                autoFocus
                value={dialog.value}
                onChange={(e) =>
                  setDialog({ ...dialog, value: e.target.value })
                }
              />
            </label>
            <p className="settings-note">
              {dialog.kind === "rename"
                ? "可填写「文件夹/文档.md」整理位置。同名文件不会被覆盖。"
                : dialog.kind === "saveAs"
                  ? "保存当前正文为新文件，同名文件不会被覆盖。"
                  : "可用「灵感收集/新想法.md」创建分组；仅处理 Markdown。"}
            </p>
            <div className="modal-footer">
              <button
                type="button"
                className="secondary-button"
                disabled={fileBusy}
                onClick={() => setDialog(null)}
              >
                取消
              </button>
              <button
                className="gold-button"
                disabled={fileBusy || !dialog.value.trim()}
              >
                {fileBusy ? "处理中…" : "确认"}
              </button>
            </div>
          </form>
        </div>
      )}
      {confirm && (
        <div className="modal-backdrop">
          <div className="modal small-modal">
            <h2>保留当前的手改？</h2>
            <p className="confirm-text">{confirm.text}</p>
            <div className="modal-footer">
              <button
                className="secondary-button"
                onClick={() => setConfirm(null)}
              >
                返回继续编辑
              </button>
              <button
                className="gold-button"
                onClick={() => {
                  const action = confirm.action;
                  setConfirm(null);
                  action();
                }}
              >
                放弃手改并继续
              </button>
            </div>
          </div>
        </div>
      )}
      {help && (
        <div className="modal-backdrop">
          <div className="modal help-modal">
            <div className="simple-modal-heading">
              <h2>从一个想法开始</h2>
              <button
                className="icon-button"
                aria-label="关闭使用指南"
                onClick={() => setHelp(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="help-step">
              <span>01</span>
              <div>
                <h3>按大纲写</h3>
                <p>
                  从顶部「面板」菜单打开独立大纲，为节点填写写作描述，悬停可查看；选择节点写作操作，按这个节点完成内容。「目录」仍可用于章节定位。
                </p>
              </div>
            </div>
            <div className="help-step">
              <span>02</span>
              <div>
                <h3>只改一小处</h3>
                <p>
                  选中正文里的词或句子，按
                  {shortcutLabel(shortcutBindings,'callAI')}。演示模式可输入：把“很清楚”改成“足够清楚”。
                </p>
              </div>
            </div>
            <div className="help-step">
              <span>03</span>
              <div>
                <h3>一小段一小段接着写</h3>
                <p>
                  把光标放在要插入的位置，选择「往下续写」图标。每轮只生成一段，字数上限可在设置中调整，等待你采纳或调整。
                </p>
              </div>
            </div>
            <div className="help-step">
              <span>04</span>
              <div>
                <h3>审阅，修改，再继续</h3>
                <p>
                  建议在正文下方预览。采纳后可撤回；目标被手改时会阻止覆盖。{shortcutLabel(shortcutBindings,'save')}
                  保存，{shortcutLabel(shortcutBindings,'find')} 查找，{shortcutLabel(shortcutBindings,'stopGeneration')} 停止请求。
                </p>
              </div>
            </div>
            <p className="settings-note">
              正文主版面始终保留，额外正文可分栏或浮动；顶部「视图 → 面板」管理面板开关，同栏可保存和应用视图。拖动工具面板标题栏，移入箭头或标签目标查看预览，松手完成分栏或合并。右上角小锁固定停靠区位置，仍可打开或收纳面板。顶部「开始」提供文字格式、对齐和查找替换；设置里可选择写作文件夹、续写字数和模型。
            </p>
            <button
              className="gold-button help-done"
              onClick={() => setHelp(false)}
            >
              开始写作
              <ArrowLeft size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
