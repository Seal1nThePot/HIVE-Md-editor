import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {templateStore,validateTemplateColors} from './templates.mjs';

const sourceFixture=fileURLToPath(new URL('../templates/claude-olive-gold',import.meta.url));
const productionBundle=path.dirname(sourceFixture);
const templateId='claude-olive-gold';
const icon=n=>({viewBox:'0 0 24 24',shapes:[{tag:'path',attrs:{d:`M1 1h${n}`}}]});
const iconFile=(root,id='')=>path.join(root,id,'icons.json');
const writeIcons=(file,icons)=>fs.writeFile(file,JSON.stringify({version:1,icons}));
let directory,temporary,bundled,store,fixture,initialRevision;
beforeEach(async()=>{temporary=await fs.mkdtemp(path.join(os.tmpdir(),'hive-template-files-'));directory=path.join(temporary,'runtime');bundled=path.join(temporary,'bundled');await fs.cp(sourceFixture,path.join(bundled,'claude-olive-gold'),{recursive:true});store=await templateStore(directory,bundled);fixture=JSON.parse(await fs.readFile(path.join(bundled,'claude-olive-gold','colors.json'),'utf8'));initialRevision=(await store.read('claude-olive-gold')).revision;});
afterEach(async()=>{await store?.close();if(temporary&&path.resolve(temporary).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(temporary).startsWith('hive-template-files-'))await fs.rm(temporary,{recursive:true,force:true});});

describe('local template folders',()=>{
  it('registers only the two renamed starters in a fresh production or source-linked catalog',async()=>{
    const expected=[['claude-olive-gold','青苔鎏金'],['hive-mediterranean-blue-study','地中海蓝']];
    for(const [name,sourceDirectory] of [['packaged',undefined],['development',productionBundle]]){
      const runtime=path.join(temporary,name);
      const fresh=await templateStore(runtime,productionBundle,{sourceDirectory});
      try{
        const {templates,warnings}=await fresh.list();
        expect(warnings).toEqual([]);
        expect(templates.map(({id,name})=>[id,name])).toEqual(expected);
        expect((await fs.readdir(runtime,{withFileTypes:true})).filter(item=>item.isDirectory()).map(item=>item.name)).toEqual(expected.map(([id])=>id));
        for(const [id] of expected){
          const original=JSON.parse(await fs.readFile(path.join(productionBundle,id,'colors.json'),'utf8'));
          expect((await fresh.read(id)).colors).toEqual(validateTemplateColors(original));
        }
      }finally{await fresh.close();}
    }
  });
  it('retires only known historic manifests and preserves the runtime directories and custom templates',async()=>{
    const runtime=path.join(temporary,'upgrade');
    await fs.cp(productionBundle,runtime,{recursive:true});
    const writeTemplate=async (id,name,description,bases)=>{
      const target=path.join(runtime,id);await fs.mkdir(target);
      await fs.writeFile(path.join(target,'template.json'),JSON.stringify({version:1,id,name,description,bases,colorsFile:'colors.json'}));
      await fs.writeFile(path.join(target,'colors.json'),JSON.stringify({...fixture,customBase:'#123456'}));
    };
    await writeTemplate('olive-gold','青苔鎏金','低饱和青苔绿与灰金，包含黑、浅灰、白三档配色。',['black','gray','white']);
    await writeTemplate('mediterranean-blue','地中海蓝','包含深色方案与浅色方案；R6 浅色外围略加中性灰，中央正文保持纯白，深色沿用 R5；1px 分层细描边、AI 白星与冰蓝悬停；black 对应深色，white 对应浅色。',['black','white']);
    await writeTemplate('my-blue','地中海蓝','自建模板',['black','gray','white']);
    const paths=['olive-gold','mediterranean-blue','claude-mediterranean-blue','hive-moss-gold-study'].flatMap(id=>['template.json','colors.json'].map(file=>path.join(runtime,id,file)));
    const preserved=await Promise.all(paths.map(file=>fs.readFile(file,'utf8')));
    const oliveManifest=path.join(runtime,'claude-olive-gold','template.json');
    const oliveMetadata=JSON.parse(await fs.readFile(oliveManifest,'utf8'));
    await fs.writeFile(oliveManifest,JSON.stringify({...oliveMetadata,name:'青苔鎏金 · Claude'}));
    const blueManifest=path.join(runtime,'hive-mediterranean-blue-study','template.json');
    const blueMetadata=JSON.parse(await fs.readFile(blueManifest,'utf8'));
    await fs.writeFile(blueManifest,JSON.stringify({...blueMetadata,name:'地中海蓝 · 海蓝选区'}));
    for(let run=0;run<2;run++){
      const upgraded=await templateStore(runtime,productionBundle,{sourceDirectory:productionBundle});
      try{
        const catalog=(await upgraded.list()).templates;
        expect(catalog.map(({id})=>id).sort()).toEqual(['claude-olive-gold','hive-mediterranean-blue-study','my-blue']);
        expect(catalog.find(({id})=>id==='claude-olive-gold').name).toBe('青苔鎏金');
        expect(catalog.find(({id})=>id==='hive-mediterranean-blue-study').name).toBe('地中海蓝');
        expect((await upgraded.read('my-blue')).colors.customBase).toBe('#123456');
      }finally{await upgraded.close();}
    }
    expect(await Promise.all(paths.map(file=>fs.readFile(file,'utf8')))).toEqual(preserved);
    const repurposed=path.join(runtime,'olive-gold','template.json');
    const metadata=JSON.parse(await fs.readFile(repurposed,'utf8'));
    await fs.writeFile(repurposed,JSON.stringify({...metadata,description:'我自己维护的模板'}));
    const customized=await templateStore(runtime,productionBundle,{sourceDirectory:productionBundle});
    try{
      expect((await customized.list()).templates.find(item=>item.id==='olive-gold')).toMatchObject({description:'我自己维护的模板'});
      expect((await customized.read('olive-gold')).colors.customBase).toBe('#123456');
    }finally{await customized.close();}
  });
  it('persists reasoning styles and restores them from a repaired legacy cache',async()=>{
    const reasoningTrackProfiles={white:{left:'#123456',middle:'#456789',right:'#789abc'}};
    const reasoningEffects={max:{color:'#abddee',glow:.85,particles:6,duration:470,easing:'cubic-bezier(.18,0,.39,1)'}};
    const saved=await store.save(templateId,{revision:initialRevision,colors:{...fixture,reasoningTrackProfiles,reasoningEffects}});
    expect(saved.colors).toMatchObject({reasoningTrackProfiles,reasoningEffects});
    expect(saved.defaults).toMatchObject({reasoningTrackProfiles,reasoningEffects});
    const cacheFile=path.join(directory,templateId,'colors.baseline.json');
    const cache=JSON.parse(await fs.readFile(cacheFile,'utf8'));
    delete cache.colors.reasoningTrackProfiles;
    delete cache.colors.reasoningEffects;
    await fs.writeFile(cacheFile,JSON.stringify(cache));
    expect((await store.read(templateId)).defaults).toMatchObject({reasoningTrackProfiles,reasoningEffects});
    await fs.unlink(path.join(directory,templateId,'colors.json'));
    expect((await store.read(templateId)).colors).toMatchObject({reasoningTrackProfiles,reasoningEffects});
  });
  it('keeps the same fallbacks for absent or invalid optional reasoning fields',()=>{
    const legacy=validateTemplateColors(fixture);
    expect(legacy).not.toHaveProperty('reasoningTrackProfiles');
    expect(legacy).not.toHaveProperty('reasoningEffects');
    const colors=validateTemplateColors({...fixture,reasoningTrackProfiles:{
      white:{left:'#123456',middle:'#456789',right:'#789ABC'},black:{left:'bad',middle:'#112233',right:'#112233'},
    },reasoningEffects:{
      off:[],low:{color:'bad',glow:2,particles:4.6,duration:-1,easing:'linear'},high:{glow:'bad',duration:9000},unknown:{particles:8},
    }});
    expect(colors.reasoningTrackProfiles).toEqual({white:{left:'#123456',middle:'#456789',right:'#789abc'}});
    expect(colors.reasoningEffects).toEqual({low:{glow:1,particles:5,duration:0},high:{duration:2000}});
  });
  it('fills styles dropped from an unchanged source revision and retains local track colors',async()=>{
    await store.close();
    const source=path.join(temporary,'source');
    await fs.cp(bundled,source,{recursive:true});
    store=await templateStore(directory,bundled,{sourceDirectory:source});
    await store.close();
    const sourceTracks={white:{left:'#112233',middle:'#223344',right:'#334455'},black:{left:'#445566',middle:'#556677',right:'#667788'}};
    const localWhite={left:'#998877',middle:'#887766',right:'#776655'};
    const reasoningEffects={high:{color:'#abcfef',particles:4}};
    const sourceBytes=JSON.stringify({...fixture,reasoningTrackProfiles:sourceTracks,reasoningEffects});
    await fs.writeFile(path.join(source,templateId,'colors.json'),sourceBytes);
    const stateFile=path.join(directory,'.source-state.json');
    const state=JSON.parse(await fs.readFile(stateFile,'utf8'));
    state.templates[templateId].colors=createHash('sha256').update(sourceBytes).digest('hex');
    await fs.writeFile(stateFile,JSON.stringify(state));
    await fs.writeFile(path.join(directory,templateId,'colors.json'),JSON.stringify({...fixture,customBase:'#123456',reasoningTrackProfiles:{white:localWhite}}));

    store=await templateStore(directory,bundled,{sourceDirectory:source});
    const read=await store.read(templateId);
    expect(read.colors).toMatchObject({customBase:'#123456',reasoningTrackProfiles:{...sourceTracks,white:localWhite},reasoningEffects});
    expect(read.defaults).toMatchObject({reasoningTrackProfiles:sourceTracks,reasoningEffects});
  });
  it('persists optional editor highlights on explicit save and reconstructs the saved baseline',async()=>{
    const colors={...fixture,editorProfiles:{black:{selectionBackground:'#aabbcc66',selectionBorder:'#2387abbb',selectionText:'#123456'},white:{annotationBackground:'#11223344'}}};
    const saved=await store.save('claude-olive-gold',{revision:initialRevision,colors});expect(saved.defaults.editorProfiles).toEqual(colors.editorProfiles);
    await fs.unlink(path.join(directory,'claude-olive-gold','colors.json'));expect((await store.read('claude-olive-gold')).colors.editorProfiles).toEqual(colors.editorProfiles);
    for(const profile of [{cursor:'#12345677'},{selectionBackground:'url(x)'}])expect(()=>validateTemplateColors({...colors,editorProfiles:{black:profile}})).toThrow('文本编辑页面颜色');
  });
  it('persists docking overrides and alpha in explicit saves and reconstructed baselines',async()=>{
    const colors={...fixture,dockingProfiles:{black:{guideIcon:'#abcdef',guideBackground:'#12345655'},white:{railActiveBackground:'#65432177'}}};
    const saved=await store.save('claude-olive-gold',{revision:initialRevision,colors});expect(saved.defaults.dockingProfiles).toEqual(colors.dockingProfiles);
    await fs.unlink(path.join(directory,'claude-olive-gold','colors.json'));expect((await store.read('claude-olive-gold')).colors.dockingProfiles).toEqual(colors.dockingProfiles);
    await expect(store.save('claude-olive-gold',{revision:saved.revision,colors:{...colors,dockingProfiles:{black:{guideIcon:'url(x)'}}}})).rejects.toMatchObject({status:400});
  });
  it('waits for an in-flight source write before close resolves',async()=>{
    await store.close();const source=path.join(temporary,'source');await fs.cp(bundled,source,{recursive:true});store=await templateStore(directory,bundled,{sourceDirectory:source});
    const target=path.join(directory,'claude-olive-gold','colors.json'),rename=fs.rename.bind(fs);let signal,release;
    const entered=new Promise(resolve=>{signal=resolve;}),gate=new Promise(resolve=>{release=resolve;});let blocked=false;
    vi.spyOn(fs,'rename').mockImplementation(async(from,to)=>{if(to===target&&!blocked){blocked=true;signal();await gate;}return rename(from,to);});
    await fs.writeFile(path.join(source,'claude-olive-gold','colors.json'),JSON.stringify({...fixture,customBase:'#314159'}));
    const syncing=store.syncSource();await entered;let closed=false;const closing=store.close();
    try{expect(closing).toBeInstanceOf(Promise);closing.then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);}
    finally{release();await syncing;await closing;vi.restoreAllMocks();}
    expect(JSON.parse(await fs.readFile(target,'utf8')).customBase).toBe('#314159');expect(closed).toBe(true);
  });
  it('seeds metadata without replacing an existing template or user palette',async()=>{
    const original=await store.read('claude-olive-gold');expect(original.revision).toMatch(/^[a-f0-9]{64}$/);
    fixture.colors.accent='#bfb178';fixture.colorProfiles.black.accent='#bfb178';
    const saved=await store.save('claude-olive-gold',{revision:initialRevision,colors:fixture});
    const meta=path.join(directory,'claude-olive-gold','template.json');const data=JSON.parse(await fs.readFile(meta,'utf8'));data.name='我的青苔';await fs.writeFile(meta,JSON.stringify(data));
    const restarted=await templateStore(directory,bundled),read=await restarted.read('claude-olive-gold');
    expect(read.revision).toBe(saved.revision);expect(read.colors.colors.accent).toBe('#bfb178');expect(read.template.name).toBe('我的青苔');
  });
  it('stores only theme fields, including the complete default scheme',async()=>{
    const saved=await store.save('claude-olive-gold',{revision:initialRevision,colors:{...fixture,defaultScheme:fixture,apiKey:'never-store-this',documents:['private manuscript']}});
    expect(saved.colors.defaultScheme.surfaceColors.gray.document).toBe(fixture.surfaceColors.gray.document);
    const text=await fs.readFile(path.join(directory,'claude-olive-gold','colors.json'),'utf8');expect(text).not.toContain('never-store-this');expect(text).not.toContain('private manuscript');
    expect(saved.revision).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects stale writes and serializes simultaneous writes against one revision',async()=>{
    const first=await store.save('claude-olive-gold',{revision:initialRevision,colors:fixture});
    const update={...fixture,colors:{...fixture.colors,accent:'#112233'}};
    const results=await Promise.allSettled([store.save('claude-olive-gold',{revision:first.revision,colors:update}),store.save('claude-olive-gold',{revision:first.revision,colors:fixture})]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect(results.find(result=>result.status==='rejected').reason.status).toBe(409);
    expect((await store.read('claude-olive-gold')).colors.colors.accent).toBe('#112233');
    expect((await fs.readdir(path.join(directory,'claude-olive-gold'))).some(name=>name.endsWith('.tmp'))).toBe(false);
  });
  it('detects external edits and leaves them intact',async()=>{
    const first=await store.save('claude-olive-gold',{revision:initialRevision,colors:fixture}),file=path.join(directory,'claude-olive-gold','colors.json');
    const external={...fixture,customBase:'#345678'};await fs.writeFile(file,JSON.stringify(external));
    await expect(store.save('claude-olive-gold',{revision:first.revision,colors:fixture})).rejects.toMatchObject({status:409});
    expect(JSON.parse(await fs.readFile(file,'utf8')).customBase).toBe('#345678');
  });
  it('rejects path traversal, invalid colors and linked folders',async()=>{
    await expect(store.read('../outside')).rejects.toMatchObject({status:400});
    expect(()=>validateTemplateColors({...fixture,colors:{...fixture.colors,accent:'url(file:///private)'}})).toThrow();
    const outside=path.join(directory,'outside');await fs.mkdir(outside);const linked=path.join(directory,'linked');await fs.symlink(outside,linked,process.platform==='win32'?'junction':'dir');
    await expect(store.read('linked')).rejects.toThrow('符号链接');
  });
  it('discovers each template folder and reports malformed folders separately',async()=>{
    const copy=path.join(directory,'my-olive');await fs.mkdir(copy);await fs.writeFile(path.join(copy,'template.json'),JSON.stringify({version:1,id:'my-olive',name:'我的模板',description:'独立目录',bases:['gray','white'],colorsFile:'colors.json'}));await fs.writeFile(path.join(copy,'colors.json'),JSON.stringify(fixture));
    await fs.mkdir(path.join(directory,'broken'));
    const catalog=await store.list();expect(catalog.templates.map(item=>item.id)).toEqual(expect.arrayContaining(['claude-olive-gold','my-olive']));expect(catalog.warnings).toHaveLength(1);
    expect(catalog.templates.find(item=>item.id==='my-olive').directory).toBe(copy);
  });
  it('opens the validated runtime template directory and propagates native failures',async()=>{
    const openDirectory=vi.fn(async()=>{});
    const windows=await templateStore(directory,bundled,{platform:'win32',openDirectory});
    try{
      const selected=path.join(directory,templateId),outside=path.join(temporary,'outside');
      await fs.mkdir(outside);
      await fs.symlink(outside,path.join(directory,'linked'),process.platform==='win32'?'junction':'dir');
      for(const id of ['..','linked','missing'])await expect(windows.open(id)).rejects.toThrow();
      expect(openDirectory).not.toHaveBeenCalled();
      await expect(windows.open(templateId)).resolves.toEqual({ok:true,directory:selected});
      expect(openDirectory).toHaveBeenCalledExactlyOnceWith(selected);
      const failure=Object.assign(new Error('无法打开系统资源管理器，请重试。'),{status:503});
      openDirectory.mockRejectedValueOnce(failure);
      await expect(windows.open(templateId)).rejects.toBe(failure);
    }finally{await windows.close();}
  });
  it('opens Explorer visibly without shell syntax in the standalone Windows server',async()=>{
    const launch=vi.fn(()=>{const child=new EventEmitter();child.unref=vi.fn();queueMicrotask(()=>child.emit('spawn'));return child;});
    const windows=await templateStore(directory,bundled,{platform:'win32',launch});
    try{
      await windows.open(templateId);
      expect(launch).toHaveBeenCalledExactlyOnceWith('explorer.exe',[path.join(directory,templateId)],expect.objectContaining({shell:false,windowsHide:false}));
      launch.mockImplementationOnce(()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('error',Error('private path')));return child;});
      await expect(windows.open(templateId)).rejects.toMatchObject({status:503,message:'无法打开系统资源管理器，请重试。'});
    }finally{await windows.close();}
  });
  it('imports new source folders automatically and preserves user colors on the first link',async()=>{
    const local={...fixture,customBase:'#334455'};await store.save('claude-olive-gold',{revision:initialRevision,colors:local});await store.close();
    const source=path.join(temporary,'source');await fs.cp(bundled,source,{recursive:true});store=await templateStore(directory,bundled,{sourceDirectory:source});
    expect((await store.read('claude-olive-gold')).colors.customBase).toBe('#334455');
    const added=path.join(source,'new-theme');await fs.mkdir(added);await fs.writeFile(path.join(added,'template.json'),JSON.stringify({version:1,id:'new-theme',name:'新增源模板',description:'自动导入',bases:['white'],colorsFile:'colors.json'}));await fs.writeFile(path.join(added,'colors.json'),JSON.stringify(fixture));
    await store.syncSource();expect((await store.list()).templates.some(item=>item.id==='new-theme')).toBe(true);expect(JSON.parse(await fs.readFile(path.join(directory,'new-theme','colors.json'),'utf8')).version).toBe(1);
  });
  it('watches valid source updates, backs up local colors, and survives partial JSON writes',async()=>{
    await store.save('claude-olive-gold',{revision:initialRevision,colors:{...fixture,customBase:'#334455'}});await store.close();
    const source=path.join(temporary,'source');await fs.cp(bundled,source,{recursive:true});store=await templateStore(directory,bundled,{sourceDirectory:source});
    const sourceFile=path.join(source,'claude-olive-gold','colors.json'),runtimeFile=path.join(directory,'claude-olive-gold','colors.json');
    await fs.writeFile(sourceFile,'{"version":');await store.syncSource();expect((await store.read('claude-olive-gold')).colors.customBase).toBe('#334455');expect((await store.list()).warnings.some(value=>value.includes('保留上一份'))).toBe(true);
    const update={...fixture,customBase:'#556677'};await fs.writeFile(sourceFile,JSON.stringify(update));
    await vi.waitFor(async()=>expect(JSON.parse(await fs.readFile(runtimeFile,'utf8')).customBase).toBe('#556677'),{timeout:4000,interval:80});
    expect(JSON.parse(await fs.readFile(path.join(directory,'claude-olive-gold','colors.before-source.json'),'utf8')).customBase).toBe('#334455');
  });
  it('retains the source baseline across restarts without replacing later local edits',async()=>{
    const source=path.join(temporary,'source');await fs.cp(bundled,source,{recursive:true});await store.close();store=await templateStore(directory,bundled,{sourceDirectory:source});
    const initial=await store.read('claude-olive-gold');const saved=await store.save('claude-olive-gold',{revision:initial.revision,colors:{...fixture,customBase:'#123456'}});await store.close();
    store=await templateStore(directory,bundled,{sourceDirectory:source});expect((await store.read('claude-olive-gold')).revision).toBe(saved.revision);expect((await store.read('claude-olive-gold')).colors.customBase).toBe('#123456');
  });
  it('applies only changed source values and retains unrelated black customization',async()=>{
    const local=structuredClone(fixture);local.colorProfiles.black.accent='#bfb178';local.colors.accent='#bfb178';local.writingDockProfiles.black.aiButton.icon='#27301f';local.writingDock.aiButton.icon='#27301f';await store.save('claude-olive-gold',{revision:initialRevision,colors:local});await store.close();
    const source=path.join(temporary,'source');await fs.cp(bundled,source,{recursive:true});store=await templateStore(directory,bundled,{sourceDirectory:source});
    const update=structuredClone(fixture);update.surfaceColors.gray.document='#faf9f3';await fs.writeFile(path.join(source,'claude-olive-gold','colors.json'),JSON.stringify(update));await store.syncSource();
    const result=(await store.read('claude-olive-gold')).colors;expect(result.surfaceColors.gray.document).toBe('#faf9f3');expect(result.colorProfiles.black.accent).toBe('#bfb178');expect(result.writingDockProfiles.black.aiButton.icon).toBe('#27301f');
  });
  it('reconstructs a missing generated file from its durable authored baseline',async()=>{
    const authored=structuredClone(fixture);authored.surfaceColors.black.document='#293847';const saved=await store.save('claude-olive-gold',{revision:initialRevision,colors:authored});
    expect(saved.defaults.surfaceColors.black.document).toBe('#293847');expect(JSON.parse(await fs.readFile(path.join(directory,'claude-olive-gold','colors.before-save.json'),'utf8')).surfaceColors.black.document).toBe(fixture.surfaceColors.black.document);
    await fs.unlink(path.join(directory,'claude-olive-gold','colors.json'));await store.close();store=await templateStore(directory,path.join(temporary,'missing-bundle'));const restored=await store.read('claude-olive-gold');expect(restored.colors.surfaceColors.black.document).toBe('#293847');expect(restored.defaults.surfaceColors.black.document).toBe('#293847');
  });
});

describe('template icon packs',()=>{
  it('merges per-template packs before each global pack and falls back by key when files are removed',async()=>{
    await store.close();
    const source=path.join(temporary,'source');
    await fs.cp(bundled,source,{recursive:true});
    store=await templateStore(directory,bundled,{sourceDirectory:source});
    const first=(await store.read(templateId)).revision;
    const layers=[iconFile(directory,templateId),iconFile(source,templateId),iconFile(bundled,templateId),iconFile(directory),iconFile(source),iconFile(bundled)];
    const distinct=['Camera','Check','Copy','Folder','Save','Search'];
    await Promise.all(layers.map((file,index)=>writeIcons(file,{X:icon(index+1),[distinct[index]]:icon(index+1)})));

    let pack=await store.readIcons(templateId);
    expect(Object.keys(pack.icons).sort()).toEqual([...distinct,'X'].sort());
    expect(pack.localIcons).toEqual({X:icon(1),Camera:icon(1)});
    expect(pack.packRevision).toBe((await store.readIcons(templateId)).packRevision);
    for(const [index,file] of layers.entries()){
      expect(pack.icons.X).toEqual(icon(index+1));
      await fs.unlink(file);
      const previous=pack.packRevision;
      pack=await store.readIcons(templateId);
      expect(pack.packRevision).not.toBe(previous);
      expect(pack.icons).not.toHaveProperty(distinct[index]);
      expect(pack.revision).toBeNull();
      expect(pack.warning).toBe('');
    }
    expect(pack.icons).toEqual({});
    expect((await store.read(templateId)).revision).toBe(first);
  });

  it('omits unsafe entries, deduplicates identical directories, and tolerates a missing local template folder',async()=>{
    await store.close();
    store=await templateStore(directory,bundled,{sourceDirectory:bundled});
    const userFile=iconFile(directory,templateId),broken=iconFile(bundled,templateId);
    await writeIcons(iconFile(bundled),{X:icon(1),Search:icon(2)});
    await fs.writeFile(broken,'{"version":');
    await writeIcons(userFile,{Search:icon(3),X:{viewBox:'0 0 24 24',shapes:[{tag:'script',attrs:{}}]},UnknownIcon:icon(4)});

    const partial=await store.readIcons(templateId);
    expect(partial.icons).toEqual({X:icon(1),Search:icon(3)});
    expect(partial.localIcons).toEqual({Search:icon(3)});
    expect(partial.warning).toContain('2 项未知或无效');
    expect(partial.warning.split(broken)).toHaveLength(2);
    expect((await store.read(templateId)).colors.version).toBe(1);

    await fs.unlink(userFile);
    const userFolder=path.join(directory,templateId);
    for(const name of await fs.readdir(userFolder))await fs.unlink(path.join(userFolder,name));
    await fs.rmdir(userFolder);
    expect((await store.readIcons(templateId)).icons).toEqual({X:icon(1),Search:icon(2)});
    await store.close();
    store=await templateStore(directory,bundled);
    expect((await store.read(templateId)).colors.version).toBe(1);
  });

  it('writes only explicit local definitions and rejects unknown, unsafe and stale writes',async()=>{
    await writeIcons(iconFile(bundled),{X:icon(1),Search:icon(2)});
    const base=await store.readIcons(templateId);
    const file=iconFile(directory,templateId);
    expect(base.localIcons).toEqual({});
    await expect(store.saveIcons(templateId,{version:1,revision:null,icons:base.icons})).rejects.toMatchObject({status:400});
    for(const localIcons of [{UnknownIcon:icon(2)},{X:{...icon(2),fill:'url(https://example.com)'}}]){
      await expect(store.saveIcons(templateId,{version:1,revision:null,localIcons})).rejects.toMatchObject({status:400});
    }
    await expect(fs.stat(file)).rejects.toMatchObject({code:'ENOENT'});

    const request={version:1,revision:base.revision,localIcons:{X:icon(3)}};
    const results=await Promise.allSettled([store.saveIcons(templateId,request),store.saveIcons(templateId,request)]);
    expect(results.map(result=>result.status)).toEqual(['fulfilled','rejected']);
    expect(results[1].reason).toMatchObject({status:409});
    const saved=results[0].value;
    expect(saved.icons).toEqual({X:icon(3),Search:icon(2)});
    expect(JSON.parse(await fs.readFile(file,'utf8'))).toEqual({version:1,icons:{X:icon(3)}});
    await writeIcons(iconFile(bundled),{X:icon(1),Search:icon(4)});
    expect((await store.readIcons(templateId)).icons.Search).toEqual(icon(4));

    await fs.writeFile(file,'{"version":');
    await expect(store.saveIcons(templateId,{...request,revision:saved.revision})).rejects.toMatchObject({status:409});
    const corrupt=await store.readIcons(templateId);
    expect(corrupt.icons).toEqual({X:icon(1),Search:icon(4)});
    expect(corrupt.warning).toContain('JSON 无法解析');
    const repaired=await store.saveIcons(templateId,{...request,revision:corrupt.revision});
    expect(repaired.warning).toBe('');
    expect(repaired.icons.X).toEqual(icon(3));
  });
});
