import {describe,it,expect} from 'vitest';
import {defaultWorkspace,hideWorkspacePanel,placeWorkspacePanel} from './workspaceState';
import {matchesViewEditor,omitTrashPreviewTabs,parseViewCollection,remapViewLayout,type ViewPreset} from './viewPresets';
import {defaultAppearance} from '../settings/useAppearance';
import {defaultStatus} from '../editor/EditorStatusBar';
const rect={x:100,y:200,width:450,height:400};
function sample():ViewPreset {
  let layout=placeWorkspacePanel(defaultWorkspace(),'outline','editor','center',rect);
  layout=hideWorkspacePanel(layout,'files',rect,true);
  return {id:'sample',name:'写作视图',mode:'discuss',updatedAt:'2026-11-15T12:00:00.000Z',layout,
    editors:[{id:'editor',file:'正文.md',anchor:8,head:10,scrollTop:300}],activeEditor:'editor',appearance:{...defaultAppearance},statusItems:[...defaultStatus],filter:'正文',collapsed:['资料'],chatOrb:false,orbBounds:{width:344,height:520}};
}
const encode=(view:ViewPreset)=>JSON.stringify({version:1,views:[view]});
describe('saved views',()=>{
  it('retains the repository management panel and its position lock in saved views',()=>{
    const view=sample();view.layout.open.push('repositories');view.layout.rects.repositories=rect;view.layout.lockedPanels=['repositories'];
    const saved=parseViewCollection(encode(view)).views[0];
    expect(saved.layout.open).toContain('repositories');expect(saved.layout.lockedPanels).toEqual(['repositories']);
  });
  it('accepts a trash panel in saved layouts with independent locks',()=>{
    const view=sample();view.layout.open.push('trash');view.layout.rects.trash=rect;view.layout.lockedPanels=['trash'];
    expect(parseViewCollection(encode(view)).views[0].layout.open).toContain('trash');
  });
  it('keeps panel locks and the chosen gesture in views, including editor id remapping',()=>{
    const view=sample();view.layout.lockedPanels=['files','editor'];view.appearance.panelLockGesture='longPress';
    const saved=parseViewCollection(encode(view)).views[0];expect(saved.layout.lockedPanels).toEqual(['files','editor']);expect(saved.appearance.panelLockGesture).toBe('longPress');
    expect(remapViewLayout(saved.layout,new Map([['editor','editor:second']])).lockedPanels).toEqual(['files','editor:second']);
    delete view.layout.lockedPanels;delete (view.appearance as Partial<typeof view.appearance>).panelLockGesture;
    expect(parseViewCollection(encode(view)).views[0].appearance.panelLockGesture).toBe('doubleClick');
  });
  it('rejects invalid and duplicate position-lock ids in saved views',()=>{
    const view=sample();view.layout.lockedPanels=['unknown'];expect(()=>parseViewCollection(encode(view))).toThrow('面板位置锁');
    view.layout.lockedPanels=['files','files'];expect(()=>parseViewCollection(encode(view))).toThrow('面板位置锁');
  });
  it('retains the independent find and replace panel in a saved view',()=>{
    const view=sample();view.layout.open.push('search');view.layout.rects.search=rect;
    expect(parseViewCollection(encode(view)).views[0].layout.open).toContain('search');
  });
  it('keeps the custom status order and count mode together while accepting older views',()=>{
    const view=sample();view.statusItems=['averageParagraphLength','paragraphs','count','narrationDialogue','save'];view.statusCountMode='text';
    expect(parseViewCollection(encode(view)).views[0]).toMatchObject({
      statusItems:['averageParagraphLength','paragraphs','count','narrationDialogue','save'],statusCountMode:'text',
    });
    view.statusItems=['paragraphs','count','save'];
    expect(parseViewCollection(encode(view)).views[0].statusItems).toEqual(['paragraphs','count','save']);
    delete view.statusCountMode;expect(parseViewCollection(encode(view)).views[0].statusCountMode).toBeUndefined();
    view.statusCountMode='invalid' as never;expect(()=>parseViewCollection(encode(view))).toThrow('格式无效');
  });
  it('restores blank tabs without treating an untitled manuscript as an empty landing page',()=>{
    const view=sample();view.editors[0]={...view.editors[0],file:null,landing:true};
    const saved=parseViewCollection(encode(view)).views[0].editors[0];
    expect(saved.landing).toBe(true);
    expect(matchesViewEditor({disk:null,landing:true},saved)).toBe(true);
    expect(matchesViewEditor({disk:null,landing:false},saved)).toBe(false);
    expect(matchesViewEditor({disk:null},saved)).toBe(false);
    expect(matchesViewEditor({disk:{path:'正文.md'}},saved)).toBe(false);
    expect(matchesViewEditor({disk:null,landing:true},{...saved,landing:undefined})).toBe(false);
    view.editors[0].file='正文.md';expect(()=>parseViewCollection(encode(view))).toThrow('格式无效');
  });
  it('omits transient trash previews, including a closed tab’s restore state, from saved views',()=>{
    const preview='editor:trash-fixture',closed='editor:trash-closed',view=sample();
    view.layout=placeWorkspacePanel(view.layout,preview,'editor','center',rect);
    view.layout.rects[closed]=rect;view.layout.restore[closed]={target:'editor',edge:'center'};
    view.layout.lockedPanels=[preview,'editor'];
    view.layout=omitTrashPreviewTabs(view.layout);
    expect(encode(view)).not.toContain('editor:trash-');
    expect(parseViewCollection(encode(view)).views[0].layout.open).toContain('editor');
    expect(matchesViewEditor({disk:null,trashPreview:{}},{...view.editors[0],file:null})).toBe(false);
  });
  it('retains source/live display mode independently of the typewriter flag and accepts legacy views',()=>{
    const view=sample();expect(parseViewCollection(encode(view)).views[0].editors[0].displayMode).toBeUndefined();
    view.editors[0].displayMode='source';view.editors[0].typewriter=true;
    expect(parseViewCollection(encode(view)).views[0].editors[0]).toMatchObject({displayMode:'source',typewriter:true});
    view.editors[0].displayMode='split';expect(parseViewCollection(encode(view)).views[0].editors[0].displayMode).toBe('split');
    view.editors[0].displayMode='unknown' as never;expect(()=>parseViewCollection(encode(view))).toThrow('格式无效');
  });
  it('preserves per-editor typewriter flags and supports legacy views without flags',()=>{
    const view=sample();expect(parseViewCollection(encode(view)).views[0].editors[0].typewriter).toBeUndefined();
    view.editors[0].typewriter=true;expect(parseViewCollection(encode(view)).views[0].editors[0].typewriter).toBe(true);
  });
  it('preserves the contents panel and its nearby minimized icon',()=>{
    const view=sample();view.layout=placeWorkspacePanel(view.layout,'toc','files','left',rect);view.layout=hideWorkspacePanel(view.layout,'toc',rect,true,{edge:'left',offset:.2,rect});
    const saved=parseViewCollection(encode(view)).views[0];expect(saved.layout.minimized).toContain('toc');expect(saved.layout.autoHide?.toc.edge).toBe('left');
  });
  it('round trips dock ratios, selected tabs, minimized restore anchors and display settings',()=>{
    const view=sample();expect(parseViewCollection(encode(view)).views[0]).toEqual(view);
  });
  it('retains the workspace position lock and accepts older views without a lock field',()=>{
    const view=sample();expect(parseViewCollection(encode(view)).views[0].layout.locked).toBeUndefined();
    view.layout.locked=true;const saved=parseViewCollection(encode(view)).views[0];expect(saved.layout.locked).toBe(true);
    expect(remapViewLayout(saved.layout,new Map([['editor','editor:other']])).locked).toBe(true);
  });
  it('retains ribbon visibility and collapse state while reading older views with expanded defaults',()=>{
    const view=sample();view.appearance.ribbonVisible=false;view.appearance.ribbonCollapsed=true;
    expect(parseViewCollection(encode(view)).views[0].appearance).toEqual(view.appearance);
    const {ribbonVisible:_visible,ribbonCollapsed:_collapsed,...legacy}=view.appearance;
    const old=JSON.stringify({version:1,views:[{...view,appearance:legacy}]});
    expect(parseViewCollection(old).views[0].appearance).toMatchObject({ribbonVisible:true,ribbonCollapsed:false});
  });
  it('persists the floating toolbar preference and defaults old views to visible',()=>{
    const view=sample();view.appearance.floatingToolbarVisible=false;
    expect(parseViewCollection(encode(view)).views[0].appearance.floatingToolbarVisible).toBe(false);
    const {floatingToolbarVisible:_toolbar,...legacy}=view.appearance;
    expect(parseViewCollection(JSON.stringify({version:1,views:[{...view,appearance:legacy}]})).views[0].appearance.floatingToolbarVisible).toBe(true);
  });
  it('restores preview mode and swapped split order while accepting older view presets',()=>{
    const view=sample();
    view.editors[0].displayMode='preview';
    view.appearance.splitOrder='semantic-first';
    const saved=parseViewCollection(encode(view)).views[0];
    expect(saved.editors[0].displayMode).toBe('preview');
    expect(saved.appearance.splitOrder).toBe('semantic-first');
    const {splitOrder:_order,...appearance}=view.appearance;
    const legacy={...view,appearance,editors:view.editors.map(item=>({...item,displayMode:'live'}))};
    const loaded=parseViewCollection(JSON.stringify({version:1,views:[legacy]})).views[0];
    expect(loaded.appearance.splitOrder).toBe('source-first');
    expect(loaded.editors[0].displayMode).toBe('live');
  });
  it('restores an independent basis panel with its minimized icon',()=>{
    const view=sample();view.layout.open.push('basis');view.layout.rects.basis=rect;
    const opened=parseViewCollection(encode(view)).views[0];expect(opened.layout.open).toContain('basis');
    view.layout=hideWorkspacePanel(view.layout,'basis',rect,true,{edge:'right',offset:.2,rect});
    const saved=parseViewCollection(encode(view)).views[0];expect(saved.layout.minimized).toContain('basis');expect(saved.layout.autoHide?.basis.edge).toBe('right');
  });
  it('persists nearby icons and remaps the expanded editor popup identity',()=>{
    const view=sample();view.layout.tree=null;view.layout.open=['editor'];view.layout.minimized=['files'];view.layout.autoHide={editor:{edge:'right',offset:.3,rect},files:{edge:'left',offset:.05,rect}};view.layout.autoHideActive='editor';
    const saved=parseViewCollection(encode(view)).views[0];expect(saved.layout.autoHide).toEqual(view.layout.autoHide);
    const mapped=remapViewLayout(saved.layout,new Map([['editor','editor:restored']]));
    expect(mapped.autoHideActive).toBe('editor:restored');expect(mapped.autoHide?.['editor:restored']).toEqual(view.layout.autoHide.editor);expect(mapped.autoHide?.editor).toBeUndefined();
  });
  it('retains multiple named views in one mode and a separate collection for another mode',()=>{
    const one=sample(),two={...sample(),id:'two',name:'专注',mode:'discuss' as const},three={...sample(),id:'three',mode:'edit' as const};
    expect(parseViewCollection(JSON.stringify({version:1,views:[one,two,three]})).views.map(view=>view.mode)).toEqual(['discuss','discuss','edit']);
  });
  it('remaps editor IDs in dock tabs, restore anchors and geometry without mutating the saved record',()=>{
    const view=sample(),before=structuredClone(view.layout);
    const mapped=remapViewLayout(view.layout,new Map([['editor','editor:restored']]));
    expect(JSON.stringify(mapped)).not.toContain('"editor"');expect(mapped.tree).not.toBe(view.layout.tree);expect(view.layout).toEqual(before);
    expect(mapped.restore.files.split?.siblings).toContain('editor:restored');
  });
  it('remaps floating tab groups, minimized editors and active tab',()=>{
    const view=sample();view.layout={tree:null,open:['editor','outline'],minimized:['editor:second'],rects:{floating:rect,'editor:second':rect},layers:{floating:35,'editor:second':34},floatingGroups:[{type:'group',id:'floating',panels:['editor','outline'],active:'editor'}],restore:{'editor:second':{target:'editor',edge:'center'}}};
    view.editors.push({id:'editor:second',file:'第二份.md',anchor:0,head:0,scrollTop:0});
    const mapped=remapViewLayout(parseViewCollection(encode(view)).views[0].layout,new Map([['editor','editor:first'],['editor:second','editor:other']]));
    expect(mapped.floatingGroups[0].active).toBe('editor:first');expect(mapped.minimized).toEqual(['editor:other']);expect(mapped.rects['editor:other']).toEqual(rect);expect(mapped.restore['editor:other'].target).toBe('editor:first');
  });
  it('rejects corrupt JSON and invalid numeric geometry',()=>{
    expect(()=>parseViewCollection('{broken')).toThrow('无法读取');const view=sample();view.layout.rects.editor={...rect,width:-10};expect(()=>parseViewCollection(encode(view))).toThrow('格式无效');
  });
  it('rejects duplicate panels and unknown panel IDs before restoring UI state',()=>{
    const view=sample();view.layout.open.push('unknown');expect(()=>parseViewCollection(encode(view))).toThrow('面板状态');
    view.layout.open=defaultWorkspace().open;view.layout.tree={type:'split',id:'duplicate',axis:'x',ratio:.5,a:{type:'panel',panel:'editor'},b:{type:'panel',panel:'editor'}};
    expect(()=>parseViewCollection(encode(view))).toThrow('面板状态');
  });
  it('rejects deeply nested trees and absent active editor descriptors',()=>{
    const view=sample();view.activeEditor='editor:missing';expect(()=>parseViewCollection(encode(view))).toThrow('编辑区');
    view.activeEditor='editor';for(let count=0;count<40;count++)view.layout.tree={type:'split',id:'nested'+count,axis:'x',ratio:.5,a:{type:'panel',panel:'files'},b:view.layout.tree!};
    expect(()=>parseViewCollection(encode(view))).toThrow('结构过深');
  });
  it('filters retired status options and preserves an intentionally empty status bar',()=>{
    const view=sample();view.statusItems=['count','hint'] as never;expect(parseViewCollection(encode(view)).views[0].statusItems).toEqual(['count']);view.statusItems=[];expect(parseViewCollection(encode(view)).views[0].statusItems).toEqual([]);
  });
});
