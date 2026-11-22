import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {defaultTheme,switchThemeBase,themeStorageKey,updateThemeColors} from './themePreferences';
import olive from '../../../templates/claude-olive-gold/colors.json';
import blue from '../../../templates/claude-mediterranean-blue/colors.json';
import retainedBlue from '../../../templates/hive-mediterranean-blue-study/colors.json';
const revision='a'.repeat(64),nextRevision='b'.repeat(64);
const info={version:1,id:'claude-olive-gold',name:'青苔鎏金',description:'三档',bases:['black','gray','white'],colorsFile:'colors.json',directory:'C:/templates/olive-gold'};
const blueInfo={...info,id:'claude-mediterranean-blue',name:'地中海蓝',bases:['black','white'],directory:'C:/templates/mediterranean-blue'};
let data:Map<string,string>,request:ReturnType<typeof vi.fn>,blueDefaults:typeof blue;
const response=(value:unknown,status=200)=>({ok:status<400,status,json:async()=>value}) as Response;
const leftIcon=(width:number)=>({viewBox:`0 0 ${width} 24`,shapes:[{tag:'path',attrs:{d:'M1 1h10'}}]});
const iconPack=(packRevision:string,width?:number,warning='')=>({version:1,icons:width?{ArrowLeft:leftIcon(width)}:{},packRevision,warning});
const catalogResponse=()=>response({directory:'C:/templates',templates:[info,blueInfo],warnings:[]});
const blueResponse=(extra:Record<string,unknown>={})=>response({template:blueInfo,colors:blueDefaults,defaults:blueDefaults,revision,defaultsRevision:revision,...extra});
beforeEach(()=>{vi.resetModules();vi.useFakeTimers();data=new Map();blueDefaults=structuredClone(blue);blueDefaults.base='black';vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)});request=vi.fn(async(url:string,init?:RequestInit)=>{if(url==='/api/templates')return response({directory:'C:/templates',templates:[info,blueInfo],warnings:[]});const selected=url.includes('claude-mediterranean-blue'),colors=selected?blueDefaults:olive;return response({template:selected?blueInfo:info,colors:typeof init?.body==='string'?JSON.parse(init.body).colors:colors,defaults:colors,revision,defaultsRevision:revision});});vi.stubGlobal('fetch',request);});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
const writes=()=>request.mock.calls.filter(([,init])=>init?.method==='POST');
describe('template baseline and personal preference isolation',()=>{
  it('falls back from an archived selection to olive regardless of catalog ordering and keeps profiles for every template',async()=>{
    let files=await import('./templateFiles'),store=await import('./themeStore');
    await files.initializeThemeFiles();await files.loadTemplateFile(blueInfo.id);
    store.setTheme(old=>updateThemeColors(old,{accent:'#334455'}));store.saveDefaultTheme();
    store.setTheme(old=>updateThemeColors(old,{accent:'#665544'}));store.flushThemePreferences();
    const archivedProfile=store.getThemeSnapshot().templateUsers[blueInfo.id];
    const study={...blueInfo,id:'hive-mediterranean-blue-study',bases:['white','gray','black']};
    const personal={...info,id:'my-own-theme',name:'我的主题'};
    const catalog={directory:'C:/templates',templates:[personal,study,info],warnings:[]};
    request.mockImplementation(async(url:string)=>{
      if(url==='/api/templates')return response(catalog);
      const record=url.includes(study.id)?study:url.includes(personal.id)?personal:info;
      const colors=record===study?retainedBlue:olive;
      return response({template:record,colors,defaults:colors,revision,defaultsRevision:revision});
    });
    vi.clearAllTimers();vi.resetModules();files=await import('./templateFiles');store=await import('./themeStore');
    await files.initializeThemeFiles();
    expect(store.getThemeSnapshot()).toMatchObject({templateId:info.id,templateBinding:{name:'青苔鎏金'}});
    expect(store.getThemeSnapshot().templateUsers[blueInfo.id]).toEqual(archivedProfile);
    await files.loadTemplateFile(study.id);
    expect(store.getThemeSnapshot()).toMatchObject({templateId:study.id,templateBinding:{name:'地中海蓝',bases:['white','gray','black']}});
    await files.loadTemplateFile(info.id);
    expect(store.getThemeSnapshot().templateBinding?.name).toBe('青苔鎏金');
    await files.loadTemplateFile(personal.id);
    store.setTheme(old=>updateThemeColors(old,{accent:'#765432'}));store.flushThemePreferences();
    vi.clearAllTimers();vi.resetModules();files=await import('./templateFiles');store=await import('./themeStore');
    await files.initializeThemeFiles();
    expect(store.getThemeSnapshot()).toMatchObject({templateId:personal.id,preferences:{colors:{accent:'#765432'}}});
    expect(store.getThemeSnapshot().templateUsers[blueInfo.id]).toEqual(archivedProfile);
  });
  it('keeps editor highlights per template/base through personal defaults, restore and restart',async()=>{
    let files=await import('./templateFiles'),store=await import('./themeStore');await files.initializeThemeFiles();await files.loadTemplateFile('claude-mediterranean-blue');
    store.setTheme(old=>({...old,editorProfiles:{black:{selectionBackground:'#12345688',selectionText:'#abcdef'},white:{selectionBackground:'#65432177'}}}));store.saveDefaultTheme();
    store.setTheme(old=>({...old,editorProfiles:{...old.editorProfiles,black:{selectionBackground:'#11223366'}}}));await files.loadTemplateFile('claude-olive-gold');expect(store.getThemeSnapshot().preferences.editorProfiles.black).toBeUndefined();await files.loadTemplateFile('claude-mediterranean-blue');expect(store.getThemeSnapshot().preferences.editorProfiles.black?.selectionBackground).toBe('#11223366');
    store.restoreTemplateBase();expect(store.getThemeSnapshot().preferences.editorProfiles.black).toBeUndefined();expect(store.getThemeSnapshot().preferences.editorProfiles.white?.selectionBackground).toBe('#65432177');
    store.restoreDefaultTheme();store.flushThemePreferences();vi.resetModules();store=await import('./themeStore');expect(store.getThemeSnapshot().preferences.editorProfiles.black).toEqual({selectionBackground:'#12345688',selectionText:'#abcdef'});expect(writes()).toHaveLength(0);
  });
  it('persists manual text per template and base through defaults, restore and restart without POST',async()=>{
    let files=await import('./templateFiles'),store=await import('./themeStore');await files.initializeThemeFiles();await files.loadTemplateFile('claude-mediterranean-blue');
    const edited={uiText:'#123456',mutedText:'#654321',documentText:'#102938',ribbonTitleText:'#abcdef',ribbonContentText:'#fedcba'};
    store.setTheme(old=>({...old,surfaceColors:{...old.surfaceColors,black:{...old.surfaceColors.black,...edited}}}));store.saveDefaultTheme();
    store.setTheme(old=>switchThemeBase(old,'white'));expect(store.getThemeSnapshot().preferences.surfaceColors.white?.uiText).toBe(blue.surfaceColors.white.uiText);store.setTheme(old=>switchThemeBase(old,'black'));
    await files.loadTemplateFile('claude-olive-gold');expect(store.getThemeSnapshot().preferences.surfaceColors.black?.uiText).not.toBe(edited.uiText);await files.loadTemplateFile('claude-mediterranean-blue');expect(store.getThemeSnapshot().preferences.surfaceColors.black).toMatchObject(edited);
    store.restoreTemplateBase();expect(store.getThemeSnapshot().preferences.surfaceColors.black?.uiText).toBe(blue.surfaceColors.black.uiText);store.restoreDefaultTheme();store.flushThemePreferences();vi.resetModules();store=await import('./themeStore');expect(store.getThemeSnapshot().preferences.surfaceColors.black).toMatchObject(edited);expect(writes()).toHaveLength(0);
  });
  it('keeps docking colors per template, restores only the active base and survives restart without POST',async()=>{
    let files=await import('./templateFiles'),store=await import('./themeStore');await files.initializeThemeFiles();await files.loadTemplateFile('claude-mediterranean-blue');
    store.setTheme(old=>({...old,dockingProfiles:{black:{guideBackground:'#12345688',guideIcon:'#aabbcc'},white:{railActiveBackground:'#abcdef55'}}}));store.saveDefaultTheme();
    await files.loadTemplateFile('claude-olive-gold');expect(store.getThemeSnapshot().preferences.dockingProfiles.black?.guideIcon).not.toBe('#aabbcc');await files.loadTemplateFile('claude-mediterranean-blue');expect(store.getThemeSnapshot().preferences.dockingProfiles.black?.guideIcon).toBe('#aabbcc');
    store.restoreTemplateBase();expect(store.getThemeSnapshot().preferences.dockingProfiles.black?.activeBackground).toBe(blue.dockingProfiles.black.activeBackground);expect(store.getThemeSnapshot().preferences.dockingProfiles.white?.railActiveBackground).toBe('#abcdef55');
    store.restoreDefaultTheme();expect(store.getThemeSnapshot().preferences.dockingProfiles.black?.guideBackground).toBe('#12345688');store.flushThemePreferences();vi.resetModules();store=await import('./themeStore');expect(store.getThemeSnapshot().preferences.dockingProfiles.black?.guideIcon).toBe('#aabbcc');expect(writes()).toHaveLength(0);
  });
  it('replaces pre-template edits with the bound template without writing a template file',async()=>{
    const {writingDockProfiles:_dock,colorProfiles:_colors,...legacy}=defaultTheme;data.set(themeStorageKey,JSON.stringify({...legacy,colors:{...legacy.colors,accent:'#bfb178'},writingDock:{...legacy.writingDock,aiButton:{...legacy.writingDock.aiButton,icon:'#27301f'}}}));
    const files=await import('./templateFiles'),store=await import('./themeStore');await files.initializeThemeFiles();const state=store.getThemeSnapshot();
    expect(state.templateId).toBe('claude-olive-gold');expect(state.preferences.colors.accent).toBe(olive.colorProfiles.black.accent);expect(state.preferences.writingDock.aiButton.icon).toBe(olive.writingDockProfiles.black.aiButton.icon);expect(writes()).toHaveLength(0);
  });
  it('restores the blue baseline without POST or changing the other base',async()=>{
    const files=await import('./templateFiles'),store=await import('./themeStore');await files.initializeThemeFiles();await files.loadTemplateFile('claude-mediterranean-blue');store.setTheme(old=>updateThemeColors(old,{accent:'#123456'}));store.setTheme(old=>({...old,surfaceColors:{...old.surfaceColors,black:{...old.surfaceColors.black,document:'#111111'}}}));await vi.advanceTimersByTimeAsync(250);store.restoreTemplateBase();await files.flushThemeFiles();
    const state=store.getThemeSnapshot();expect(state.preferences.colors.accent).toBe(blue.colorProfiles.black.accent);expect(state.preferences.surfaceColors.black?.document).toBe(blue.surfaceColors.black.document);expect(state.preferences.surfaceColors.white?.document).toBe(blue.surfaceColors.white.document);expect(state.templateBinding?.bases).toEqual(['black','white']);expect(writes()).toHaveLength(0);
  });
  it('keeps personal edits and defaults separate for each template',async()=>{
    const files=await import('./templateFiles'),store=await import('./themeStore');await files.initializeThemeFiles();await files.loadTemplateFile('claude-mediterranean-blue');store.setTheme(old=>updateThemeColors(old,{accent:'#123456'}));store.saveDefaultTheme();store.setTheme(old=>updateThemeColors(old,{accent:'#654321'}));await files.loadTemplateFile('claude-olive-gold');expect(store.getThemeSnapshot().preferences.colors.accent).not.toBe('#654321');await files.loadTemplateFile('claude-mediterranean-blue');expect(store.getThemeSnapshot().preferences.colors.accent).toBe('#654321');store.restoreDefaultTheme();expect(store.getThemeSnapshot().preferences.colors.accent).toBe('#123456');expect(writes()).toHaveLength(0);
  });
  it('writes only on explicit save-to-template and retains edits during the request',async()=>{
    const files=await import('./templateFiles'),store=await import('./themeStore');await files.initializeThemeFiles();await files.loadTemplateFile('claude-mediterranean-blue');store.setTheme(old=>updateThemeColors(old,{accent:'#123456'}));let finish:(value:Response)=>void=()=>{};request.mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;}));const pending=files.saveCurrentTemplate();store.setTheme(old=>updateThemeColors(old,{accent:'#654321'}));const posted=JSON.parse(writes()[0][1]!.body as string).colors;finish(response({template:blueInfo,colors:posted,defaults:posted,revision:nextRevision,defaultsRevision:nextRevision}));expect(await pending).toBe(true);expect(writes()).toHaveLength(1);expect(store.getThemeSnapshot().preferences.colors.accent).toBe('#654321');
  });
  it('merges source updates under personal edits and rejects incomplete foreign templates',async()=>{
    const files=await import('./templateFiles'),store=await import('./themeStore');await files.initializeThemeFiles();await files.loadTemplateFile('claude-mediterranean-blue');store.setTheme(old=>({...old,surfaceColors:{...old.surfaceColors,black:{...old.surfaceColors.black,document:'#223344'}}}));blueDefaults.surfaceColors.black.panel='#213546';request.mockImplementationOnce(async()=>response({directory:'C:/templates',templates:[info,blueInfo],warnings:[]}));request.mockImplementationOnce(async()=>response({template:blueInfo,colors:blueDefaults,defaults:blueDefaults,revision:nextRevision,defaultsRevision:nextRevision}));await files.pollTemplateFiles();expect(store.getThemeSnapshot().preferences.surfaceColors.black?.document).toBe('#223344');expect(store.getThemeSnapshot().preferences.surfaceColors.black?.panel).toBe('#213546');
    const before=store.getThemeSnapshot().preferences;request.mockImplementationOnce(async()=>response({directory:'C:/templates',templates:[info,blueInfo],warnings:[]}));request.mockImplementationOnce(async()=>response({template:blueInfo,colors:{version:1,base:'black'},defaults:{version:1,base:'black'},revision:'c'.repeat(64)}));await files.pollTemplateFiles();expect(store.getThemeSnapshot().preferences).toBe(before);expect(files.getTemplateFilesSnapshot().error).toContain('不完整');expect(writes()).toHaveLength(0);
  });
  it('renders cached blue on restart while the service is unavailable',async()=>{
    let files=await import('./templateFiles'),store=await import('./themeStore');await files.initializeThemeFiles();await files.loadTemplateFile('claude-mediterranean-blue');store.setTheme(old=>updateThemeColors(old,{accent:'#123456'}));store.flushThemePreferences();vi.resetModules();request.mockRejectedValue(new Error('service unavailable'));store=await import('./themeStore');expect(store.getThemeSnapshot().preferences.colors.accent).toBe('#123456');expect(store.getThemeSnapshot().templateBinding?.name).toBe('地中海蓝');files=await import('./templateFiles');await files.initializeThemeFiles();expect(store.getThemeSnapshot().preferences.surfaceColors.black?.panel).toBe(blue.surfaceColors.black.panel);
  });
});

describe('active template icons',()=>{
  it('loads startup colors without waiting for icons and ignores a late startup pack after switching',async()=>{
    const files=await import('./templateFiles'),store=await import('./themeStore'),icons=await import('../../shared/icons');
    let finishIcons:(value:Response)=>void=()=>{};
    request.mockImplementationOnce(async()=>catalogResponse());
    request.mockImplementationOnce(async()=>response({template:info,colors:olive,defaults:olive,revision,defaultsRevision:revision}));
    request.mockImplementationOnce(()=>new Promise<Response>(resolve=>{finishIcons=resolve;}));
    await files.initializeThemeFiles();
    expect(request.mock.calls[1][0]).toBe('/api/templates/claude-olive-gold?colorsOnly=1');
    expect(request.mock.calls[2][0]).toBe('/api/templates/claude-olive-gold/icons');
    expect(store.getThemeSnapshot().templateId).toBe(info.id);
    expect(files.getTemplateFilesSnapshot().status).toBe('ready');
    expect(icons.getDockIconOverrides()).toEqual({});

    request.mockImplementationOnce(async()=>blueResponse({iconPack:iconPack('blue',32)}));
    await files.loadTemplateFile(blueInfo.id);
    finishIcons(response(iconPack('olive',40,'过期警告')));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getThemeSnapshot().templateId).toBe(blueInfo.id);
    expect(icons.getDockIconOverrides().ArrowLeft).toEqual(leftIcon(32));
    expect(files.getTemplateFilesSnapshot().iconWarning).toBe('');
  });

  it('accepts icon-only updates and fallbacks while leaving color state and saves independent',async()=>{
    const files=await import('./templateFiles'),store=await import('./themeStore'),icons=await import('../../shared/icons');
    await files.initializeThemeFiles();
    request.mockImplementationOnce(async()=>blueResponse({iconPack:iconPack('blue-one',32)}));
    await files.loadTemplateFile(blueInfo.id);
    const preferences=store.getThemeSnapshot().preferences;

    request.mockImplementationOnce(async()=>catalogResponse());
    request.mockImplementationOnce(async()=>blueResponse({iconPackUnchanged:true}));
    await files.pollTemplateFiles();
    expect(request.mock.lastCall?.[0]).toBe(`/api/templates/${blueInfo.id}?iconPackRevision=blue-one`);
    expect(icons.getDockIconOverrides().ArrowLeft).toEqual(leftIcon(32));

    request.mockImplementationOnce(async()=>catalogResponse());
    request.mockImplementationOnce(async()=>blueResponse({iconPack:iconPack('blue-two',40,'坏图标已回退')}));
    await files.pollTemplateFiles();
    expect(icons.getDockIconOverrides().ArrowLeft).toEqual(leftIcon(40));
    expect(files.getTemplateFilesSnapshot()).toMatchObject({status:'ready',error:'',iconWarning:'坏图标已回退'});
    expect(store.getThemeSnapshot().preferences).toBe(preferences);
    await files.saveCurrentTemplate();
    expect(JSON.parse(writes()[0][1].body)).not.toHaveProperty('iconPack');
    expect(icons.getDockIconOverrides().ArrowLeft).toEqual(leftIcon(40));

    request.mockImplementationOnce(async()=>catalogResponse());
    request.mockImplementationOnce(async()=>blueResponse({iconPack:iconPack('removed')}));
    await files.pollTemplateFiles();
    expect(icons.getDockIconOverrides()).toEqual({});
    expect(files.getTemplateFilesSnapshot().iconWarning).toBe('');
  });

  it('does not apply a pre-switch poll even when the user returns to the same template',async()=>{
    const files=await import('./templateFiles'),store=await import('./themeStore'),icons=await import('../../shared/icons');
    await files.initializeThemeFiles();
    request.mockImplementationOnce(async()=>blueResponse({iconPack:iconPack('initial',32)}));
    await files.loadTemplateFile(blueInfo.id);
    let finishPoll:(value:Response)=>void=()=>{};
    let markStarted:()=>void=()=>{};
    const started=new Promise<void>(resolve=>{markStarted=resolve;});
    request.mockImplementationOnce(async()=>catalogResponse());
    request.mockImplementationOnce(()=>new Promise<Response>(resolve=>{finishPoll=resolve;markStarted();}));
    const pending=files.pollTemplateFiles();await started;

    await files.loadTemplateFile(info.id);
    request.mockImplementationOnce(async()=>blueResponse({iconPack:iconPack('reloaded',40)}));
    await files.loadTemplateFile(blueInfo.id);
    finishPoll(blueResponse({iconPack:iconPack('late-poll',48,'过期警告')}));
    await pending;
    expect(store.getThemeSnapshot().templateId).toBe(blueInfo.id);
    expect(icons.getDockIconOverrides().ArrowLeft).toEqual(leftIcon(40));
    expect(files.getTemplateFilesSnapshot().iconWarning).toBe('');
  });
});
