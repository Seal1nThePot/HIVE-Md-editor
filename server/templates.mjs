import {promises as fs,watch} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import dockingColorFields from '../desktop/docking-colors.json' with {type:'json'};
import editorColorFields from '../desktop/editor-colors.json' with {type:'json'};
import {normalizeIconOverrides,validateIconPack} from '../shared/iconPack.mjs';
import {reasoningLevels} from './model-capabilities.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const bases=['black','gray','white','custom'];
const roles=['accent','secondary','link','success','warning','danger'];
const surfaces=['titleBar','ribbonTitleBackground','ribbonTitleText','ribbon','ribbonContentText','ribbonBorder','leftRailBackground','leftRailIcon','rightRailBackground','rightRailIcon','workspace','panel','panelHeader','panelBorder','panelInnerBorder','document','documentText','selectedTab','settingsBackground','settingsSidebar','settingsCard','settingsBorder','popup','popupBorder','input','inputBorder','uiText','mutedText','selection'];
const dockFields={frame:['background','border','borderWidth','borderRadius','shadow'],aiButton:['background','icon','hoverIcon','border','borderWidth','borderRadius'],sideButtons:['background','icon','border','borderWidth','borderRadius','activeIcon','activeBackground','activeBorder','hoverIcon','hoverBackground']};
const reasoningFields=['reasoningEffects','reasoningTrackProfiles'];
const trackParts=['left','middle','right'];
const reasoningEasing=/^cubic-bezier\(\s*(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)\s*,\s*-?\d+(?:\.\d+)?\s*,\s*(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)\s*,\s*-?\d+(?:\.\d+)?\s*\)$/;
const validId=id=>typeof id==='string'&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const color=(value,alpha=false)=>typeof value==='string'&&(alpha?/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i:/^#[0-9a-f]{6}$/i).test(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function missingReasoningFields(current,fallback){
  return Object.fromEntries(reasoningFields.filter(field=>current?.[field]===undefined&&fallback[field]!==undefined).map(field=>[field,fallback[field]]));
}
function restoreSourceReasoning(current,source){
  const restored={...current};
  for(const field of reasoningFields){
    if(source[field]!==undefined)restored[field]={...source[field],...current[field]};
  }
  return restored;
}
function mergeSourceColors(previous,next,current){
  if(JSON.stringify(previous)===JSON.stringify(next))return current;
  if(object(previous)&&object(next)){
    const result={};for(const key of new Set([...Object.keys(previous),...Object.keys(next),...Object.keys(object(current)?current:{})])){
      const value=mergeSourceColors(previous[key],next[key],object(current)?current[key]:undefined);if(value!==undefined)result[key]=value;
    }return result;
  }
  return next;
}

function palette(value){
  if(!object(value)||roles.some(role=>!color(value[role])))throw fail('模板语义色配置无效。');
  return Object.fromEntries(roles.map(role=>[role,value[role].toLowerCase()]));
}
function dock(value){
  if(!object(value))throw fail('模板底栏配置无效。');
  const result={};
  for(const [group,fields] of Object.entries(dockFields)){
    if(!object(value[group]))throw fail('模板底栏配置不完整。');
    result[group]={};
    for(const field of fields){
      const item=value[group][field];
      if(field==='borderWidth'||field==='borderRadius'){
        if(typeof item!=='number'||!Number.isFinite(item)||item<0||item>(field==='borderWidth'?8:100))throw fail('模板底栏尺寸无效。');
        result[group][field]=item;
      }else if(group==='aiButton'&&field==='background'&&item==='accent')result[group][field]=item;
      else {if(!color(item,true))throw fail('模板底栏颜色无效。');result[group][field]=item.toLowerCase();}
    }
  }
  return result;
}
export function validateTemplateColors(value,allowDefault=true){
  if(!object(value)||value.version!==1||!bases.includes(value.base)||value.palette!=='hive'||!color(value.customBase)||!['auto','manual'].includes(value.surfaceContrastMode)||typeof value.surfaceContrast!=='number'||!Number.isFinite(value.surfaceContrast)||value.surfaceContrast<50||value.surfaceContrast>150)throw fail('模板配色格式无效。');
  const result={version:1,base:value.base,customBase:value.customBase.toLowerCase(),palette:'hive',colors:palette(value.colors),surfaceContrastMode:value.surfaceContrastMode,surfaceContrast:value.surfaceContrast,surfaceColors:{},writingDock:dock(value.writingDock),writingDockProfiles:{}};
  if(!object(value.surfaceColors)||!object(value.writingDockProfiles))throw fail('模板分区配置无效。');
  for(const base of bases){
    if(value.surfaceColors[base]!==undefined){
      const entry=value.surfaceColors[base];if(!object(entry))throw fail('模板区域颜色无效。');
      result.surfaceColors[base]={};
      for(const key of surfaces)if(entry[key]!==undefined){if(!color(entry[key]))throw fail('模板区域颜色无效。');result.surfaceColors[base][key]=entry[key].toLowerCase();}
    }
    if(value.writingDockProfiles[base]!==undefined)result.writingDockProfiles[base]=dock(value.writingDockProfiles[base]);
  }
  if(value.colorProfiles!==undefined){
    if(!object(value.colorProfiles))throw fail('模板语义色档案无效。');result.colorProfiles={};
    for(const base of bases)if(value.colorProfiles[base]!==undefined)result.colorProfiles[base]=palette(value.colorProfiles[base]);
  }
  if(allowDefault&&value.defaultScheme!==undefined)result.defaultScheme=validateTemplateColors(value.defaultScheme,false);
  if(value.dockingProfiles!==undefined){
    if(!object(value.dockingProfiles))throw fail('停靠引导颜色档案无效。');result.dockingProfiles={};
    for(const base of bases){
      const raw=value.dockingProfiles[base];if(raw===undefined)continue;if(!object(raw))throw fail('停靠引导颜色档案无效。');
      const profile={};for(const [key,field] of Object.entries(dockingColorFields))if(raw[key]!==undefined){if(!color(raw[key],field.alpha))throw fail('停靠引导颜色无效。');profile[key]=raw[key].toLowerCase();}
      if(Object.keys(profile).length)result.dockingProfiles[base]=profile;
    }
  }
  if(value.editorProfiles!==undefined){
    if(!object(value.editorProfiles))throw fail('文本编辑页面颜色档案无效。');result.editorProfiles={};
    for(const base of bases){
      const raw=value.editorProfiles[base];if(raw===undefined)continue;if(!object(raw))throw fail('文本编辑页面颜色档案无效。');
      const profile={};for(const [key,field] of Object.entries(editorColorFields))if(raw[key]!==undefined){if(!color(raw[key],field.alpha))throw fail('文本编辑页面颜色无效。');profile[key]=raw[key].toLowerCase();}
      if(Object.keys(profile).length)result.editorProfiles[base]=profile;
    }
  }
  if(object(value.reasoningTrackProfiles)){
    result.reasoningTrackProfiles={};
    for(const base of bases){
      const track=value.reasoningTrackProfiles[base];
      if(object(track)&&trackParts.every(part=>color(track[part])))result.reasoningTrackProfiles[base]=Object.fromEntries(trackParts.map(part=>[part,track[part].toLowerCase()]));
    }
  }
  if(object(value.reasoningEffects)){
    result.reasoningEffects={};
    for(const level of reasoningLevels){
      const raw=value.reasoningEffects[level];
      if(!object(raw))continue;
      // Omit invalid optional fields so the renderer applies its existing defaults.
      const effect={};
      if(color(raw.color))effect.color=raw.color.toLowerCase();
      if(Number.isFinite(raw.glow))effect.glow=Math.max(0,Math.min(1,raw.glow));
      if(Number.isFinite(raw.particles))effect.particles=Math.round(Math.max(0,Math.min(8,raw.particles)));
      if(Number.isFinite(raw.duration))effect.duration=Math.round(Math.max(0,Math.min(2000,raw.duration)));
      if(typeof raw.easing==='string'&&reasoningEasing.test(raw.easing))effect.easing=raw.easing;
      result.reasoningEffects[level]=effect;
    }
  }
  return result;
}
function manifest(value,id){
  if(!object(value)||value.version!==1||value.id!==id||typeof value.name!=='string'||!value.name.trim()||value.name.length>80||typeof value.description!=='string'||value.description.length>300||value.colorsFile!=='colors.json'||!Array.isArray(value.bases)||!value.bases.length||value.bases.some(base=>!bases.includes(base)))throw fail('模板说明文件无效。');
  return {version:1,id,name:value.name,description:value.description,bases:[...new Set(value.bases)],colorsFile:'colors.json'};
}

export async function templateStore(directory,bundledDirectory,options={}){
  directory=path.resolve(directory);bundledDirectory=path.resolve(bundledDirectory);
  await fs.mkdir(directory,{recursive:true});
  const rootStat=await fs.lstat(directory);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw fail('模板根目录不可用。');
  const queues=new Map();
  let sourceWarnings=[],closed=false,watcher,sourceTimer,sourcePoll,syncing,closing;
  const source=options.sourceDirectory?path.resolve(options.sourceDirectory):null;
  const builtinIds=new Set(),sourceRecords=new Map();
  let sourceState={version:1,source,templates:{}};
  async function folder(id){
    if(!validId(id))throw fail('模板标识无效。');
    const target=path.join(directory,id),stat=await fs.lstat(target);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('模板目录不能是符号链接或目录联接。');
    return target;
  }
  async function readBytes(target){
    const stat=await fs.lstat(target);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw fail('模板文件不可用或超过 1 MiB。');
    const bytes=await fs.readFile(target);if(bytes.length>1024*1024)throw fail('模板文件超过 1 MiB。');
    return {revision:hash(bytes),bytes};
  }
  function parseJSON(bytes){
    try{return JSON.parse(bytes.toString('utf8'));}catch{throw fail('模板 JSON 无法解析。');}
  }
  async function readFile(target){
    const record=await readBytes(target);
    return {...record,value:parseJSON(record.bytes)};
  }
  async function transaction(id,action){
    const previous=queues.get(id)||Promise.resolve(),work=previous.catch(()=>{}).then(action);queues.set(id,work);
    try{return await work;}finally{if(queues.get(id)===work)queues.delete(id);}
  }
  async function replace(target,bytes,beforeRename){
    try{const stat=await fs.lstat(target);if(!stat.isFile()||stat.isSymbolicLink())throw fail('模板文件不能是符号链接。');}catch(error){if(error.code!=='ENOENT')throw error;}
    const temporary=path.join(path.dirname(target),`.sync-${randomUUID()}.tmp`);
    try{
      await fs.writeFile(temporary,bytes,{flag:'wx'});
      if(beforeRename)await beforeRename();
      await fs.rename(temporary,target);
    }finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  }
  async function importFile(target,value,backup){
    if(backup){try{const old=await readFile(target);await replace(target.replace(/\.json$/,'.before-source.json'),old.bytes);}catch(error){if(error.code!=='ENOENT')throw error;}}
    await replace(target,JSON.stringify(value,null,2)+'\n');
  }
  // Seed metadata only. The first renderer links its existing colors without replacing them.
  for(const entry of await fs.readdir(bundledDirectory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})){
    if(!entry.isDirectory()||!validId(entry.name))continue;
    builtinIds.add(entry.name);
    try{
    const bundled=manifest((await readFile(path.join(bundledDirectory,entry.name,'template.json'))).value,entry.name);
    const destination=path.join(directory,entry.name);
    await fs.mkdir(destination).catch(error=>{if(error.code!=='EEXIST')throw error;});
    await folder(entry.name);
    await fs.writeFile(path.join(destination,'template.json'),JSON.stringify(bundled,null,2)+'\n',{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    }catch(error){sourceWarnings.push(`${entry.name}：${error.message}`);}
  }
  const stateFile=path.join(directory,'.source-state.json');
  if(source&&source!==directory){try{const saved=(await readFile(stateFile)).value;if(saved.version===1&&saved.source===source&&object(saved.templates))sourceState=saved;}catch(error){if(error.code!=='ENOENT')sourceWarnings.push('源同步记录无效，将保留现有配色后重新连接。');}}
  async function syncSource(){
    if(!source||source===directory||closed)return;
    if(syncing)return syncing;
    syncing=(async()=>{
      const warnings=[];let changed=false;
      try{
        const root=await fs.lstat(source);if(!root.isDirectory()||root.isSymbolicLink())throw fail('模板源目录不可用或为链接。');
        for(const entry of await fs.readdir(source,{withFileTypes:true})){
          if(!entry.isDirectory()||!validId(entry.name))continue;
          try{
            const sourceFolder=path.join(source,entry.name),stat=await fs.lstat(sourceFolder);if(stat.isSymbolicLink())throw fail('模板源目录不能是链接。');
            const meta=await readFile(path.join(sourceFolder,'template.json')),raw=await readFile(path.join(sourceFolder,'colors.json'));
            const template=manifest(meta.value,entry.name),colors=validateTemplateColors(raw.value);
            sourceRecords.set(entry.name,{template,colors});
            const previous=Object.hasOwn(sourceState.templates,entry.name)?sourceState.templates[entry.name]:undefined;
            const destination=path.join(directory,entry.name);
            // Older readers could record the same source revision after dropping these fields.
            const recoverReasoning=previous?.colors===raw.revision&&previous.baseline&&Object.keys(missingReasoningFields(previous.baseline,colors)).length;
            if(!recoverReasoning&&previous?.metadata===meta.revision&&previous?.colors===raw.revision&&previous.baseline&&await fs.access(path.join(destination,'template.json')).then(()=>true,()=>false)&&await fs.access(path.join(destination,'colors.json')).then(()=>true,()=>false))continue;
            await transaction(entry.name,async()=>{
              const destination=path.join(directory,entry.name);await fs.mkdir(destination).catch(error=>{if(error.code!=='EEXIST')throw error;});await folder(entry.name);
              let hasMeta=true,hasColors=true;
              try{await fs.lstat(path.join(destination,'template.json'));}catch(error){if(error.code==='ENOENT')hasMeta=false;else throw error;}
              try{await fs.lstat(path.join(destination,'colors.json'));}catch(error){if(error.code==='ENOENT')hasColors=false;else throw error;}
              if(!hasMeta||previous&&previous.metadata!==meta.revision)await importFile(path.join(destination,'template.json'),template,hasMeta);
              // First connection preserves existing preferences. New source-only templates
              // can be imported immediately; builtins wait for the renderer's legacy link.
              if(previous&&previous.colors!==raw.revision||!hasColors||recoverReasoning){
                const current=hasColors?(await readFile(path.join(destination,'colors.json'))).value:undefined;
                let previousDefaults=previous?.baseline;try{previousDefaults=(await readFile(path.join(destination,'colors.baseline.json'))).value.colors;}catch(error){if(error.code!=='ENOENT')throw error;}
                let incoming,defaults;
                if(recoverReasoning){
                  incoming=validateTemplateColors(restoreSourceReasoning(current??previousDefaults??colors,colors));
                  defaults=validateTemplateColors(restoreSourceReasoning(previousDefaults??colors,colors),false);
                }else{
                  incoming=previous?.baseline&&current?validateTemplateColors(mergeSourceColors(previous.baseline,colors,current)):!hasColors&&previousDefaults&&previous?.colors===raw.revision?validateTemplateColors(previousDefaults):colors;
                  defaults=previous?.baseline&&previousDefaults?validateTemplateColors(mergeSourceColors(previous.baseline,colors,previousDefaults),false):validateTemplateColors(colors,false);
                }
                await importFile(path.join(destination,'colors.json'),incoming,hasColors);
                const runtime=await readFile(path.join(destination,'colors.json'));await replace(path.join(destination,'colors.baseline.json'),JSON.stringify({version:1,colors:defaults,runtimeRevision:runtime.revision},null,2)+'\n');
              }
            });
            sourceState.templates[entry.name]={metadata:meta.revision,colors:raw.revision,baseline:colors};changed=true;
          }catch(error){warnings.push(`${entry.name}：${error.message}（保留上一份有效模板）`);}
        }
        if(changed)await replace(stateFile,JSON.stringify(sourceState,null,2)+'\n');
      }catch(error){warnings.push(`模板源同步：${error.message}`);}
      sourceWarnings=warnings;
    })();
    try{await syncing;}finally{syncing=undefined;}
  }
  await syncSource();
  if(source&&source!==directory){
    const schedule=()=>{if(closed)return;clearTimeout(sourceTimer);sourceTimer=setTimeout(()=>{void syncSource();},200);sourceTimer.unref();};
    try{watcher=watch(source,{recursive:true},schedule);watcher.on('error',schedule);watcher.unref();}catch{/* Polling also covers a source directory created later. */}
    sourcePoll=setInterval(()=>{void syncSource();},1500);sourcePoll.unref();
  }
  async function read(id,refresh=true){
    if(refresh)await syncSource();
    const target=await folder(id),template=manifest((await readFile(path.join(target,'template.json'))).value,id);
    let stored;
    try{stored=await readFile(path.join(target,'colors.json'));}
    catch(error){
      if(error.code!=='ENOENT')throw error;
      let fallback;try{fallback=(await readFile(path.join(target,'colors.baseline.json'))).value.colors;}catch(error){if(error.code!=='ENOENT')throw error;}
      fallback??=sourceRecords.get(id)?.colors??sourceState.templates[id]?.baseline;
      fallback??=(await readFile(path.join(bundledDirectory,id,'colors.json'))).value;
      await replace(path.join(target,'colors.json'),JSON.stringify(validateTemplateColors(fallback,false),null,2)+'\n');stored=await readFile(path.join(target,'colors.json'));
    }
    const cacheFile=path.join(target,'colors.baseline.json');let cache;
    try{cache=(await readFile(cacheFile)).value;}catch(error){if(error.code!=='ENOENT')throw error;}
    const colors=validateTemplateColors(stored.value);
    const recovered=missingReasoningFields(cache?.colors,colors);
    let defaults;
    if(cache?.version===1&&cache.runtimeRevision===stored.revision)defaults=validateTemplateColors({...cache.colors,...recovered},false);
    else if(cache?.version===1)defaults=validateTemplateColors(colors,false);
    else{
      defaults=sourceRecords.get(id)?.colors??sourceState.templates[id]?.baseline;
      if(!defaults)try{defaults=(await readFile(path.join(bundledDirectory,id,'colors.json'))).value;}catch(error){if(error.code!=='ENOENT')throw error;}
      defaults=validateTemplateColors(defaults??stored.value,false);
    }
    if(!cache||cache.runtimeRevision!==stored.revision||Object.keys(recovered).length)await replace(cacheFile,JSON.stringify({version:1,colors:defaults,runtimeRevision:stored.revision},null,2)+'\n');
    return {template,directory:target,colors,revision:stored.revision,defaults,defaultsRevision:hash(JSON.stringify(defaults))};
  }
  async function list(){
    await syncSource();const templates=[],warnings=[...sourceWarnings];
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      if(!entry.isDirectory()||!validId(entry.name))continue;
      try{const record=await read(entry.name,false);templates.push({...record.template,directory:record.directory});}
      catch(error){warnings.push(`${entry.name}：${error.message}`);}
    }
    templates.sort((a,b)=>a.id==='olive-gold'?-1:b.id==='olive-gold'?1:a.name.localeCompare(b.name,'zh-CN'));
    return {directory,sourceDirectory:source,templates,warnings};
  }
  async function readIconBytes(root,id){
    const target=id?path.join(root,id):root;
    for(const location of id?[root,target]:[root]){
      const stat=await fs.lstat(location);
      if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('模板图标目录不可用或为链接。');
    }
    return readBytes(path.join(target,'icons.json'));
  }
  async function readIcons(id){
    if(!validId(id))throw fail('模板标识无效。');
    const roots=[directory,source,bundledDirectory].filter(Boolean);
    const candidates=[...roots.map(root=>({root,id})),...roots.map(root=>({root,id:''}))];
    const seen=new Set(),icons={},warnings=[];
    let revision=null,localIcons={};
    for(const candidate of candidates){
      const file=path.join(candidate.root,candidate.id,'icons.json');
      const key=process.platform==='win32'?file.toLowerCase():file;
      if(seen.has(key))continue;
      seen.add(key);
      const local=candidate.root===directory&&candidate.id===id;
      try{
        const record=await readIconBytes(candidate.root,candidate.id);
        if(local)revision=record.revision;
        const raw=parseJSON(record.bytes);
        if(!object(raw)||raw.version!==1||!object(raw.icons))throw fail('模板图标包格式无效。');
        const valid=normalizeIconOverrides(raw.icons);
        const skipped=Object.keys(raw.icons).length-Object.keys(valid).length;
        if(skipped)warnings.push(`${file} 中有 ${skipped} 项未知或无效的图标，已使用回退。`);
        if(local)localIcons=valid;
        for(const [name,definition] of Object.entries(valid))if(!Object.hasOwn(icons,name))icons[name]=definition;
      }catch(error){
        if(error.code!=='ENOENT')warnings.push(`无法读取 ${file}：${error.message} 已使用回退。`);
      }
    }
    const pack={version:1,icons,localIcons,revision,warning:warnings.join('；')};
    return {...pack,packRevision:hash(JSON.stringify(pack))};
  }
  async function saveIcons(id,input){
    if(!validId(id)||!object(input)||!(input.revision===null||typeof input.revision==='string'&&/^[a-f0-9]{64}$/.test(input.revision)))throw fail('图标保存参数无效。');
    const pack=validateIconPack({version:input.version,icons:input.localIcons}),bytes=JSON.stringify(pack,null,2)+'\n';
    if(Buffer.byteLength(bytes)>1024*1024)throw fail('模板图标文件超过 1 MiB。');
    return transaction(id,async()=>{
      const target=await folder(id);
      const checkRevision=async()=>{
        let revision=null;
        try{revision=(await readIconBytes(directory,id)).revision;}
        catch(error){if(error.code!=='ENOENT')throw fail(`本地图标文件无法安全写入：${error.message}`,409);}
        if(revision!==input.revision)throw fail('模板图标已被外部修改，请重新读取后再保存。',409);
      };
      await checkRevision();
      await replace(path.join(target,'icons.json'),bytes,checkRevision);
      return readIcons(id);
    });
  }
  async function save(id,input){
    if(!validId(id)||!object(input)||!(input.revision===null||typeof input.revision==='string'&&/^[a-f0-9]{64}$/.test(input.revision)))throw fail('模板保存参数无效。');
    const colors=validateTemplateColors(input.colors);
    await syncSource();
    return transaction(id,async()=>{
      const current=await read(id,false);if(current.revision!==input.revision)throw fail('模板配色文件已被外部修改，请重新读取后再保存。',409);
      const target=await folder(id),file=path.join(target,'colors.json'),temporary=path.join(target,`.colors-${randomUUID()}.tmp`);
      try{
        await replace(path.join(target,'colors.before-save.json'),(await readFile(file)).bytes);
        await fs.writeFile(temporary,JSON.stringify(colors,null,2)+'\n',{flag:'wx'});
        const checked=await read(id,false);if(checked.revision!==input.revision)throw fail('模板配色文件已被外部修改，请重新读取后再保存。',409);
        await fs.rename(temporary,file);
        const stored=await readFile(file);await replace(path.join(target,'colors.baseline.json'),JSON.stringify({version:1,colors:validateTemplateColors(colors,false),runtimeRevision:stored.revision},null,2)+'\n');
      }finally{await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
      return read(id,false);
    });
  }
  async function open(id){
    const {directory:target}=await read(id);
    if((options.platform??process.platform)!=='win32')throw fail('当前系统不支持 Windows 资源管理器。');
    if(options.openDirectory)await options.openDirectory(target);
    else{
      // The standalone Windows server does not have an Electron main process.
      await folder(id);
      await new Promise((resolve,reject)=>{
        const child=(options.launch||spawn)('explorer.exe',[target],{shell:false,windowsHide:false,detached:true,stdio:'ignore'});
        child.once('error',()=>reject(fail('无法打开系统资源管理器，请重试。',503)));
        child.once('spawn',()=>{child.unref();resolve();});
      });
    }
    return {ok:true,directory:target};
  }
  function close(){
    if(closing)return closing;
    closed=true;clearTimeout(sourceTimer);clearInterval(sourcePoll);watcher?.close();
    closing=(async()=>{if(syncing)await Promise.allSettled([syncing]);await Promise.allSettled([...queues.values()]);})();
    return closing;
  }
  return {list,read,save,readIcons,saveIcons,open,syncSource,close};
}
