import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {defaultTheme,normalizeTheme,themeStorageKey} from './themePreferences';
import olive from '../../../templates/claude-olive-gold/colors.json';

describe('theme preview and default persistence',()=>{
  let data:Map<string,string>,write:ReturnType<typeof vi.fn>;
  beforeEach(()=>{vi.resetModules();vi.useFakeTimers();data=new Map();write=vi.fn((key:string,value:string)=>{data.set(key,value);});vi.stubGlobal('localStorage',{getItem:(key:string)=>data.get(key)??null,setItem:write});});
  afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
  it('publishes the latest preview immediately and coalesces a drag into one write',async()=>{
    const store=await import('./themeStore'),changed=vi.fn(),off=store.subscribeTheme(changed);
    for(let i=0;i<80;i++){store.setTheme(old=>({...old,colors:{...old.colors,accent:`#1234${i.toString(16).padStart(2,'0')}`}}));vi.advanceTimersByTime(5);}
    expect(store.getThemeSnapshot().preferences.colors.accent).toBe('#12344f');expect(changed).toHaveBeenCalledTimes(80);expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);expect(write).toHaveBeenCalledTimes(1);expect(JSON.parse(data.get(themeStorageKey)!).colors.accent).toBe('#12344f');off();
  });
  it('saves and reloads a complete default separately from subsequent edits',async()=>{
    let store=await import('./themeStore');store.setTheme(old=>({...old,base:'custom',customBase:'#334455',surfaceContrastMode:'manual',surfaceContrast:125,colors:{...old.colors,accent:'#abcdef'}}));
    store.setTheme(old=>({...old,writingDock:{...old.writingDock,frame:{...old.writingDock.frame,border:'#123456'},aiButton:{...old.writingDock.aiButton,borderRadius:7},sideButtons:{...old.writingDock.sideButtons,icon:'#789abc'}}}));
    const saved=store.getThemeSnapshot().preferences;
    expect(store.saveDefaultTheme()).toBe(true);store.setTheme(old=>({...old,base:'white',colors:{...old.colors,accent:'#ff8800'}}));store.setTheme(old=>({...old,writingDock:{...old.writingDock,frame:{...old.writingDock.frame,border:'#aabbcc'}}}));store.flushThemePreferences();
    vi.resetModules();store=await import('./themeStore');expect(store.getThemeSnapshot().preferences.colors.accent).toBe('#ff8800');expect(store.getThemeSnapshot().defaultScheme).toEqual(saved);store.restoreDefaultTheme();expect(store.getThemeSnapshot().preferences).toEqual(saved);expect(JSON.parse(data.get(themeStorageKey)!).defaultScheme).toEqual(saved);
  });
  it('flushes pending changes before close and reports persistence failures',async()=>{
    const store=await import('./themeStore');store.setTheme(old=>({...old,base:'gray'}));expect(store.flushThemePreferences()).toBe(true);expect(JSON.parse(data.get(themeStorageKey)!).base).toBe('gray');vi.advanceTimersByTime(300);expect(write).toHaveBeenCalledTimes(1);
    write.mockImplementation(()=>{throw new Error('full');});expect(store.saveDefaultTheme()).toBe(false);expect(store.getThemeSnapshot().saveError).toContain('无法保存');
  });
  it('migrates only the original base and isolates dock edits when switching and saving',async()=>{
    const legacyDock={...defaultTheme.writingDock,frame:{...defaultTheme.writingDock.frame,background:'#27301faa',border:'#102030'},aiButton:{...defaultTheme.writingDock.aiButton,icon:'#27301f',hoverIcon:'#ffffff'},sideButtons:{...defaultTheme.writingDock.sideButtons,background:'#12345644'}};
    const {writingDockProfiles:_unused,...legacy}=defaultTheme;data.set(themeStorageKey,JSON.stringify({...legacy,writingDock:legacyDock}));
    let store=await import('./themeStore');expect(store.getThemeSnapshot().preferences.writingDockProfiles).toEqual({black:legacyDock});
    store.setTheme(old=>({...old,base:'gray'}));const gray=store.getThemeSnapshot().preferences;expect(gray.writingDock.frame.background).not.toBe(legacyDock.frame.background);expect(gray.writingDock.aiButton.background).toBe('accent');
    store.setTheme(old=>({...old,writingDock:{...old.writingDock,frame:{...old.writingDock.frame,border:'#abcdef'}}}));
    store.setTheme(old=>({...old,base:'white'}));expect(store.getThemeSnapshot().preferences.writingDock.frame.border).not.toBe('#abcdef');
    store.setTheme(old=>({...old,base:'black'}));expect(store.getThemeSnapshot().preferences.writingDock).toEqual(legacyDock);
    store.saveDefaultTheme();store.setTheme(old=>({...old,base:'gray'}));expect(store.getThemeSnapshot().preferences.writingDock.frame.border).toBe('#abcdef');store.flushThemePreferences();
    vi.resetModules();store=await import('./themeStore');expect(store.getThemeSnapshot().preferences.writingDock.frame.border).toBe('#abcdef');store.restoreDefaultTheme();expect(store.getThemeSnapshot().preferences.writingDock).toEqual(legacyDock);
    store.setTheme(old=>({...old,base:'gray'}));expect(store.getThemeSnapshot().preferences.writingDock.frame.border).toBe('#abcdef');
  });
  it('archives the old dark dock under black when a light base had inherited it',()=>{
    const {writingDockProfiles:_unused,...legacy}=defaultTheme;
    const dark={...defaultTheme.writingDock,frame:{...defaultTheme.writingDock.frame,background:'#27301faa',border:'#556644',shadow:'#00000055'},aiButton:{...defaultTheme.writingDock.aiButton,icon:'#27301f',hoverIcon:'#ffffff'},sideButtons:{...defaultTheme.writingDock.sideButtons,background:'#12345644'}};
    const gray=normalizeTheme({...legacy,base:'gray',writingDock:dark});
    expect(gray.writingDock.frame.background).not.toBe(dark.frame.background);expect(gray.writingDockProfiles.black).toEqual(dark);expect(gray.writingDockProfiles.gray).toBeUndefined();
    expect(normalizeTheme({...gray,base:'black'}).writingDock).toEqual(dark);
    const light={...dark,frame:{...dark.frame,background:'#d0d9cdaa'}};
    const customGray=normalizeTheme({...legacy,base:'gray',writingDock:light});expect(customGray.writingDock).toEqual(light);expect(customGray.writingDockProfiles.black).toBeUndefined();
    const custom=normalizeTheme({...legacy,base:'custom',writingDock:dark});expect(custom.writingDock).toEqual(dark);expect(custom.writingDockProfiles.black).toBeUndefined();
  });
  it('archives an unbound old template’s complete preferences and separate default across migration and restart',async()=>{
    const legacy=normalizeTheme({...defaultTheme,base:'gray',surfaceColors:{gray:{document:'#e9ece3'}}});
    const saved=normalizeTheme({...legacy,surfaceColors:{gray:{document:'#dddddd'}}});
    data.set(themeStorageKey,JSON.stringify({...legacy,templateId:'olive-gold',defaultScheme:saved,oliveGrayRevision:2,oliveGrayBackup:{preserved:true}}));
    let store=await import('./themeStore');
    const identity={id:store.defaultTemplateId,name:'青苔鎏金',bases:['black','gray','white']} as const;
    const bind=()=>store.bindThemeTemplate({...identity,bases:[...identity.bases]},null,null,normalizeTheme(olive));
    bind();
    expect(store.getThemeSnapshot().templateId).toBe('claude-olive-gold');
    expect(store.getThemeSnapshot().preferences.surfaceColors.gray?.document).toBe(olive.surfaceColors.gray.document);
    const expected={'olive-gold':{preferences:legacy,defaultScheme:saved}};
    expect(store.getThemeSnapshot().legacyTemplateSettings).toEqual(expected);
    expect(store.getThemeSnapshot().oliveGrayBackup).toEqual({preserved:true});
    vi.resetModules();store=await import('./themeStore');bind();
    expect(store.getThemeSnapshot().legacyTemplateSettings).toEqual(expected);
  });
});
