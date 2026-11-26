using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Hive;

public sealed class Plugins(string directory,string stateDirectory,string sampleFile,ShellBridge shell)
{
    readonly SemaphoreSlim writes=new(1,1);
    string StateFile=>Path.Combine(stateDirectory,"plugins-enabled.json");
    static bool Id(string s)=>Regex.IsMatch(s,@"^[a-z][a-z0-9.-]{0,63}$");
    static bool Text(JsonNode? n,int max)=>n.IsString()&&n.Str().Trim().Length>0&&n.Str().Length<=max&&!Regex.IsMatch(n.Str(),@"[\x00-\x1f]");
    void Prepare() { Directory.CreateDirectory(directory);J.Require((File.GetAttributes(directory)&FileAttributes.Directory)!=0&&(File.GetAttributes(directory)&FileAttributes.ReparsePoint)==0,"插件目录必须是普通目录。",409); }
    static JsonObject Manifest(JsonNode? value)
    {
        if(value is not JsonObject)throw new ApiException("插件名称、标识或清单版本无效。");
        J.Require(value is JsonObject obj&&value.I("version")==1&&Id(value.S("id"))&&Text(value["name"],48)&&(!obj.ContainsKey("description")||Text(value["description"],240)),"插件名称、标识或清单版本无效。");
        var entry=value!["contribution"];
        J.Require(entry is JsonObject&&entry.S("slot")=="editor.status"&&new[]{"document-lines","selected-lines","line-length"}.Contains(entry.S("metric"))&&Text(entry?["label"],28),"插件的扩展位置、统计类型或标签无效。");
        return new JsonObject{["id"]=value.S("id"),["name"]=value.S("name").Trim(),["description"]=value.S("description").Trim(),["contribution"]=new JsonObject{["slot"]="editor.status",["metric"]=entry.S("metric"),["label"]=entry.S("label").Trim()}};
    }
    async Task<HashSet<string>> Enabled()
    {
        if(!J.Exists(StateFile))return [];var state=await J.ReadObject(StateFile,"已启用插件");
        J.Require(state["ids"] is JsonArray ids&&ids.Count<=64&&ids.All(v=>v.IsString()&&Id(v.Str())),"已启用插件的配置格式无效。",409);
        return state.A("ids").Select(x=>x.Str()).ToHashSet();
    }
    static async Task<JsonObject> ReadManifest(string file)
    {
        var info=new FileInfo(file);J.Require(info.Exists&&(info.Attributes&(FileAttributes.Directory|FileAttributes.ReparsePoint))==0&&info.Length<=16384,"请选择 16 KB 以内的普通 JSON 文件。");
        await using var stream=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.ReadWrite);
        var bytes=new byte[16385];var read=0;while(read<bytes.Length){var count=await stream.ReadAsync(bytes.AsMemory(read));if(count==0)break;read+=count;}
        J.Require(read<=16384,"插件清单超过 16 KB。");
        var text=Encoding.UTF8.GetString(bytes,0,read);if(text.StartsWith('\uFEFF'))text=text[1..];return Manifest(JsonNode.Parse(text));
    }
    public async Task<JsonObject> List()
    {
        Prepare();var enabled=await Enabled();
        // Directory enumeration carries attributes so a vanished/broken individual entry is
        // handled by ReadManifest below rather than aborting discovery of independent plugins.
        var files=new DirectoryInfo(directory).EnumerateFileSystemInfos().Where(p=>p.Name.EndsWith(".json",StringComparison.OrdinalIgnoreCase)&&(p.Attributes&FileAttributes.Directory)==0).Select(p=>p.Name).Order(StringComparer.Create(System.Globalization.CultureInfo.GetCultureInfo("en"),false)).ToArray();
        var errors=new JsonArray();var found=new Dictionary<string,JsonObject>();var duplicates=new HashSet<string>();
        foreach(var file in files.Take(64))try {
            var plugin=await ReadManifest(Path.Combine(directory,file!));var id=plugin.S("id");
            if(found.TryGetValue(id,out var previous)){errors.Add(new JsonObject{["file"]=previous.S("file"),["message"]="插件标识重复。"});found.Remove(id);duplicates.Add(id);}
            if(duplicates.Contains(id))errors.Add(new JsonObject{["file"]=file,["message"]="插件标识重复。"});
            else{plugin["file"]=file;plugin["enabled"]=enabled.Contains(id);found[id]=plugin;}
        }catch(Exception error){errors.Add(new JsonObject{["file"]=file,["message"]=error is JsonException?"插件清单不是有效的 JSON。":error is ApiException?error.Message:"无法读取插件清单。"});}
        return new JsonObject{["directory"]=directory,["plugins"]=J.Array(found.Values),["errors"]=errors,["limitReached"]=files.Length>64,["canOpenDirectory"]=shell.Desktop,["canInstallSample"]=!files.Any(n=>string.Equals(n,"hive-selection-lines.json",StringComparison.OrdinalIgnoreCase))};
    }
    public async Task<JsonObject> SetEnabled(JsonNode input)
    {
        await writes.WaitAsync();try {
            J.Require(input is JsonObject&&input["id"].IsString()&&input["enabled"].IsBool(),"请选择有效插件。");var current=await List();var id=input.S("id");
            J.Require(current.A("plugins").Any(p=>p.S("id")==id),"插件已移除或无法读取，请刷新列表。",404);
            var enabled=current.A("plugins").Where(p=>p.B("enabled")).Select(p=>p.S("id")).ToHashSet();if(input.B("enabled"))enabled.Add(id);else enabled.Remove(id);
            await J.Write(StateFile,new JsonObject{["ids"]=J.N(enabled)});foreach(var plugin in current.A("plugins"))plugin!["enabled"]=enabled.Contains(plugin.S("id"));return current;
        }finally{writes.Release();}
    }
    public async Task<JsonObject> InstallSample()
    {
        await writes.WaitAsync();try {
            Prepare();var destination=Path.Combine(directory,"hive-selection-lines.json");var bytes=await File.ReadAllBytesAsync(sampleFile);
            try{await using var stream=new FileStream(destination,FileMode.CreateNew,FileAccess.Write,FileShare.None);await stream.WriteAsync(bytes);}catch(IOException)when(J.Exists(destination)){}
            return await List();
        }finally{writes.Release();}
    }
    public async Task<JsonObject> Open(){J.Require(shell.Desktop,"请在系统文件管理器中手动打开插件目录。",503);Prepare();await shell.OpenDirectory(directory);return new JsonObject{["ok"]=true};}
}
