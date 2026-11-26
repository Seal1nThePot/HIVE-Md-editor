using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Hive;

public sealed class Templates(string directory,string bundledDirectory,string? source,TemplateColors validator,Icons iconValidator,ShellBridge shell):IAsyncDisposable
{
    readonly ConcurrentDictionary<string,SemaphoreSlim> queues=new();
    readonly SemaphoreSlim sync=new(1,1);
    readonly ConcurrentDictionary<string,JsonObject> sourceRecords=new();
    readonly object sourceStateLock=new();
    JsonObject sourceState=new(){["version"]=1,["source"]=source,["templates"]=new JsonObject()};
    List<string> sourceWarnings=[];CancellationTokenSource? pollingCancellation;Task? polling;bool closed;
    static readonly JsonSerializerOptions Pretty=new(J.Options){WriteIndented=true};
    static readonly Dictionary<string,(string name,string[] bases,string description)> Retired=new(){
        ["olive-gold"]=("青苔鎏金",["black","gray","white"],"低饱和青苔绿与灰金，包含黑、浅灰、白三档配色。"),
        ["mediterranean-blue"]=("地中海蓝",["black","white"],"包含深色方案与浅色方案；R6 浅色外围略加中性灰，中央正文保持纯白，深色沿用 R5；1px 分层细描边、AI 白星与冰蓝悬停；black 对应深色，white 对应浅色。"),
        ["claude-mediterranean-blue"]=("地中海蓝 · Claude",["white","gray","black"],"晴空海蓝分层逻辑：外框（标题栏/功能区标题/面板头）逐层递进到柔和的侧栏与面板，最终落到最干净的纸面；强调色、选区与 AI 按钮同源，AI 图标用深色高对比线条框定，停靠与激活态统一为天蓝系。包含白、浅灰、黑三档。black 深色，gray 浅灰，white 浅色。"),
        ["hive-moss-gold-study"]=("青苔鎏金 · 配色试验",["black","gray","white"],"黑、灰、白三档沿用青苔与金色。黑底略提亮菜单和输入框的描边，白底略压深菜单描边，让细线更易辨认。")};
    static readonly Dictionary<string,(string oldName,string name)> Names=new(){["claude-olive-gold"]=("青苔鎏金 · Claude","青苔鎏金"),["hive-mediterranean-blue-study"]=("地中海蓝 · 海蓝选区","地中海蓝")};
    static bool ValidId(string id)=>Regex.IsMatch(id,@"^[a-z0-9][a-z0-9_-]{0,63}$")&&!Regex.IsMatch(id,@"^(con|prn|aux|nul|com[1-9]|lpt[1-9])$",RegexOptions.IgnoreCase);
    static bool Missing(Exception e)=>e is FileNotFoundException or DirectoryNotFoundException;
    JsonNode? SourceRecord(string id){lock(sourceStateLock)return sourceState["templates"]?[id].Copy();}
    static void PlainDirectory(string target,string message){if(!J.Exists(target))throw new DirectoryNotFoundException();J.Require(Directory.Exists(target)&&(File.GetAttributes(target)&FileAttributes.ReparsePoint)==0,message);}
    string Folder(string id){J.Require(ValidId(id),"模板标识无效。");var target=Path.Combine(directory,id);if(!J.Exists(target))throw new DirectoryNotFoundException();PlainDirectory(target,"模板目录不能是符号链接或目录联接。");return target;}
    static byte[] Bytes(JsonNode value)=>Encoding.UTF8.GetBytes(value.ToJsonString(Pretty)+"\n");
    static async Task<(string revision,byte[] bytes)> ReadBytes(string target)
    {
        var info=new FileInfo(target);if(!info.Exists){if(Directory.Exists(target))throw new ApiException("模板文件不可用或超过 1 MiB。");throw new FileNotFoundException();}
        J.Require((info.Attributes&(FileAttributes.Directory|FileAttributes.ReparsePoint))==0&&info.Length<=1024*1024,"模板文件不可用或超过 1 MiB。");
        var bytes=await File.ReadAllBytesAsync(target);J.Require(bytes.Length<=1024*1024,"模板文件超过 1 MiB。");return (J.Hash(bytes),bytes);
    }
    static JsonNode Parse(byte[] bytes){try{return JsonNode.Parse(bytes)??throw new JsonException();}catch(JsonException){throw new ApiException("模板 JSON 无法解析。");}}
    static async Task<(string revision,byte[] bytes,JsonNode value)> ReadFile(string target){var r=await ReadBytes(target);return(r.revision,r.bytes,Parse(r.bytes));}
    static async Task Replace(string target,byte[] bytes,Func<Task>? beforeRename=null)
    {
        void Check(){if(J.Exists(target))J.Require((File.GetAttributes(target)&(FileAttributes.Directory|FileAttributes.ReparsePoint))==0,"模板文件不能是符号链接。");}Check();
        var temp=Path.Combine(Path.GetDirectoryName(target)!,".sync-"+J.Id()+".tmp");
        try{await using(var stream=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){await stream.WriteAsync(bytes);await stream.FlushAsync();stream.Flush(true);}if(beforeRename!=null)await beforeRename();Check();File.Move(temp,target,true);}finally{File.Delete(temp);}
    }
    static async Task Import(string target,JsonNode value,bool backup)
    {if(backup)try{await Replace(Regex.Replace(target,@"\.json$",".before-source.json"),(await ReadFile(target)).bytes);}catch(Exception e)when(Missing(e)){}await Replace(target,Bytes(value));}
    async Task<T> Transaction<T>(string id,Func<Task<T>> action){var gate=queues.GetOrAdd(id,_=>new(1,1));await gate.WaitAsync();try{return await action();}finally{gate.Release();}}
    static JsonObject Manifest(JsonNode value,string id)
    {
        J.Require(value is JsonObject&&value.I("version")==1&&value.S("id")==id&&value["name"].IsString()&&value.S("name").Trim().Length>0&&value.S("name").Length<=80&&value["description"].IsString()&&value.S("description").Length<=300&&value.S("colorsFile")=="colors.json"&&value["bases"] is JsonArray b&&b.Count>0&&b.All(x=>x.IsString()&&TemplateColors.Bases.Contains(x.Str())),"模板说明文件无效。");
        var name=value.S("name");if(Names.TryGetValue(id,out var names)&&name==names.oldName)name=names.name;
        return new JsonObject{["version"]=1,["id"]=id,["name"]=name,["description"]=value.S("description"),["bases"]=J.N(value.A("bases").Select(x=>x.Str()).Distinct()),["colorsFile"]="colors.json"};
    }
    static bool IsRetired(JsonNode raw,JsonObject template)=>Retired.TryGetValue(template.S("id"),out var old)&&raw is JsonObject obj&&!obj.Any(p=>!template.ContainsKey(p.Key))&&raw.S("name")==old.name&&raw.S("description")==old.description&&raw.A("bases").Select(x=>x.Str()).SequenceEqual(old.bases);
    async Task<bool> IsBundledStarter(JsonObject template){if(!Names.ContainsKey(template.S("id")))return false;try{return JsonNode.DeepEquals(template,Manifest((await ReadFile(Path.Combine(bundledDirectory,template.S("id"),"template.json"))).value,template.S("id")));}catch(Exception e)when(Missing(e)){return false;}}
    static JsonObject MissingReasoning(JsonNode? current,JsonNode fallback){var r=new JsonObject();foreach(var f in new[]{"reasoningEffects","reasoningTrackProfiles"})if(current?[f]==null&&fallback[f]!=null)r[f]=fallback[f].Copy();return r;}
    static JsonObject RestoreReasoning(JsonNode current,JsonNode sourceColors){var result=current.DeepClone().AsObject();foreach(var f in new[]{"reasoningEffects","reasoningTrackProfiles"})if(sourceColors[f] is JsonObject src){var merged=src.DeepClone().AsObject();if(current[f] is JsonObject cur)foreach(var p in cur)merged[p.Key]=p.Value.Copy();result[f]=merged;}return result;}
    // Source changes win only at changed leaves; unchanged leaves retain runtime customizations.
    static JsonNode? Merge(JsonNode? previous,JsonNode? next,JsonNode? current)
    {
        if(JsonNode.DeepEquals(previous,next))return current.Copy();
        if(previous is JsonObject old&&next is JsonObject incoming){var output=new JsonObject();var cur=current as JsonObject;foreach(var key in old.Select(p=>p.Key).Concat(incoming.Select(p=>p.Key)).Concat(cur?.Select(p=>p.Key)??[]).Distinct()){var value=Merge(old[key],incoming[key],cur?[key]);if(value!=null)output[key]=value;}return output;}
        return next.Copy();
    }
    public async Task Initialize()
    {
        Directory.CreateDirectory(directory);PlainDirectory(directory,"模板根目录不可用。");
        if(Directory.Exists(bundledDirectory))foreach(var folder in Directory.EnumerateDirectories(bundledDirectory)) {
            var id=Path.GetFileName(folder);if(!ValidId(id))continue;
            try{var raw=(await ReadFile(Path.Combine(folder,"template.json"))).value;var meta=Manifest(raw,id);if(IsRetired(raw,meta))continue;var dest=Path.Combine(directory,id);Directory.CreateDirectory(dest);Folder(id);try{await using var stream=new FileStream(Path.Combine(dest,"template.json"),FileMode.CreateNew,FileAccess.Write,FileShare.None);await stream.WriteAsync(Bytes(meta));}catch(IOException)when(J.Exists(Path.Combine(dest,"template.json"))){} }
            catch(Exception e){sourceWarnings.Add(id+"："+e.Message);}
        }
        if(source!=null&&source!=directory)try{var saved=(await ReadFile(Path.Combine(directory,".source-state.json"))).value;if(saved.I("version")==1&&saved.S("source")==source&&saved["templates"] is JsonObject)sourceState=saved.AsObject();}catch(Exception e){if(!Missing(e))sourceWarnings.Add("源同步记录无效，将保留现有配色后重新连接。");}
        await SyncSource();
        if(source!=null&&source!=directory){pollingCancellation=new();polling=Poll(pollingCancellation.Token);}
    }
    async Task Poll(CancellationToken token){using var timer=new PeriodicTimer(TimeSpan.FromMilliseconds(1500));try{while(await timer.WaitForNextTickAsync(token))await SyncSource();}catch(OperationCanceledException)when(token.IsCancellationRequested){} }
    public async Task SyncSource()
    {
        if(source==null||source==directory||closed)return;await sync.WaitAsync();try {
            if(closed)return;var warnings=new List<string>();var changed=false;
            try {
                PlainDirectory(source,"模板源目录不可用或为链接。");
                foreach(var entry in Directory.EnumerateDirectories(source)) {
                    var id=Path.GetFileName(entry);if(!ValidId(id))continue;
                    try {
                        PlainDirectory(entry,"模板源目录不能是链接。");var meta=await ReadFile(Path.Combine(entry,"template.json"));var template=Manifest(meta.value,id);if(IsRetired(meta.value,template))continue;
                        var raw=await ReadFile(Path.Combine(entry,"colors.json"));var colors=validator.Validate(raw.value);sourceRecords[id]=new JsonObject{["template"]=template.Copy(),["colors"]=colors.Copy()};
                        var previous=SourceRecord(id);var dest=Path.Combine(directory,id);var recover=previous?.S("colors")==raw.revision&&previous?["baseline"]!=null&&MissingReasoning(previous["baseline"],colors).Count>0;
                        if(!recover&&previous?.S("metadata")==meta.revision&&previous.S("colors")==raw.revision&&previous["baseline"]!=null&&File.Exists(Path.Combine(dest,"template.json"))&&File.Exists(Path.Combine(dest,"colors.json")))continue;
                        await Transaction(id,async()=>{
                            Directory.CreateDirectory(dest);Folder(id);var metaPath=Path.Combine(dest,"template.json");var colorsPath=Path.Combine(dest,"colors.json");bool hasMeta=J.Exists(metaPath),hasColors=J.Exists(colorsPath);
                            if(!hasMeta||previous!=null&&previous.S("metadata")!=meta.revision&&!await IsBundledStarter(template))await Import(metaPath,template,hasMeta);
                            if(previous!=null&&previous.S("colors")!=raw.revision||!hasColors||recover) {
                                var current=hasColors?(await ReadFile(colorsPath)).value:null;var oldDefaults=previous?["baseline"];
                                try{oldDefaults=(await ReadFile(Path.Combine(dest,"colors.baseline.json"))).value["colors"];}catch(Exception e)when(Missing(e)){}
                                JsonObject incoming,defaults;
                                if(recover){incoming=validator.Validate(RestoreReasoning(current??oldDefaults??colors,colors));defaults=validator.Validate(RestoreReasoning(oldDefaults??colors,colors),false);}
                                else {incoming=previous?["baseline"]!=null&&current!=null?validator.Validate(Merge(previous["baseline"],colors,current)):!hasColors&&oldDefaults!=null&&previous?.S("colors")==raw.revision?validator.Validate(oldDefaults):colors;
                                    defaults=previous?["baseline"]!=null&&oldDefaults!=null?validator.Validate(Merge(previous["baseline"],colors,oldDefaults),false):validator.Validate(colors,false);}
                                await Import(colorsPath,incoming,hasColors);var runtime=await ReadFile(colorsPath);await Replace(Path.Combine(dest,"colors.baseline.json"),Bytes(new JsonObject{["version"]=1,["colors"]=defaults,["runtimeRevision"]=runtime.revision}));
                            }
                            return true;
                        });
                        lock(sourceStateLock)sourceState["templates"]![id]=new JsonObject{["metadata"]=meta.revision,["colors"]=raw.revision,["baseline"]=colors.Copy()};changed=true;
                    }catch(Exception e){warnings.Add(id+"："+e.Message+"（保留上一份有效模板）");}
                }
                if(changed){byte[] snapshot;lock(sourceStateLock)snapshot=Bytes(sourceState);await Replace(Path.Combine(directory,".source-state.json"),snapshot);}
            }catch(Exception e){warnings.Add("模板源同步："+e.Message);}
            sourceWarnings=warnings;
        }finally{sync.Release();}
    }
    public async Task<JsonObject?> Read(string id,bool refresh=true,bool catalogOnly=false)
    {
        if(refresh)await SyncSource();var target=Folder(id);var raw=(await ReadFile(Path.Combine(target,"template.json"))).value;var template=Manifest(raw,id);if(catalogOnly&&IsRetired(raw,template))return null;
        var file=Path.Combine(target,"colors.json");(string revision,byte[] bytes,JsonNode value) stored;
        try{stored=await ReadFile(file);}catch(Exception e)when(Missing(e)) {
            JsonNode? fallback=null;try{fallback=(await ReadFile(Path.Combine(target,"colors.baseline.json"))).value["colors"];}catch(Exception ex)when(Missing(ex)){}
            fallback??=sourceRecords.GetValueOrDefault(id)?["colors"]??SourceRecord(id)?["baseline"];
            fallback??=(await ReadFile(Path.Combine(bundledDirectory,id,"colors.json"))).value;await Replace(file,Bytes(validator.Validate(fallback,false)));stored=await ReadFile(file);
        }
        var cacheFile=Path.Combine(target,"colors.baseline.json");JsonNode? cache=null;try{cache=(await ReadFile(cacheFile)).value;}catch(Exception e)when(Missing(e)){}
        var colors=validator.Validate(stored.value);var recovered=MissingReasoning(cache?["colors"],colors);JsonObject defaults;
        if(cache?.I("version")==1&&cache.S("runtimeRevision")==stored.revision){var c=cache["colors"]!.DeepClone().AsObject();foreach(var p in recovered)c[p.Key]=p.Value.Copy();defaults=validator.Validate(c,false);}
        else if(cache?.I("version")==1)defaults=validator.Validate(colors,false);
        else {
            JsonNode? d=sourceRecords.GetValueOrDefault(id)?["colors"]??SourceRecord(id)?["baseline"];
            if(d==null)try{d=(await ReadFile(Path.Combine(bundledDirectory,id,"colors.json"))).value;}catch(Exception e)when(Missing(e)){}
            defaults=validator.Validate(d??stored.value,false);
        }
        if(cache==null||cache.S("runtimeRevision")!=stored.revision||recovered.Count>0)await Replace(cacheFile,Bytes(new JsonObject{["version"]=1,["colors"]=defaults.Copy(),["runtimeRevision"]=stored.revision}));
        return new JsonObject{["template"]=template,["directory"]=target,["colors"]=colors,["revision"]=stored.revision,["defaults"]=defaults,["defaultsRevision"]=J.Hash(defaults.ToJsonString(J.Options))};
    }
    public async Task<JsonObject> List()
    {
        await SyncSource();var templates=new List<JsonObject>();var warnings=new List<string>(sourceWarnings);
        foreach(var entry in Directory.EnumerateDirectories(directory)){var id=Path.GetFileName(entry);if(!ValidId(id))continue;try{var read=await Read(id,false,true);if(read!=null){var item=read["template"]!.DeepClone().AsObject();item["directory"]=read["directory"].Copy();templates.Add(item);}}catch(Exception e){warnings.Add(id+"："+e.Message);}}
        templates.Sort((a,b)=>a.S("id")=="claude-olive-gold"?-1:b.S("id")=="claude-olive-gold"?1:CultureInfo.GetCultureInfo("zh-CN").CompareInfo.Compare(a.S("name"),b.S("name")));
        return new JsonObject{["directory"]=directory,["sourceDirectory"]=source,["templates"]=J.Array(templates),["warnings"]=J.N(warnings)};
    }
    async Task<(string revision,byte[] bytes)> ReadIconBytes(string root,string id){PlainDirectory(root,"模板图标目录不可用或为链接。");if(id!="")PlainDirectory(Path.Combine(root,id),"模板图标目录不可用或为链接。");return await ReadBytes(Path.Combine(root,id,"icons.json"));}
    public async Task<JsonObject> ReadIcons(string id)
    {
        J.Require(ValidId(id),"模板标识无效。");var roots=new[]{directory,source,bundledDirectory}.Where(x=>x!=null).Select(x=>x!).ToArray();var candidates=roots.Select(root=>(root,id)).Concat(roots.Select(root=>(root,id:"")));var seen=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var icons=new JsonObject();var localIcons=new JsonObject();string? revision=null;var warnings=new List<string>();
        foreach(var (root,templateId) in candidates){var file=Path.Combine(root,templateId,"icons.json");if(!seen.Add(file))continue;var local=root==directory&&templateId==id;
            try{var record=await ReadIconBytes(root,templateId);if(local)revision=record.revision;var raw=Parse(record.bytes);J.Require(raw is JsonObject&&raw.I("version")==1&&raw["icons"] is JsonObject,"模板图标包格式无效。");var valid=iconValidator.Normalize(raw["icons"]);var skipped=raw["icons"]!.AsObject().Count-valid.Count;if(skipped>0)warnings.Add($"{file} 中有 {skipped} 项未知或无效的图标，已使用回退。");if(local)localIcons=valid.DeepClone().AsObject();foreach(var p in valid)if(!icons.ContainsKey(p.Key))icons[p.Key]=p.Value.Copy();}
            catch(Exception e){if(!Missing(e))warnings.Add($"无法读取 {file}：{e.Message} 已使用回退。");}
        }
        var pack=new JsonObject{["version"]=1,["icons"]=icons,["localIcons"]=localIcons,["revision"]=revision,["warning"]=string.Join("；",warnings)};pack["packRevision"]=J.Hash(pack.ToJsonString(J.Options));return pack;
    }
    static void SaveInput(string id,JsonNode input,string label){J.Require(ValidId(id)&&input is JsonObject&&input.AsObject().ContainsKey("revision")&&(input["revision"]==null||input["revision"].IsString()&&Regex.IsMatch(input.S("revision"),"^[a-f0-9]{64}$")),label+"保存参数无效。");}
    public async Task<JsonObject> SaveIcons(string id,JsonNode input)
    {
        SaveInput(id,input,"图标");var pack=iconValidator.Pack(new JsonObject{["version"]=input["version"].Copy(),["icons"]=input["localIcons"].Copy()});var bytes=Bytes(pack);J.Require(bytes.Length<=1024*1024,"模板图标文件超过 1 MiB。");
        return await Transaction(id,async()=>{var target=Folder(id);async Task Check(){string? revision=null;try{revision=(await ReadIconBytes(directory,id)).revision;}catch(Exception e){if(!Missing(e))throw new ApiException("本地图标文件无法安全写入："+e.Message,409);}J.Require(revision==input["revision"]?.Str(),"模板图标已被外部修改，请重新读取后再保存。",409);}await Check();await Replace(Path.Combine(target,"icons.json"),bytes,Check);return await ReadIcons(id);});
    }
    public async Task<JsonObject> Save(string id,JsonNode input)
    {
        SaveInput(id,input,"模板");var colors=validator.Validate(input["colors"]);var bytes=Bytes(colors);J.Require(bytes.Length<=1024*1024,"模板文件超过 1 MiB。");await SyncSource();
        return await Transaction(id,async()=>{var current=(await Read(id,false))!;J.Require(current.S("revision")==input["revision"]?.Str(),"模板配色文件已被外部修改，请重新读取后再保存。",409);var target=Folder(id);var file=Path.Combine(target,"colors.json");await Replace(Path.Combine(target,"colors.before-save.json"),(await ReadFile(file)).bytes);await Replace(file,bytes,async()=>{var checkedRecord=(await Read(id,false))!;J.Require(checkedRecord.S("revision")==input["revision"]?.Str(),"模板配色文件已被外部修改，请重新读取后再保存。",409);});var stored=await ReadFile(file);await Replace(Path.Combine(target,"colors.baseline.json"),Bytes(new JsonObject{["version"]=1,["colors"]=validator.Validate(colors,false),["runtimeRevision"]=stored.revision}));return (await Read(id,false))!;});
    }
    public async Task<JsonObject> Open(string id){var record=(await Read(id))!;J.Require(OperatingSystem.IsWindows(),"当前系统不支持 Windows 资源管理器。");await shell.OpenDirectory(record.S("directory"));return new JsonObject{["ok"]=true,["directory"]=record.S("directory")};}
    public async ValueTask DisposeAsync(){closed=true;pollingCancellation?.Cancel();if(polling!=null)await polling;await sync.WaitAsync();sync.Release();foreach(var gate in queues.Values){await gate.WaitAsync();gate.Release();}pollingCancellation?.Dispose();}
}
