import {z} from 'zod';
import type {Mode} from '../../shared/core';
import {detachWorkspacePanel,type WorkspaceLayout} from './workspaceState';
import {trashPreviewTabPrefix} from '../editor/editorSessionTypes';
import {dockedPanels,type DockTree} from './panelLayout';
import type {Appearance} from '../settings/useAppearance';
import type {EditorDisplayMode} from '../editor/splitView';
import {normalizeStatus,type StatusKey,type CountMode} from '../editor/statusModel';

export type ViewEditor={id:string;file:string|null;anchor:number;head:number;scrollTop:number;scrollLeft?:number;imagePath?:string;typewriter?:boolean;displayMode?:EditorDisplayMode;landing?:boolean};
// A saved blank tab must never reuse an untitled manuscript buffer.
export function matchesViewEditor(session:{disk:{path:string}|null;landing?:boolean;imagePath?:string;trashPreview?:unknown},descriptor:ViewEditor){
  return !session.trashPreview&&(session.disk?.path||null)===descriptor.file&&!!session.landing===!!descriptor.landing&&(session.imagePath||null)===(descriptor.imagePath||null);
}

export function omitTrashPreviewTabs(layout:WorkspaceLayout):WorkspaceLayout {
  const regular=(id:string)=>!id.startsWith(trashPreviewTabPrefix);
  const without= <T,>(entries:Record<string,T>)=>Object.fromEntries(Object.entries(entries).filter(([id])=>regular(id)));
  let next=layout;
  const visible=new Set([...layout.open,...layout.minimized,...dockedPanels(layout.tree),...layout.floatingGroups.flatMap(group=>group.panels)]);
  for(const id of visible)if(!regular(id))next=detachWorkspacePanel(next,id);
  const restore=Object.fromEntries(Object.entries(without(next.restore)).flatMap(([id,anchor])=>regular(anchor.target)?
    [[id,anchor.split?{...anchor,split:{...anchor.split,siblings:anchor.split.siblings.filter(regular)}}:anchor]]:[]));
  return {...next,open:next.open.filter(regular),minimized:next.minimized.filter(regular),rects:without(next.rects),layers:without(next.layers),restore,
    ...(next.lockedPanels?{lockedPanels:next.lockedPanels.filter(regular)}:{}),
    ...(next.autoHide?{autoHide:without(next.autoHide)}:{}),
    ...(next.autoHideActive&&!regular(next.autoHideActive)?{autoHideActive:null}:{}),
  };
}
export type ViewSnapshot={layout:WorkspaceLayout;editors:ViewEditor[];activeEditor:string;appearance:Appearance;statusItems:StatusKey[];statusCountMode?:CountMode;filter:string;collapsed:string[];chatOrb:boolean;orbPosition?:{x:number;y:number};orbBounds:{width:number;height:number}};
export type ViewPreset=ViewSnapshot&{id:string;name:string;mode:Mode;updatedAt:string};
export type ViewCollection={version:1;views:ViewPreset[]};
const id=z.string().min(1).max(160).refine(value=>!['__proto__','prototype','constructor'].includes(value));
const finite=z.number().finite(),point=z.object({x:finite,y:finite});
const rect=point.extend({width:finite.positive(),height:finite.positive()});
const group=z.object({type:z.literal('group'),id,panels:z.array(id).min(2).max(64),active:id});
const tree:z.ZodType<DockTree>=z.lazy(()=>z.union([z.object({type:z.literal('panel'),panel:id}),group,z.object({type:z.literal('split'),id,axis:z.enum(['x','y']),ratio:finite.min(.12).max(.88),a:tree,b:tree})]));
const restore=z.object({target:id,edge:z.enum(['left','right','top','bottom','center']),split:z.object({id,axis:z.enum(['x','y']),ratio:finite.min(.12).max(.88),siblings:z.array(id).max(64),ancestors:z.array(z.object({id,side:z.enum(['a','b'])})).max(64)}).optional()});
const layout=z.object({locked:z.boolean().optional(),lockedPanels:z.array(id).max(64).optional(),tree:tree.nullable(),open:z.array(id).max(64),minimized:z.array(id).max(64),rects:z.record(id,rect),layers:z.record(id,finite),floatingGroups:z.array(group.extend({content:tree.optional()})).max(32),restore:z.record(id,restore),autoHide:z.record(id,z.object({edge:z.enum(['left','right','top','bottom']),offset:finite.min(0).max(1),rect,host:z.enum(['main','native']).optional()})).optional(),autoHideActive:id.nullable().optional()});
const editor=z.object({id:id.refine(value=>value==='editor'||/^editor:[\w-]+$/.test(value)),file:z.string().min(1).max(1500).nullable(),anchor:finite.int().nonnegative(),head:finite.int().nonnegative(),scrollTop:finite.nonnegative(),scrollLeft:finite.nonnegative().optional(),typewriter:z.boolean().optional(),displayMode:z.enum(['live','preview','source','split']).optional(),landing:z.boolean().optional(),imagePath:z.string().min(1).max(1500).regex(/\.(png|jpe?g|gif|webp)$/i).optional()}).refine(value=>(!value.landing||value.file===null)&&(!value.imagePath||value.file===null&&!value.landing));
const preset=z.object({id,name:z.string().trim().min(1).max(80),mode:z.enum(['discuss','outline','edit','continue']),updatedAt:z.string().datetime(),layout,editors:z.array(editor).min(1).max(48),activeEditor:id,
  appearance:z.object({version:z.literal(1),uiScale:finite.min(80).max(150),textScale:finite.min(80).max(160),editorSize:finite.min(10).max(36),ribbonVisible:z.boolean().default(true),ribbonCollapsed:z.boolean().default(false),floatingToolbarVisible:z.boolean().default(true),panelLockGesture:z.enum(['doubleClick','longPress']).default('doubleClick'),splitOrder:z.enum(['source-first','semantic-first']).default('source-first')}),statusItems:z.array(z.string()).max(16),statusCountMode:z.enum(['characters','text']).optional(),filter:z.string().max(1000),collapsed:z.array(z.string().max(1500)).max(1000),chatOrb:z.boolean(),orbPosition:point.optional(),orbBounds:z.object({width:finite.positive(),height:finite.positive()})});
function depthSafe(value:unknown,depth=0):boolean {
  if(depth>36)return false;
  if(value&&typeof value==='object')return Object.values(value).every(item=>depthSafe(item,depth+1));
  return true;
}
export function parseViewCollection(raw:string|null):ViewCollection {
  if(!raw)return {version:1,views:[]};
  if(raw.length>2_000_000)throw new Error('保存的视图数据过大，暂时无法读取。');
  let input:unknown;try{input=JSON.parse(raw);}catch{throw new Error('保存的视图数据无法读取，已保留原记录。');}
  if(!depthSafe(input))throw new Error('保存的视图结构过深。');
  const result=z.object({version:z.literal(1),views:z.array(preset).max(128)}).safeParse(input);
  if(!result.success)throw new Error('保存的视图格式无效，已保留原记录。');
  const viewIds=new Set<string>();
  for(const view of result.data.views){
    const editors=new Set(view.editors.map(item=>item.id)),known=new Set(['files','repositories','conversation','outline','toc','scratch','annotations','basis','properties','search','trash',...editors]);
    if(viewIds.has(view.id)||editors.size!==view.editors.length||!editors.has(view.activeEditor))throw new Error('保存的视图包含重复或缺失的编辑区。');
    viewIds.add(view.id);
    const active=[...dockedPanels(view.layout.tree),...view.layout.floatingGroups.flatMap(item=>item.panels)];
    const unique=(ids:string[])=>new Set(ids).size===ids.length;
    if(!unique(active)||!unique(view.layout.open)||!unique(view.layout.minimized)||view.layout.open.some(value=>!known.has(value))||view.layout.minimized.some(value=>!known.has(value)||view.layout.open.includes(value))||active.some(value=>!view.layout.open.includes(value)))throw new Error('保存的视图面板状态无效。');
    if((view.layout.lockedPanels||[]).some(value=>!known.has(value))||!unique(view.layout.lockedPanels||[]))throw new Error('保存的面板位置锁无效。');
    if(Object.keys(view.layout.autoHide||{}).some(id=>!known.has(id)||(!view.layout.open.includes(id)&&!view.layout.minimized.includes(id))))throw new Error('保存的收纳图标无效。');
    if(view.layout.autoHideActive&&(!view.layout.autoHide?.[view.layout.autoHideActive]||!view.layout.open.includes(view.layout.autoHideActive)))throw new Error('保存的展开面板无效。');
    const checkGroups=(node:DockTree|null):boolean=>!node||node.type==='panel'||(node.type==='group'?node.panels.includes(node.active):checkGroups(node.a)&&checkGroups(node.b));
    for(const host of view.layout.floatingGroups){
      if(!host.content)continue;
      const members=dockedPanels(host.content);
      if(!checkGroups(host.content)||!unique(members)||members.length!==host.panels.length||members.some(id=>!host.panels.includes(id)))throw new Error('浮窗分栏与保存的面板不一致。');
    }
    if(!checkGroups(view.layout.tree)||view.layout.floatingGroups.some(item=>!item.panels.includes(item.active)))throw new Error('保存的标签页状态无效。');
  }
  return {version:1,views:result.data.views.map(view=>({...view,statusItems:normalizeStatus(view.statusItems)}))};
}
export function remapViewLayout(layout:WorkspaceLayout,mapping:Map<string,string>):WorkspaceLayout {
  const panel=(value:string)=>mapping.get(value)||value;
  const node=(value:DockTree|null):DockTree|null=>!value?null:value.type==='panel'?{...value,panel:panel(value.panel)}:value.type==='group'?{...value,panels:value.panels.map(panel),active:panel(value.active)}:{...value,a:node(value.a)!,b:node(value.b)!};
  return {...structuredClone(layout),lockedPanels:layout.lockedPanels?.map(panel),
    ...(layout.autoHide?{autoHide:Object.fromEntries(Object.entries(layout.autoHide).map(([key,value])=>[panel(key),{...value,rect:{...value.rect}}]))}:{}),
    ...(layout.autoHideActive!==undefined?{autoHideActive:layout.autoHideActive?panel(layout.autoHideActive):null}:{}),tree:node(layout.tree),open:layout.open.map(panel),minimized:layout.minimized.map(panel),floatingGroups:layout.floatingGroups.map(group=>({...group,panels:group.panels.map(panel),active:panel(group.active),...(group.content?{content:node(group.content)!}:{})})),
    rects:Object.fromEntries(Object.entries(layout.rects).map(([key,value])=>[panel(key),{...value}])),layers:Object.fromEntries(Object.entries(layout.layers).map(([key,value])=>[panel(key),value])),
    restore:Object.fromEntries(Object.entries(layout.restore).map(([key,value])=>[panel(key),{...value,target:panel(value.target),split:value.split?{...value.split,siblings:value.split.siblings.map(panel),ancestors:value.split.ancestors.map(item=>({...item}))}:undefined}]))};
}
