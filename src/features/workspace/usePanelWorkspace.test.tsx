import {afterEach,describe,expect,it,vi} from 'vitest';
import type {DependencyList,EffectCallback} from 'react';
import {NativeHostRuntime,type NativeFloatOptions} from './nativeHostRuntime';
import {usePanelWorkspace} from './usePanelWorkspace';
import {defaultWorkspace,hideWorkspacePanel,type WorkspaceLayout} from './workspaceState';
import {dockedPanels,type Rect} from './panelLayout';
import * as layoutModule from './panelLayout';
import {writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// Keep the real workspace hook and native-host lifecycle. Only React scheduling
// and browser surfaces are replaced, so this checks presentation after effects.
const hooks=vi.hoisted(()=>({
  slots:[] as unknown[],cursor:0,dirty:false,effects:[] as (()=>void)[],desktop:null as unknown,
}));
vi.mock('react',async importOriginal=>({
  ...await importOriginal<typeof import('react')>(),
  useState:(initial:unknown)=>{
    const index=hooks.cursor++;
    if(!(index in hooks.slots))hooks.slots[index]=typeof initial==='function'?initial():initial;
    return [hooks.slots[index],(value:unknown)=>{
      const next=typeof value==='function'?value(hooks.slots[index]):value;
      if(!Object.is(next,hooks.slots[index])){hooks.slots[index]=next;hooks.dirty=true;}
    }];
  },
  useRef:(initial:unknown)=>{
    const index=hooks.cursor++;return hooks.slots[index]??(hooks.slots[index]={current:initial});
  },
  useMemo:(create:()=>unknown,deps:DependencyList)=>{
    const index=hooks.cursor++,previous=hooks.slots[index] as {deps:DependencyList;value:unknown}|undefined;
    if(previous&&deps.length===previous.deps.length&&deps.every((value,i)=>Object.is(value,previous.deps[i])))return previous.value;
    const value=create();hooks.slots[index]={deps,value};return value;
  },
  useEffect:(create:EffectCallback,deps?:DependencyList)=>{
    const index=hooks.cursor++,previous=hooks.slots[index] as {deps?:DependencyList;cleanup?:()=>void}|undefined;
    if(previous&&deps&&previous.deps&&deps.length===previous.deps.length&&deps.every((value,i)=>Object.is(value,previous.deps![i])))return;
    const slot={deps,cleanup:undefined as (()=>void)|undefined};hooks.slots[index]=slot;
    hooks.effects.push(()=>{previous?.cleanup?.();slot.cleanup=create()||undefined;});
  },
}));
vi.mock('./DesktopPanels',()=>({useDesktopPanels:()=>hooks.desktop}));
vi.mock('./useNativePanelDocking',()=>({useNativePanelDocking:()=>{}}));
vi.mock('./DockGuides',()=>({default:()=>null}));

const rect:Rect={x:80,y:180,width:300,height:460};
function fixture(enabled=true,implementation=usePanelWorkspace){
  Object.assign(hooks,{slots:[],cursor:0,dirty:true,effects:[]});
  vi.stubGlobal('window',{innerWidth:1280,innerHeight:900,screenX:0,screenY:0,focus:vi.fn(),addEventListener:vi.fn(),removeEventListener:vi.fn(),hiveDesktop:{closePanel:vi.fn(),windowCommand:vi.fn(),panelRect:()=>({...rect})}});
  vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn()});
  let measure=()=>{};
  vi.stubGlobal('ResizeObserver',class{constructor(callback:()=>void){measure=callback;}observe(){}disconnect(){}});
  const runtime=new NativeHostRuntime(()=>{desktop.windows=runtime.windows();hooks.dirty=true;},vi.fn());
  for(const id of ['files','repositories','trash','conversation','outline','scratch'])runtime.handles.set(id,{mount:vi.fn(),home:vi.fn(),active:vi.fn(),title:()=>id,dirty:()=>true,focus:vi.fn(),isComposing:()=>false});
  let hostNumber=0;
  const connect=(id:string,members:string[],options:NativeFloatOptions={},group=false)=>{
    if(runtime.registry.get(id))return;
    const host=group?`native-group:test-${++hostNumber}`:id;
    runtime.registry.create(host,members,id,{child:{closed:false,screenX:rect.x,screenY:rect.y,outerWidth:rect.width,outerHeight:rect.height,document:{title:id}} as unknown as Window,stage:{} as HTMLElement,connected:true,select:vi.fn(),options,cleanup:vi.fn()},group);
    desktop.windows=runtime.windows();hooks.dirty=true;options.onReady?.();
  };
  const desktop={enabled,windows:runtime.windows(),hiddenWindows:new Set<string>(),
    rect:(id:string)=>runtime.rect(id),lastRect:(id:string)=>runtime.lastRects.get(id)||null,
    members:(id:string)=>runtime.registry.get(id)?.members,owner:(id:string)=>runtime.registry.owner(id),panelForHost:(id:string)=>runtime.registry.get(id)?.active||id,
    attach:vi.fn((id:string)=>runtime.close(id)),removeMember:vi.fn((id:string)=>runtime.removeMember(id)),returnMembers:vi.fn((ids:readonly string[])=>runtime.returnMembers(ids)),
    detach:vi.fn((id:string,options?:NativeFloatOptions)=>connect(id,[id],options)),
    reveal:vi.fn((id:string)=>runtime.open(id)),
    detachGroup:vi.fn((id:string,members:string[],_select:unknown,options?:NativeFloatOptions)=>connect(id,members,options,true)),
    isComposing:()=>runtime.composing([...runtime.handles.keys()]),
  };
  hooks.desktop=desktop;
  const stage:{current:HTMLDivElement|null}={current:null};let workspace:ReturnType<typeof usePanelWorkspace>;
  const flush=()=>{
    for(let pass=0;pass<20;pass++){
      hooks.cursor=0;hooks.dirty=false;hooks.effects=[];workspace=implementation(stage);
      for(const effect of hooks.effects)effect();
      if(!hooks.dirty)return workspace;
    }
    throw new Error('workspace effects did not settle');
  };
  const act=(action:(value:ReturnType<typeof usePanelWorkspace>)=>void)=>{action(workspace);return flush();};
  flush();
  return {runtime,desktop,connect,flush,act,resize:(area:Rect)=>{stage.current={getBoundingClientRect:()=>area} as HTMLDivElement;measure();return flush();},get workspace(){return workspace;}};
}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

const floatingTools=():WorkspaceLayout=>({...defaultWorkspace(),open:['editor','files','trash'],floatingGroups:[{type:'group',id:'tools',panels:['files','trash'],active:'files'}]});
if(process.env.HIVE_WORKSPACE_BENCHMARK){
  it('compares unchanged workspace renders with the frozen 0.1.3 source',async()=>{
    const baselinePath=fileURLToPath(new URL('../../../performance/baselines/0.1.3/src/features/workspace/',import.meta.url)).replaceAll('\\','/');
    vi.doMock(baselinePath+'DesktopPanels.tsx',()=>({useDesktopPanels:()=>hooks.desktop}));
    vi.doMock(baselinePath+'useNativePanelDocking.ts',()=>({useNativePanelDocking:()=>{}}));
    vi.doMock(baselinePath+'DockGuides.tsx',()=>({default:()=>null}));
    const baseline=await import(baselinePath+'usePanelWorkspace.tsx');
    const oldLayout=await import(baselinePath+'panelLayout.ts');
    const results=[];
    for(const [variant,implementation,geometry] of [['baseline',baseline.usePanelWorkspace,oldLayout],['candidate',usePanelWorkspace,layoutModule]] as const){
      for(const scenario of ['single','multiple','grouped'] as const){
        const f=fixture(true,implementation as unknown as typeof usePanelWorkspace);
        if(scenario==='single')f.act(w=>w.restoreLayout({...defaultWorkspace(),open:['editor'],tree:{type:'panel',panel:'editor'}}));
        if(scenario==='multiple')for(const id of ['trash','outline','scratch','search','toc'])f.act(w=>w.open(id));
        if(scenario==='grouped')f.act(w=>w.restoreLayout(floatingTools()));
        const measurement=vi.spyOn(geometry,'measureDockTree'),samples=[];
        for(let warmup=0;warmup<200;warmup++)f.flush();measurement.mockClear();
        for(let sample=0;sample<7;sample++){const started=performance.now();for(let render=0;render<1000;render++)f.flush();samples.push(performance.now()-started);}
        results.push({variant,scenario,renders:7000,geometryCalls:measurement.mock.calls.length,sampleMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[3]});measurement.mockRestore();
      }
    }
    mkdirSync('performance/results',{recursive:true});writeFileSync('performance/results/workspace-renders.json',JSON.stringify({method:'Mocked React scheduling, real hook/layout/runtime; 7 batches of 1000 unchanged renders; excludes real React, DOM, IPC and desktop frame time.',results},null,2));
    console.log(JSON.stringify(results.map(({sampleMs,...result})=>result)));
  });
}
describe('unified native presentation transitions',()=>{
  it('raises a docked conversation without changing its layout and focuses the main shell',()=>{
    const f=fixture();
    const before=f.workspace.capture();
    f.act(w=>w.reveal('conversation'));
    expect(f.workspace.capture()).toEqual(before);
    expect(f.workspace.panel('conversation').style.zIndex).toBeGreaterThan(100);
    expect(window.hiveDesktop?.windowCommand).toHaveBeenLastCalledWith('focus');
    f.act(w=>w.reveal('conversation'));
    expect(f.workspace.isOpen('conversation')).toBe(true);
    f.act(w=>w.panel('files').raise());
    expect(f.workspace.panel('conversation').style.zIndex).toBe(1);
  });
  it('focuses an existing native conversation host without detaching again',()=>{
    const f=fixture();
    f.act(w=>w.floatNativePanel('conversation'));
    const host=f.runtime.registry.get('conversation')!;
    const opened=f.desktop.detach.mock.calls.length;
    f.act(w=>w.reveal('conversation'));
    expect(f.runtime.registry.get('conversation')).toBe(host);
    expect(f.desktop.detach.mock.calls.length).toBe(opened);
    expect(f.desktop.reveal).toHaveBeenCalledWith('conversation');
    expect(window.hiveDesktop?.windowCommand).toHaveBeenLastCalledWith('focus',host.id);
  });
  it('opens repository management in a wide native host and preserves the standard shelf and return transitions',()=>{
    const f=fixture();f.act(w=>w.open('repositories'));
    expect(f.desktop.windows.has('repositories')).toBe(true);expect(f.workspace.isOpen('repositories')).toBe(true);
    expect(f.workspace.capture().rects.repositories?.width||f.runtime.lastRects.get('repositories')?.width||f.desktop.detach.mock.calls.at(-1)?.[1]?.rect?.().width).toBeGreaterThan(700);
    f.act(w=>w.minimize('repositories'));expect(f.desktop.windows.has('repositories')).toBe(false);expect(f.workspace.autoHideItems.some(item=>item.id==='repositories')).toBe(true);
    f.act(w=>w.open('repositories'));expect(f.desktop.windows.has('repositories')).toBe(true);
    f.act(w=>w.openDocked('repositories'));expect(f.desktop.windows.has('repositories')).toBe(false);expect(f.workspace.panel('repositories').visible).toBe(true);
    f.act(w=>w.close('repositories'));expect(f.workspace.isOpen('repositories')).toBe(false);
  });
  it.each([1,17,491,20261117])('survives 2000 seeded mixed operations without an unreachable panel (seed %s)',seed=>{
    const f=fixture(),ids=['files','trash','conversation','outline','scratch'];let value=seed;
    const random=()=>{value^=value<<13;value^=value>>>17;value^=value<<5;return value>>>0;};
    for(let step=0;step<2000;step++){
      const id=ids[random()%ids.length],command=random()%8;
      f.act(w=>{if(command===0)w.open(id);else if(command===1)w.close(id);else if(command===2)w.minimize(id);else if(command===3)w.floatNativePanel(id);else if(command===4)w.openDocked(id);else if(command===5)w.dockAutoHideRail(random()%2?'left':'right',280);else if(command===6)w.returnNativePanel(id);else w.toggle(id);});
      const layout=f.workspace.capture();
      for(const member of ids){
        const native=f.desktop.windows.has(member),main=f.workspace.panel(member).visible,group=f.workspace.tabGroups.find(group=>group.panels.includes(member));
        expect(native&&main,`seed=${seed} step=${step} panel=${member} duplicated`).toBe(false);
        if(layout.open.includes(member))expect(native||main||group&&group.active!==member,`seed=${seed} step=${step} panel=${member} unreachable`).toBeTruthy();
        else expect(native||main,`seed=${seed} step=${step} panel=${member} resurrected`).toBe(false);
      }
      const allMembers=f.runtime.registry.values().flatMap(host=>host.members);expect(new Set(allMembers).size).toBe(allMembers.length);
    }
  });
  it.each(['docked','floating','shelved','closed'].flatMap(from=>['dock','float','minimize','close'].map(to=>[from,to] as const)))('keeps one reachable presentation for %s → %s',(from,to)=>{
    const f=fixture();
    if(from==='floating')f.act(w=>w.floatNativePanel('files'));
    if(from==='shelved')f.act(w=>w.minimize('files'));
    if(from==='closed')f.act(w=>w.close('files'));
    f.act(w=>to==='dock'?w.openDocked('files'):to==='float'?w.floatNativePanel('files'):to==='minimize'?w.minimize('files'):w.close('files'));
    const native=f.desktop.windows.has('files'),main=f.workspace.panel('files').visible,icon=f.workspace.autoHideItems.some(item=>item.id==='files');
    expect(Number(native)+Number(main)).toBe(to==='dock'||to==='float'?1:0);
    expect(f.workspace.isOpen('files')).toBe(to==='dock'||to==='float');
    if(to==='dock')expect(icon).toBe(false);if(to==='minimize')expect(icon).toBe(true);if(to==='close')expect(icon).toBe(false);
  });
  it('docks a native group through a single coordinated migration',()=>{
    const f=fixture();f.act(w=>w.restoreLayout(floatingTools()));f.act(w=>w.groupDock('files'));
    expect(f.desktop.windows.size).toBe(0);expect(f.workspace.tabGroups.find(group=>group.panels.includes('files'))?.panels).toEqual(['files','trash']);
  });
  it('reuses geometry during unrelated renders and invalidates it on layout and bounds changes',()=>{
    const f=fixture(),measurement=vi.spyOn(layoutModule,'measureDockTree');
    for(let i=0;i<100;i++)f.flush();expect(measurement).not.toHaveBeenCalled();
    f.act(w=>w.minimize('files'));expect(measurement).toHaveBeenCalled();measurement.mockClear();
    const before=f.workspace.panel('editor').style.width;f.resize({x:0,y:160,width:800,height:600});
    expect(measurement).toHaveBeenCalled();expect(f.workspace.panel('editor').style.width).not.toBe(before);
  });
  it('keeps the fixed primary editor protected at the native floating entry',()=>{
    const f=fixture();f.act(w=>w.floatNativePanel('editor'));expect(f.desktop.detach).not.toHaveBeenCalled();expect(f.workspace.panel('editor').visible).toBe(true);
  });
  it('returns a floating member through the open-docked menu without losing its visible container',()=>{
    const f=fixture();f.act(w=>w.floatNativePanel('files'));expect(f.desktop.windows.has('files')).toBe(true);
    f.act(w=>w.openDocked('files'));
    expect(f.desktop.windows.has('files')).toBe(false);expect(f.workspace.panel('files').visible).toBe(true);
    expect(dockedPanels(f.workspace.capture().tree)).toContain('files');
  });
  it.each(['close','minimize'] as const)('keeps the other member hosted when the current member is %s',command=>{
    const f=fixture();f.act(w=>w.restoreLayout(floatingTools()));const host=f.runtime.registry.get('trash')!;
    f.act(w=>w[command]('files'));
    expect(f.workspace.isOpen('files')).toBe(false);expect(f.workspace.isOpen('trash')).toBe(true);
    expect(f.runtime.registry.get('trash')).toBe(host);expect(host.members).toEqual(['trash']);expect(host.resource.cleanup).not.toHaveBeenCalled();
    expect(f.workspace.autoHideItems.some(item=>item.id==='files')).toBe(command==='minimize');
  });
  it('replaces native ownership when applying a docked view',()=>{
    const f=fixture();f.act(w=>w.restoreLayout(floatingTools()));f.act(w=>w.restoreLayout(defaultWorkspace()));
    expect(f.desktop.windows.size).toBe(0);expect(f.workspace.panel('files').visible).toBe(true);
    expect(f.workspace.capture().floatingGroups).toEqual([]);
  });
  it('rejects a view replacement during composition without changing either host or layout',()=>{
    const f=fixture();f.act(w=>w.restoreLayout(floatingTools()));const before=f.workspace.capture();
    f.runtime.handles.get('trash')!.isComposing=()=>true;
    expect(()=>f.act(w=>w.restoreLayout(defaultWorkspace()))).toThrow('输入法组词');
    f.flush();expect(f.workspace.capture()).toEqual(before);expect(f.desktop.windows.size).toBe(2);
  });
  it.each(['close','minimize','dock'] as const)('ignores a late open failure after %s',command=>{
    const f=fixture(),requests:NativeFloatOptions[]=[];f.desktop.detach.mockImplementation((_id,options)=>{requests.push(options!);});
    f.act(w=>w.floatNativePanel('files'));expect(requests).toHaveLength(1);
    f.act(w=>command==='dock'?w.openDocked('files'):w[command]('files'));
    const after=f.workspace.capture();requests[0].onFailure?.();f.flush();expect(f.workspace.capture()).toEqual(after);
    expect(f.workspace.isOpen('files')).toBe(command==='dock');
  });
  it('ignores old failure and ready callbacks while a newer request is connecting',()=>{
    const f=fixture(),requests:NativeFloatOptions[]=[];f.desktop.detach.mockImplementation((_id,options)=>{requests.push(options!);});
    f.act(w=>w.floatNativePanel('files'));f.act(w=>w.close('files'));f.act(w=>w.floatNativePanel('files'));
    const before=f.workspace.capture();requests[0].onFailure?.();requests[0].onReady?.();f.flush();
    expect(f.workspace.capture()).toEqual(before);f.connect('files',['files'],requests[1]);f.flush();
    expect(f.desktop.windows.has('files')).toBe(true);expect(f.workspace.isOpen('files')).toBe(true);
  });
  it('returns an unsuccessful open to a visible docked host',()=>{
    const f=fixture(),requests:NativeFloatOptions[]=[];f.desktop.detach.mockImplementation((_id,options)=>{requests.push(options!);});
    f.act(w=>w.floatNativePanel('files'));requests[0].onFailure?.();f.flush();
    expect(f.workspace.panel('files').visible).toBe(true);expect(dockedPanels(f.workspace.capture().tree)).toContain('files');
  });
  it('does not resurrect a removed member when the remaining connecting group fails',()=>{
    const f=fixture(),requests:NativeFloatOptions[]=[];f.desktop.detachGroup.mockImplementation((_id,_members,_select,options)=>{requests.push(options!);});
    f.act(w=>w.restoreLayout(floatingTools()));f.act(w=>w.close('files'));requests[0].onFailure?.();f.flush();
    expect(f.workspace.isOpen('files')).toBe(false);expect(f.workspace.panel('trash').visible).toBe(true);
    expect(f.workspace.capture().floatingGroups).toEqual([]);
  });
  it('invalidates a connecting open before resetting the workspace',()=>{
    const f=fixture(),requests:NativeFloatOptions[]=[];f.desktop.detach.mockImplementation((_id,options)=>{requests.push(options!);});
    f.act(w=>w.floatNativePanel('files'));f.act(w=>w.reset());const after=f.workspace.capture();
    requests[0].onFailure?.();f.flush();expect(f.workspace.capture()).toEqual(after);expect(f.workspace.panel('files').visible).toBe(true);
  });
});

describe('pulling native shelf panels back into the workspace',()=>{
  it('reopens a docked panel inside the main window through repeated shelf cycles',()=>{
    const f=fixture();
    for(let cycle=0;cycle<3;cycle++){
      f.act(w=>w.minimize('files'));expect(f.workspace.capture().autoHide?.files.host).toBe('main');
      f.act(w=>w.toggleAutoHide('files'));
      expect(f.workspace.panel('files').visible).toBe(true);expect(f.desktop.windows.has('files')).toBe(false);expect(f.workspace.capture().autoHideActive).toBe('files');
      f.act(w=>w.toggleAutoHide('files'));expect(f.workspace.panel('files').visible).toBe(false);
      f.act(w=>w.toggleAutoHide('files'));
    }
    expect(f.desktop.detach).not.toHaveBeenCalled();
  });
  it('restores main-window shelves from saved layouts including legacy layouts without a host tag',()=>{
    const first=fixture();first.act(w=>w.open('trash'));first.act(w=>w.minimize('files'));first.act(w=>w.minimize('trash'));
    const saved=first.workspace.capture();
    for(const legacy of [false,true]){
      const layout=structuredClone(saved);if(legacy)for(const placement of Object.values(layout.autoHide||{}))delete placement.host;
      const f=fixture();f.act(w=>w.restoreLayout(layout));
      for(const id of ['files','trash']){f.act(w=>w.toggleAutoHide(id));expect(f.workspace.panel(id).visible).toBe(true);expect(f.desktop.windows.has(id)).toBe(false);}
      expect(f.desktop.detach).not.toHaveBeenCalled();
    }
  });
  it('retains a native shelf host after saving and restoring its layout',()=>{
    const first=fixture();first.act(w=>w.floatNativePanel('files'));first.act(w=>w.minimize('files'));const saved=first.workspace.capture();
    expect(saved.autoHide?.files.host).toBe('native');
    const f=fixture();f.act(w=>w.restoreLayout(saved));f.act(w=>w.toggleAutoHide('files'));
    expect(f.desktop.windows.has('files')).toBe(true);expect(f.runtime.handles.get('files')?.dirty()).toBe(true);
  });
  it('keeps ordinary minimized panels visible when their rail is pulled',()=>{
    const f=fixture();f.act(w=>w.minimize('files'));f.act(w=>w.dockAutoHideRail('left',280));
    expect(f.workspace.panel('files').visible).toBe(true);expect(f.workspace.autoHideItems).toEqual([]);
  });
  it('shows a panel after opening its icon, minimizing its native window, and pulling the rail',()=>{
    const f=fixture();f.act(w=>w.floatNativePanel('files'));f.act(w=>w.minimize('files'));f.act(w=>w.toggleAutoHide('files'));
    expect(f.desktop.windows.has('files')).toBe(true);
    f.act(w=>w.minimize('files'));expect(f.desktop.windows.has('files')).toBe(false);
    f.act(w=>w.dockAutoHideRail('left',280));
    expect(f.workspace.openIds).toContain('files');expect(dockedPanels(f.workspace.capture().tree)).toContain('files');
    expect(f.workspace.panel('files').visible).toBe(true);expect(f.workspace.autoHideItems).toEqual([]);
    expect(f.desktop.windows.has('files')).toBe(false);expect(f.desktop.detach).toHaveBeenCalledTimes(2);
  });
  it.each(['left','right'] as const)('returns an open native panel before docking the %s rail',edge=>{
    const f=fixture();f.act(w=>w.floatNativePanel('files'));f.act(w=>w.minimize('files'));f.act(w=>w.repositionAutoHide('files',.25,edge));f.act(w=>w.toggleAutoHide('files'));
    const handle=f.runtime.handles.get('files')!,homeCalls=vi.mocked(handle.home).mock.calls.length;
    f.act(w=>w.dockAutoHideRail(edge,280));
    expect(f.workspace.panel('files').visible).toBe(true);expect(f.desktop.windows.has('files')).toBe(false);
    expect(handle.home).toHaveBeenCalledTimes(homeCalls+1);expect(f.runtime.handles.get('files')).toBe(handle);
  });
  it('keeps both sidebar tabs reachable after multiple native windows have been shelved',()=>{
    const f=fixture();f.act(w=>w.open('trash'));f.act(w=>w.minimize('files'));f.act(w=>w.minimize('trash'));
    for(const id of ['files','trash']){f.act(w=>w.floatNativePanel(id));f.act(w=>w.minimize(id));}
    f.act(w=>w.dockAutoHideRail('left',280));
    expect(f.workspace.tabGroups.find(group=>group.panels.includes('files'))?.panels).toEqual(['files','trash']);
    for(const id of ['files','trash']){f.act(w=>w.open(id));expect(f.workspace.panel(id).visible).toBe(true);}
    expect(f.desktop.windows.size).toBe(0);expect(f.workspace.autoHideItems).toEqual([]);expect(f.desktop.detach).toHaveBeenCalledTimes(2);
  });
  it('removes a pending native open when the rail is pulled before connection',()=>{
    const f=fixture();f.act(w=>w.minimize('files'));
    f.act(w=>{w.toggleAutoHide('files');w.dockAutoHideRail('left',280);});
    expect(f.workspace.panel('files').visible).toBe(true);expect(f.desktop.detach).not.toHaveBeenCalled();
  });
  it('extracts only the selected rail member and leaves the other native group member open',()=>{
    const f=fixture();let layout:WorkspaceLayout=defaultWorkspace();
    layout=hideWorkspacePanel(layout,'files',rect,true,{edge:'left',offset:.25,rect});
    layout=hideWorkspacePanel(layout,'conversation',rect,true,{edge:'right',offset:.25,rect});
    layout={...layout,open:[...layout.open,'files','conversation'],minimized:[],floatingGroups:[{type:'group',id:'tools',panels:['files','conversation'],active:'files'}]};
    f.act(w=>w.restoreLayout(layout));expect(f.desktop.windows.size).toBe(2);
    const source=f.runtime.registry.get('conversation')!;
    f.act(w=>w.dockAutoHideRail('left',280));
    expect(f.workspace.panel('files').visible).toBe(true);expect(f.desktop.windows.has('files')).toBe(false);
    expect(f.runtime.registry.get('conversation')).toBe(source);expect(source.members).toEqual(['conversation']);expect(source.resource.cleanup).not.toHaveBeenCalled();
    expect(f.workspace.autoHideItems.map(item=>item.id)).toEqual(['conversation']);
  });
  it.each(['composing','locked','invalid width','return rejected'] as const)('preserves the shelf when %s prevents the transition',reason=>{
    const f=fixture();f.act(w=>w.floatNativePanel('files'));f.act(w=>w.minimize('files'));f.act(w=>w.toggleAutoHide('files'));
    if(reason==='composing')f.runtime.handles.get('files')!.isComposing=()=>true;
    if(reason==='locked')f.act(w=>w.toggleLocked());
    if(reason==='return rejected')f.desktop.returnMembers.mockReturnValue(false);
    const before=f.workspace.capture();f.act(w=>w.dockAutoHideRail('left',reason==='invalid width'?NaN:280));
    expect(f.workspace.capture()).toEqual(before);expect(f.desktop.windows.has('files')).toBe(true);
    expect(f.workspace.autoHideItems.map(item=>item.id)).toEqual(['files']);
  });
  it('preserves browser-only rail expansion',()=>{
    const f=fixture(false);f.act(w=>w.minimize('files'));f.act(w=>w.dockAutoHideRail('left',280));
    expect(f.workspace.panel('files').visible).toBe(true);expect(f.desktop.removeMember).not.toHaveBeenCalled();
  });
});
