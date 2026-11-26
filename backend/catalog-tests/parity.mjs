// Real C# HTTP tests. The old JavaScript stores are test-only compatibility oracles.
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {templateStore,validateTemplateColors} from '../../server/templates.mjs';
import {pluginStore} from '../../server/plugins.mjs';
import {validateIconDefinition,validateIconPack} from '../../shared/iconPack.mjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const work=path.resolve(process.env.HIVE_CATALOG_TEST_ROOT||path.join(project,'..','.work','019-csharp-backend','catalog-tests'));
const fixture=path.join(work,'fixture');
const id='claude-olive-gold';
const checks=[];
const unavailable=[];
const check=async(name,run)=>{await run();checks.push(name);console.log('PASS '+name);};
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value));};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const icon=n=>({viewBox:'0 0 24 24',shapes:[{tag:'path',attrs:{d:`M1 1h${n}`}}]});
const harness=path.join(work,'harness');
await fs.mkdir(harness,{recursive:true});
const xml=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;');
await write(path.join(harness,'Harness.csproj'),`<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net11.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup>${['Core','CatalogService','Templates','TemplateColors','Icons','Plugins'].map(name=>`<Compile Include="${xml(path.join(project,'backend',name+'.cs'))}"/>`).join('')}<Compile Include="Program.cs"/></ItemGroup></Project>`);
await write(path.join(harness,'Program.cs'),`using Hive;
using System.Text.Json.Nodes;
var builder=WebApplication.CreateBuilder(args);builder.WebHost.UseUrls("http://127.0.0.1:0");var app=builder.Build();
await using var catalog=new CatalogService(Environment.GetEnvironmentVariable("CATALOG_PROJECT")!,Environment.GetEnvironmentVariable("CATALOG_LOCAL")!,Environment.GetEnvironmentVariable("CATALOG_APPDATA")!,new ShellBridge());await catalog.Initialize();
app.MapPost("/__stop",(IHostApplicationLifetime lifetime)=>{lifetime.StopApplication();return Results.Ok();});
app.Map("/api/{**route}",async (HttpContext ctx)=>{try{JsonNode body=new JsonObject();if(ctx.Request.ContentLength>0)body=(await JsonNode.ParseAsync(ctx.Request.Body))!;if(!await catalog.Handle(ctx,ctx.Request.Path.Value![4..],body))ctx.Response.StatusCode=404;}catch(ApiException e){ctx.Response.StatusCode=e.Status;await ctx.Response.WriteAsJsonAsync(new{error=e.Message});}catch(Exception e){ctx.Response.StatusCode=e is FileNotFoundException or DirectoryNotFoundException?404:500;await ctx.Response.WriteAsJsonAsync(new{error=e.Message});}});
await app.StartAsync();Console.WriteLine("CATALOG_READY "+app.Urls.First());await app.WaitForShutdownAsync();
namespace Hive {public sealed class ShellBridge { public bool Desktop=>true; public Task OpenDirectory(string path)=>Task.CompletedTask; }}
`);
const artifacts=path.join(work,'artifacts');
const build=spawn('dotnet',['build',path.join(harness,'Harness.csproj'),'-p:ArtifactsPath='+artifacts],{windowsHide:true});
let buildLog='';build.stdout.on('data',d=>buildLog+=d);build.stderr.on('data',d=>buildLog+=d);
assert.equal(await new Promise(resolve=>build.on('exit',resolve)),0,buildLog);await write(path.join(work,'build.log'),buildLog);
assert.ok(path.resolve(fixture).startsWith(path.resolve(work)+path.sep));await fs.rm(fixture,{recursive:true,force:true});await fs.mkdir(fixture,{recursive:true});
const resource=path.join(fixture,'project');
for(const item of ['templates','desktop/docking-colors.json','desktop/editor-colors.json','shared/icons.json','server/plugin-examples/selection-lines.json'])await fs.cp(path.join(project,item),path.join(resource,item),{recursive:true});
const source=path.join(fixture,'source');await fs.cp(path.join(resource,'templates'),source,{recursive:true});
const local=path.join(fixture,'state'),appData=path.join(fixture,'appdata');
const runtime=path.join(local,'templates');
const oracleRuntime=path.join(fixture,'oracle-templates');
const oracle=await templateStore(oracleRuntime,path.join(resource,'templates'),{sourceDirectory:source});
const oraclePlugins=pluginStore(path.join(fixture,'oracle-plugins'),path.join(fixture,'oracle-state'),path.join(resource,'server/plugin-examples/selection-lines.json'),async()=>{});
const child=spawn('dotnet',[path.join(artifacts,'bin','Harness','debug','Harness.dll')],{windowsHide:true,env:{...process.env,CATALOG_PROJECT:resource,CATALOG_LOCAL:local,CATALOG_APPDATA:appData,HIVE_TEMPLATES_DIR:runtime,HIVE_TEMPLATES_SOURCE:source}});
let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
let base;
for(let n=0;n<200;n++){base=/CATALOG_READY (http:\/\/[^\r\n ]+)/.exec(logs)?.[1];if(base)break;if(child.exitCode!==null)throw Error(logs);await pause(50);}assert.ok(base,logs);
async function request(route,body,status=200){const response=await fetch(base+'/api'+route,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const json=await response.json();assert.equal(response.status,status,route+' '+JSON.stringify(json));return json;}
const equalColors=async()=>{const [a,b]=await Promise.all([request('/templates/'+id+'?colorsOnly=1'),oracle.read(id)]);assert.deepEqual(a.colors,b.colors);assert.deepEqual(a.defaults,b.defaults);return a;};
try{
await check('fresh starters and all bundled default icons match JS oracle',async()=>{
 const a=await request('/templates'),b=await oracle.list();assert.deepEqual(a.templates.map(x=>[x.id,x.name]),b.templates.map(x=>[x.id,x.name]));assert.deepEqual(a.warnings,[]);await equalColors();const pack=await request('/templates/'+id+'/icons');const expected=await oracle.readIcons(id);assert.deepEqual(pack.icons,expected.icons);assert.equal(pack.warning,'');assert.deepEqual(validateIconPack(JSON.parse(await fs.readFile(path.join(resource,'templates/icons.json'),'utf8'))).icons,pack.icons);
});
await check('color validation, complete defaultScheme and optional reasoning fields match oracle',async()=>{
 const initial=await request('/templates/'+id+'?colorsOnly=1'),old=await oracle.read(id);const colors={...initial.colors,customBase:'#ABCDEF',apiKey:'must-disappear',defaultScheme:initial.colors,dockingProfiles:{black:{guideBackground:'#12345655',guideIcon:'#ABCDEF'}},editorProfiles:{white:{selectionBackground:'#12345666',cursor:'#ABCDEF'}},reasoningTrackProfiles:{white:{left:'#123456',middle:'#456789',right:'#789ABC'},black:{left:'bad',middle:'#112233',right:'#112233'}},reasoningEffects:{low:{color:'bad',glow:2,particles:4.6,duration:-1,easing:'linear'},high:{glow:'bad',duration:9000},unknown:{particles:8}}};
 await request('/templates/'+id,{revision:initial.revision,colors});await oracle.save(id,{revision:old.revision,colors});await equalColors();assert.ok(!(await fs.readFile(path.join(runtime,id,'colors.json'),'utf8')).includes('must-disappear'));
 for(const invalid of [{...colors,colors:{...colors.colors,accent:'url(x)'}},{...colors,editorProfiles:{black:{cursor:'#12345677'}}},{...colors,writingDock:{}},{...colors,defaultScheme:null},{...colors,colorProfiles:null},{...colors,dockingProfiles:{black:null}},{...colors,editorProfiles:{black:{cursor:null}}},{...colors,surfaceColors:{white:null}}])await request('/templates/'+id,{revision:(await request('/templates/'+id+'?colorsOnly=1')).revision,colors:invalid},400);
});
await check('same revision writes serialize, stale write preserves winner and backup',async()=>{
 const record=await request('/templates/'+id+'?colorsOnly=1');const responses=await Promise.all(['#112233','#223344'].map(customBase=>fetch(base+'/api/templates/'+id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:record.revision,colors:{...record.colors,customBase}})})));assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);const winner=await request('/templates/'+id+'?colorsOnly=1');assert.ok(['#112233','#223344'].includes(winner.colors.customBase));assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtime,id,'colors.before-save.json'),'utf8')),record.colors);assert.equal((await fs.readdir(path.join(runtime,id))).filter(n=>n.endsWith('.tmp')).length,0);
 // Resynchronize the oracle to the winner for subsequent parity cases.
 await oracle.save(id,{revision:(await oracle.read(id)).revision,colors:winner.colors});
});
await check('legacy reasoning cache repair and missing runtime reconstruction preserve authored defaults',async()=>{
 for(const root of [runtime,oracleRuntime]){const file=path.join(root,id,'colors.baseline.json');const cache=JSON.parse(await fs.readFile(file,'utf8'));delete cache.colors.reasoningEffects;delete cache.colors.reasoningTrackProfiles;await write(file,cache);}await equalColors();
 for(const root of [runtime,oracleRuntime])await fs.unlink(path.join(root,id,'colors.json'));await equalColors();
});
await check('source three-way updates preserve unrelated local values and backup valid runtime',async()=>{
 const before=await request('/templates/'+id+'?colorsOnly=1');const authored=JSON.parse(await fs.readFile(path.join(source,id,'colors.json'),'utf8'));authored.surfaceColors.gray.document='#faf9f3';await write(path.join(source,id,'colors.json'),authored);await oracle.syncSource();const after=await equalColors();assert.equal(after.colors.surfaceColors.gray.document,'#faf9f3');assert.equal(after.colors.customBase,before.colors.customBase);assert.deepEqual(JSON.parse(await fs.readFile(path.join(runtime,id,'colors.before-source.json'),'utf8')),before.colors);
 await write(path.join(source,id,'colors.json'),'{"version":');assert.ok((await request('/templates')).warnings.some(w=>w.includes('保留上一份有效模板')));assert.deepEqual((await request('/templates/'+id+'?colorsOnly=1')).colors,after.colors);await write(path.join(source,id,'colors.json'),authored);
});
await check('new source templates, custom metadata, retirement and directory warnings',async()=>{
 const colors=(await request('/templates/'+id+'?colorsOnly=1')).colors;
 const meta={version:1,id:'new-theme',name:'新增模板',description:'自动导入',bases:['white'],colorsFile:'colors.json'};await write(path.join(source,'new-theme/template.json'),meta);await write(path.join(source,'new-theme/colors.json'),colors);await oracle.syncSource();assert.ok((await request('/templates')).templates.some(x=>x.id==='new-theme'));
 for(const root of [runtime,oracleRuntime]){await write(path.join(root,'broken/template.json'),'{');await write(path.join(root,'olive-gold/template.json'),{version:1,id:'olive-gold',name:'青苔鎏金',description:'低饱和青苔绿与灰金，包含黑、浅灰、白三档配色。',bases:['black','gray','white'],colorsFile:'colors.json'});await write(path.join(root,'olive-gold/colors.json'),colors);}
 const catalog=await request('/templates');assert.ok(!catalog.templates.some(x=>x.id==='olive-gold'));assert.ok(catalog.warnings.some(x=>x.startsWith('broken：')));assert.ok(await fs.stat(path.join(runtime,'olive-gold/colors.json')));
 const repurposed=JSON.parse(await fs.readFile(path.join(runtime,'olive-gold/template.json'),'utf8'));repurposed.description='个人模板';await write(path.join(runtime,'olive-gold/template.json'),repurposed);assert.ok((await request('/templates')).templates.some(x=>x.id==='olive-gold'));
});
await check('first source connection preserves pre-existing palette and authored manifest',async()=>{
 const colors=(await request('/templates/'+id+'?colorsOnly=1')).colors;
 const template={version:1,id:'first-linked',name:'已存在的个人名称',description:'用户模板',bases:['white'],colorsFile:'colors.json'};
 for(const root of [runtime,oracleRuntime]){await write(path.join(root,'first-linked/template.json'),template);await write(path.join(root,'first-linked/colors.json'),{...colors,customBase:'#aabbcc'});}
 await write(path.join(source,'first-linked/template.json'),{...template,name:'来源名称'});await write(path.join(source,'first-linked/colors.json'),{...colors,customBase:'#bbccdd'});await oracle.syncSource();const actual=await request('/templates/first-linked?colorsOnly=1'),expected=await oracle.read('first-linked');assert.deepEqual(actual.colors,expected.colors);assert.deepEqual(actual.defaults,expected.defaults);assert.equal(actual.colors.customBase,'#aabbcc');assert.equal(actual.template.name,'已存在的个人名称');
});
await check('icon local precedence, safe paint/path validation, byte revisions and fallback warnings',async()=>{
 const file=path.join(runtime,id,'icons.json');const basePack=await request('/templates/'+id+'/icons');assert.equal(basePack.revision,null);
 const localIcons={X:icon(3),Camera:{viewBox:'0 0 24 24',shapes:[{tag:'path',attrs:{d:'M3 2A4 4 0 0110 11',fill:'rgb(127, 18, 8)',stroke:'var( --icon-danger , currentColor )'}}]}};
 let saved=await request('/templates/'+id+'/icons',{version:1,revision:null,localIcons});assert.deepEqual(saved.localIcons.Camera,validateIconDefinition(localIcons.Camera));assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{version:1,icons:saved.localIcons});assert.equal(saved.revision.length,64);await request('/templates/'+id+'/icons',{version:1,revision:null,localIcons},409);
 for(const bad of [{UnknownIcon:icon(2)},{X:{...icon(2),fill:'url(https://example.com)'}},{X:{viewBox:'0 0 24 24',shapes:[{tag:'path',attrs:{d:'M 2'}}]}},{X:{viewBox:'0 0 24 24',shapes:[{tag:'path',attrs:{d:'M1 2L3 4',onload:'x'}}]}}])await request('/templates/'+id+'/icons',{version:1,revision:saved.revision,localIcons:bad},400);
 const cached=await request('/templates/'+id+'?iconPackRevision='+saved.packRevision);assert.equal(cached.iconPackUnchanged,true);assert.ok(!cached.iconPack);assert.ok(!(await request('/templates/'+id+'?colorsOnly=1')).iconPack);
 await write(file,'{"version":');let corrupt=await request('/templates/'+id+'/icons');assert.ok(corrupt.warning.includes('JSON 无法解析'));assert.notEqual(corrupt.revision,saved.revision);saved=await request('/templates/'+id+'/icons',{version:1,revision:corrupt.revision,localIcons:{X:icon(4)}});assert.equal(saved.warning,'');
 await write(file,{version:1,icons:{X:{viewBox:'0 0 24 24',shapes:[{tag:'script',attrs:{}}]},UnknownIcon:icon(2),Search:icon(8)}});const partial=await request('/templates/'+id+'/icons');assert.ok(partial.warning.includes('2 项未知或无效'));assert.deepEqual(partial.localIcons,{Search:icon(8)});assert.deepEqual(partial.icons.X,basePack.icons.X);
});
await check('plugin sample, toggles, malformed/oversized/duplicate quarantine match oracle',async()=>{
 let actual=await request('/plugins/sample',{}),expected=await oraclePlugins.installSample();assert.deepEqual(actual.plugins,expected.plugins);await request('/plugins/enabled',{id:'hive.selection-lines',enabled:true});await oraclePlugins.setEnabled({id:'hive.selection-lines',enabled:true});assert.deepEqual((await request('/plugins')).plugins,(await oraclePlugins.list()).plugins);
 const sample=JSON.parse(await fs.readFile(path.join(resource,'server/plugin-examples/selection-lines.json'),'utf8'));
 for(const root of [path.join(appData,'plugins'),path.join(fixture,'oracle-plugins')])for(const [name,value] of [['broken.json','{'],['oversized.json','x'.repeat(16385)],['duplicate.json',sample],['independent.json',{...sample,id:'independent',contribution:{...sample.contribution,metric:'line-length'}}]])await write(path.join(root,name),value);
 actual=await request('/plugins');expected=await oraclePlugins.list();assert.deepEqual(actual.plugins,expected.plugins);assert.deepEqual(actual.errors,expected.errors);await request('/plugins/enabled',{id:'hive.selection-lines',enabled:true},404);await request('/plugins/enabled',{id:'independent',enabled:true});
 await write(path.join(local,'plugins-enabled.json'),{});await request('/plugins',undefined,409);await write(path.join(local,'plugins-enabled.json'),{ids:['independent']});
 const sourceBytes=await fs.readFile(path.join(appData,'plugins/hive-selection-lines.json'));await request('/plugins/sample',{});assert.deepEqual(await fs.readFile(path.join(appData,'plugins/hive-selection-lines.json')),sourceBytes);
});
await check('source polling with concurrent read/save requests has no 500 or broken JSON',async()=>{
 const sourceFile=path.join(source,id,'colors.json');const authored=JSON.parse(await fs.readFile(sourceFile,'utf8'));
 for(let round=0;round<8;round++) {
  authored.surfaceColors.gray.document='#'+String(100000+round);await write(sourceFile,authored);
  const latest=await request('/templates/'+id+'?colorsOnly=1');const operations=Array.from({length:10},(_,i)=>fetch(base+'/api/templates/'+id+(i%3?'?colorsOnly=1':''),i%3?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:latest.revision,colors:{...latest.colors,customBase:'#334455'}})}));
  const results=await Promise.all(operations);for(const response of results){const data=await response.json();assert.ok([200,409].includes(response.status),JSON.stringify(data));}
 }
 authored.customBase='#314159';await write(sourceFile,authored);
 for(let n=0;n<50;n++){const disk=JSON.parse(await fs.readFile(path.join(runtime,id,'colors.json'),'utf8'));if(disk.customBase==='#314159')return;await pause(100);}throw Error('source polling did not publish');
});
await check('template traversal and linked folders are rejected without changes outside root',async()=>{
 await request('/templates/%2e%2e%5coutside',undefined,400);
 const outside=path.join(fixture,'outside');await fs.mkdir(outside,{recursive:true});await write(path.join(outside,'marker.txt'),'preserve');await fs.symlink(outside,path.join(runtime,'linked'),'junction');await request('/templates/linked',undefined,400);assert.equal(await fs.readFile(path.join(outside,'marker.txt'),'utf8'),'preserve');
});
await check('plugin 64-file and 16KiB limits, all metrics, BOM and null descriptions',async()=>{
 const plugins=path.join(appData,'plugins');assert.ok(path.resolve(plugins).startsWith(path.resolve(fixture)+path.sep));await fs.rm(plugins,{recursive:true,force:true});await fs.mkdir(plugins);
 const manifest={version:1,id:'valid',name:'有效',contribution:{slot:'editor.status',metric:'document-lines',label:'行数'}};
 await write(path.join(plugins,'a.json'),'\uFEFF'+JSON.stringify(manifest));await write(path.join(plugins,'b.json'),{...manifest,id:'length',contribution:{...manifest.contribution,metric:'line-length'}});await write(path.join(plugins,'c.json'),{...manifest,id:'selected',contribution:{...manifest.contribution,metric:'selected-lines'}});await write(path.join(plugins,'d.json'),{...manifest,id:'null-description',description:null});
 let catalog=await request('/plugins');assert.equal(catalog.plugins.length,3);assert.deepEqual(catalog.errors.map(x=>x.file),['d.json']);
 for(let n=0;n<65;n++)await write(path.join(plugins,'limit-'+String(n).padStart(2,'0')+'.json'),{...manifest,id:'limit-'+n});
 catalog=await request('/plugins');assert.equal(catalog.limitReached,true);assert.equal(catalog.plugins.length+catalog.errors.length,64);await request('/plugins/enabled',[],400);
});
await check('1MiB icon input/output limits and linked icon files leave external bytes intact',async()=>{
 const file=path.join(runtime,id,'icons.json');await write(file,'x'.repeat(1024*1024+1));let pack=await request('/templates/'+id+'/icons');assert.equal(pack.revision,null);assert.ok(pack.warning.includes('1 MiB'));await request('/templates/'+id+'/icons',{version:1,revision:null,localIcons:{X:icon(1)}},409);
 await fs.unlink(file);const outsideFile=path.join(fixture,'outside/icons.json');await write(outsideFile,{version:1,icons:{X:icon(2)}});let linked=false;try{await fs.symlink(outsideFile,file,'file');linked=true;}catch(error){if(error.code!=='EPERM')throw error;unavailable.push('File symlink creation requires Windows privilege; directory junction rejection passed.');}if(linked){pack=await request('/templates/'+id+'/icons');assert.ok(pack.warning);await request('/templates/'+id+'/icons',{version:1,revision:null,localIcons:{X:icon(1)}},409);assert.deepEqual(JSON.parse(await fs.readFile(outsideFile,'utf8')),{version:1,icons:{X:icon(2)}});await fs.unlink(file);}
 const large={viewBox:'0 0 24 24',shapes:Array.from({length:64},()=>({tag:'path',attrs:{d:'M1 1'+('L1 1'.repeat(1500))}}))};const localIcons=Object.fromEntries(Object.keys(JSON.parse(await fs.readFile(path.join(resource,'shared/icons.json'),'utf8'))).slice(0,5).map(name=>[name,large]));await request('/templates/'+id+'/icons',{version:1,revision:null,localIcons},400);assert.equal(await fs.stat(file).then(()=>true,()=>false),false);
});
}finally{
 await oracle.close();const exit=new Promise(resolve=>child.once('exit',()=>resolve(true)));try{await fetch(base+'/__stop',{method:'POST'});}catch{}let timeout;const exited=await Promise.race([child.exitCode!==null?true:exit,new Promise(resolve=>{timeout=setTimeout(()=>resolve(false),10000);})]);clearTimeout(timeout);if(!exited)child.kill();assert.ok(exited,'C# service did not drain and exit');await write(path.join(work,'server.log'),logs);
 await write(path.join(work,'result.json'),{passed:checks.length,checks,unavailable,backend:'C# compiled source via actual HTTP',oracle:'legacy JS stores, test only',fixture,at:new Date().toISOString()});
}
console.log(JSON.stringify({passed:checks.length,evidence:work}));
