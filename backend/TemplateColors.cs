using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Hive;

public sealed class TemplateColors(string project)
{
    public static readonly string[] Bases=["black","gray","white","custom"];
    static readonly string[] Roles=["accent","secondary","link","success","warning","danger"];
    static readonly string[] Surfaces="titleBar ribbonTitleBackground ribbonTitleText ribbon ribbonContentText ribbonBorder leftRailBackground leftRailIcon rightRailBackground rightRailIcon workspace panel panelHeader panelBorder panelInnerBorder document documentText selectedTab settingsBackground settingsSidebar settingsCard settingsBorder popup popupBorder input inputBorder uiText mutedText selection".Split(' ');
    static readonly Dictionary<string,string[]> DockFields=new(){["frame"]=["background","border","borderWidth","borderRadius","shadow"],["aiButton"]=["background","icon","hoverIcon","border","borderWidth","borderRadius"],["sideButtons"]=["background","icon","border","borderWidth","borderRadius","activeIcon","activeBackground","activeBorder","hoverIcon","hoverBackground"]};
    readonly JsonObject dockingFields=JsonNode.Parse(File.ReadAllText(Path.Combine(project,"desktop","docking-colors.json")))!.AsObject();
    readonly JsonObject editorFields=JsonNode.Parse(File.ReadAllText(Path.Combine(project,"desktop","editor-colors.json")))!.AsObject();
    static bool Color(JsonNode? n,bool alpha=false)=>n.IsString()&&Regex.IsMatch(n.Str(),alpha?"^#[0-9a-f]{6}(?:[0-9a-f]{2})?$":"^#[0-9a-f]{6}$",RegexOptions.IgnoreCase);
    static bool Number(JsonNode? n,out double d){d=0;return n is JsonValue v&&v.TryGetValue<double>(out d)&&double.IsFinite(d);}
    static JsonObject Palette(JsonNode? value)
    {
        J.Require(value is JsonObject&&Roles.All(r=>Color(value[r])),"模板语义色配置无效。");var result=new JsonObject();foreach(var role in Roles)result[role]=value![role]!.Str().ToLowerInvariant();return result;
    }
    static JsonObject Dock(JsonNode? value)
    {
        J.Require(value is JsonObject,"模板底栏配置无效。");var result=new JsonObject();
        foreach(var (group,fields) in DockFields) {
            J.Require(value![group] is JsonObject,"模板底栏配置不完整。");var record=new JsonObject();
            foreach(var field in fields) {
                var item=value[group]![field];
                if(field is "borderWidth" or "borderRadius") {J.Require(Number(item,out var d)&&d>=0&&d<=(field=="borderWidth"?8:100),"模板底栏尺寸无效。");record[field]=item.Copy();}
                else if(group=="aiButton"&&field=="background"&&item.Str()=="accent")record[field]="accent";
                else{J.Require(Color(item,true),"模板底栏颜色无效。");record[field]=item.Str().ToLowerInvariant();}
            }
            result[group]=record;
        }
        return result;
    }
    public JsonObject Validate(JsonNode? value,bool allowDefault=true)
    {
        if(value is not JsonObject)throw new ApiException("模板配色格式无效。");
        J.Require(value is JsonObject&&value.I("version")==1&&Bases.Contains(value.S("base"))&&value.S("palette")=="hive"&&Color(value["customBase"])&&new[]{"auto","manual"}.Contains(value.S("surfaceContrastMode"))&&Number(value["surfaceContrast"],out var contrast)&&contrast>=50&&contrast<=150,"模板配色格式无效。");
        var result=new JsonObject{["version"]=1,["base"]=value!.S("base"),["customBase"]=value.S("customBase").ToLowerInvariant(),["palette"]="hive",["colors"]=Palette(value["colors"]),["surfaceContrastMode"]=value.S("surfaceContrastMode"),["surfaceContrast"]=value["surfaceContrast"].Copy(),["surfaceColors"]=new JsonObject(),["writingDock"]=Dock(value["writingDock"]),["writingDockProfiles"]=new JsonObject()};
        J.Require(value["surfaceColors"] is JsonObject&&value["writingDockProfiles"] is JsonObject,"模板分区配置无效。");
        foreach(var b in Bases) {
            if(value["surfaceColors"]!.AsObject().ContainsKey(b)) {
                var entry=value["surfaceColors"]![b];J.Require(entry is JsonObject,"模板区域颜色无效。");var output=new JsonObject();
                foreach(var key in Surfaces)if(entry!.AsObject().ContainsKey(key)){J.Require(Color(entry[key]),"模板区域颜色无效。");output[key]=entry[key].Str().ToLowerInvariant();}result["surfaceColors"]![b]=output;
            }
            if(value["writingDockProfiles"]!.AsObject().ContainsKey(b))result["writingDockProfiles"]![b]=Dock(value["writingDockProfiles"]![b]);
        }
        if(value.AsObject().ContainsKey("colorProfiles")) {
            J.Require(value["colorProfiles"] is JsonObject,"模板语义色档案无效。");var profiles=new JsonObject();foreach(var b in Bases)if(value["colorProfiles"]!.AsObject().ContainsKey(b))profiles[b]=Palette(value["colorProfiles"]![b]);result["colorProfiles"]=profiles;
        }
        if(allowDefault&&value.AsObject().ContainsKey("defaultScheme"))result["defaultScheme"]=Validate(value["defaultScheme"],false);
        foreach(var (field,definitions,label) in new[]{("dockingProfiles",dockingFields,"停靠引导"),("editorProfiles",editorFields,"文本编辑页面")})if(value.AsObject().ContainsKey(field)) {
            J.Require(value[field] is JsonObject,label+"颜色档案无效。");var profiles=new JsonObject();
            foreach(var b in Bases)if(value[field]!.AsObject().ContainsKey(b)) {
                var raw=value[field]![b];J.Require(raw is JsonObject,label+"颜色档案无效。");var profile=new JsonObject();
                foreach(var pair in definitions)if(raw!.AsObject().ContainsKey(pair.Key)){J.Require(Color(raw[pair.Key],pair.Value.B("alpha")),label+"颜色无效。");profile[pair.Key]=raw[pair.Key].Str().ToLowerInvariant();}
                if(profile.Count>0)profiles[b]=profile;
            }
            result[field]=profiles;
        }
        if(value["reasoningTrackProfiles"] is JsonObject tracks) {
            var profiles=new JsonObject();foreach(var b in Bases)if(tracks[b] is JsonObject track&&new[]{"left","middle","right"}.All(p=>Color(track[p])))profiles[b]=new JsonObject{["left"]=track.S("left").ToLowerInvariant(),["middle"]=track.S("middle").ToLowerInvariant(),["right"]=track.S("right").ToLowerInvariant()};result["reasoningTrackProfiles"]=profiles;
        }
        if(value["reasoningEffects"] is JsonObject effects) {
            var output=new JsonObject();foreach(var level in new[]{"off","minimal","low","medium","high","xhigh","max"})if(effects[level] is JsonObject raw) {
                var effect=new JsonObject();if(Color(raw["color"]))effect["color"]=raw.S("color").ToLowerInvariant();
                foreach(var (key,max,round) in new[]{("glow",1d,false),("particles",8d,true),("duration",2000d,true)})if(Number(raw[key],out var d)){var clamped=Math.Clamp(d,0,max);effect[key]=round?Math.Floor(clamped+.5):clamped;}
                if(raw["easing"].IsString()&&Regex.IsMatch(raw.S("easing"),@"^cubic-bezier\(\s*(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)\s*,\s*-?\d+(?:\.\d+)?\s*,\s*(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)\s*,\s*-?\d+(?:\.\d+)?\s*\)$"))effect["easing"]=raw.S("easing");output[level]=effect;
            }
            result["reasoningEffects"]=output;
        }
        return result;
    }
}
