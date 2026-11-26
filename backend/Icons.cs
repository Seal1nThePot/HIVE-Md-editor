using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Hive;

// Only plain geometry is accepted; no XML, URLs, scripts, inherited attributes or arbitrary CSS.
public sealed class Icons(string project)
{
    readonly JsonObject builtins = JsonNode.Parse(File.ReadAllText(Path.Combine(project,"shared","icons.json")))!.AsObject();
    static readonly Dictionary<string,string[]> Geometry = new() {
        ["path"]=["d"], ["circle"]=["cx","cy","r"], ["ellipse"]=["cx","cy","rx","ry"],
        ["rect"]=["x","y","width","height","rx","ry"], ["line"]=["x1","y1","x2","y2"], ["polyline"]=["points"], ["polygon"]=["points"] };
    static readonly Dictionary<string,string[]> Required = new() { ["path"]=["d"], ["circle"]=["r"], ["ellipse"]=["rx","ry"], ["rect"]=["width","height"], ["line"]=[], ["polyline"]=["points"], ["polygon"]=["points"] };
    static readonly string[] Drawing=["fill","stroke","stroke-width","stroke-linecap","stroke-linejoin","fill-rule","clip-rule"];
    const string NumberPattern = @"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?";
    static readonly Regex Numeric=new("^"+NumberPattern+"$",RegexOptions.IgnoreCase);
    static readonly Regex Coordinate=new(NumberPattern,RegexOptions.IgnoreCase);
    static ApiException Invalid()=>new("图标只接受带有效 viewBox 的纯矢量 SVG 图形。");
    static bool Number(string s)=>Numeric.IsMatch(s)&&double.TryParse(s,NumberStyles.Float,CultureInfo.InvariantCulture,out var n)&&double.IsFinite(n);
    static double Value(string s)=>double.Parse(s,NumberStyles.Float,CultureInfo.InvariantCulture);
    static string Paint(string name,string value)
    {
        if(name is "fill" or "stroke") {
            if(value is "none" or "currentColor")return value;
            var m=Regex.Match(value,@"^var\(\s*(--icon-(?:accent|danger))\s*,\s*currentColor\s*\)$");
            if(m.Success)return "var("+m.Groups[1].Value+",currentColor)";
            if(Regex.IsMatch(value,@"^(?:#[\da-f]{3,8}|[a-z]+|(?:rgb|rgba|hsl|hsla)\([\d.% ,/+\-]+\))$",RegexOptions.IgnoreCase))return value=="transparent"?"none":"currentColor";
        }
        else if(name=="stroke-linecap"&&new[]{"butt","round","square"}.Contains(value))return value;
        else if(name=="stroke-linejoin"&&new[]{"miter","round","bevel"}.Contains(value))return value;
        else if((name=="fill-rule"||name=="clip-rule")&&new[]{"nonzero","evenodd"}.Contains(value))return value;
        else if(name=="stroke-width"&&Number(value)&&Value(value)>=0&&Value(value)<=100)return value;
        throw Invalid();
    }
    static JsonObject Draw(JsonObject raw)
    {
        var result=new JsonObject();
        foreach(var name in Drawing)if(raw.ContainsKey(name)) {
            if(!raw[name].IsString()||raw[name]!.Str().Length>80)throw Invalid();
            result[name]=Paint(name,raw[name]!.Str());
        }
        return result;
    }
    static bool PathData(string data)
    {
        var arity=new Dictionary<char,int>{{'M',2},{'L',2},{'H',1},{'V',1},{'C',6},{'S',4},{'Q',4},{'T',2},{'A',7},{'Z',0}};
        int index=0,remaining=0; char command='\0'; bool afterNumber=false;
        while(index<data.Length) {
            if(char.IsWhiteSpace(data[index])){index++;continue;}
            if(data[index]==',') {
                if(!afterNumber)return false;afterNumber=false;index++;
                while(index<data.Length&&char.IsWhiteSpace(data[index]))index++;
                if(index>=data.Length||!Regex.IsMatch(data[index].ToString(),@"[+\-.\d]"))return false;
            }
            var marker=char.ToUpperInvariant(data[index]);
            if(arity.ContainsKey(marker)) {
                if((command=='\0'&&marker!='M')||remaining!=0)return false;
                command=marker;remaining=arity[command];afterNumber=false;index++;continue;
            }
            if(command=='\0'||command=='Z')return false;
            if(remaining==0)remaining=arity[command];
            if(command=='A'&&(remaining==4||remaining==3)) {
                if(data[index]!='0'&&data[index]!='1')return false;index++;
            } else {
                var m=Coordinate.Match(data,index);if(!m.Success||m.Index!=index||!Number(m.Value))return false;index+=m.Length;
            }
            remaining--;afterNumber=true;
        }
        return command!='\0'&&remaining==0;
    }
    public static JsonObject Definition(JsonNode? value)
    {
        if(value is not JsonObject raw||!raw["viewBox"].IsString()||raw.S("viewBox").Length>80||raw["shapes"] is not JsonArray shapes||shapes.Count<1||shapes.Count>64)throw Invalid();
        var box=Regex.Split(raw.S("viewBox").Trim(),@"[\s,]+");
        if(box.Length!=4||box.Any(s=>!Number(s)||Math.Abs(Value(s))>100000)||Value(box[2])<=0||Value(box[3])<=0)throw Invalid();
        var outputShapes=new JsonArray();
        foreach(var item in shapes) {
            if(item is not JsonObject shape||!Geometry.TryGetValue(shape.S("tag"),out var geometry)||shape["attrs"] is not JsonObject attrs)throw Invalid();
            var tag=shape.S("tag");var output=Draw(attrs);
            if(attrs.Any(a=>!Drawing.Contains(a.Key)&&!geometry.Contains(a.Key)))throw Invalid();
            foreach(var key in geometry)if(attrs.ContainsKey(key)) {
                if(!attrs[key].IsString()||attrs[key]!.Str().Length>8192)throw Invalid();var s=attrs[key]!.Str();
                if(key=="d"){if(!PathData(s))throw Invalid();}
                else if(key=="points") {var points=Regex.Split(s.Trim(),@"[\s,]+");if(points.Length<4||points.Length%2!=0||points.Any(p=>!Number(p)))throw Invalid();}
                else if(!Number(s))throw Invalid();
                output[key]=s;
            }
            if(Required[tag].Any(k=>!output.ContainsKey(k)))throw Invalid();
            outputShapes.Add(new JsonObject{["tag"]=tag,["attrs"]=output});
        }
        var result=new JsonObject{["viewBox"]=string.Join(" ",box)};foreach(var pair in Draw(raw))result[pair.Key]=pair.Value.Copy();result["shapes"]=outputShapes;return result;
    }
    public JsonObject Normalize(JsonNode? raw)
    {
        var result=new JsonObject();if(raw is not JsonObject obj)return result;
        foreach(var name in builtins.Select(x=>x.Key))if(obj.ContainsKey(name))try{result[name]=Definition(obj[name]);}catch(ApiException){}
        return result;
    }
    public JsonObject Pack(JsonNode? raw)
    {
        if(raw is not JsonObject obj||obj.I("version")!=1||obj["icons"] is not JsonObject icons)throw Invalid();
        var result=new JsonObject();foreach(var pair in icons) {
            if(!builtins.ContainsKey(pair.Key))throw new ApiException("未知图标："+pair.Key);
            result[pair.Key]=Definition(pair.Value);
        }
        return new JsonObject{["version"]=1,["icons"]=result};
    }
}
