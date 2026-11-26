using System.Text.Json.Nodes;

namespace Hive;

public sealed class CatalogService:IAsyncDisposable
{
    readonly Templates templates;
    readonly Plugins plugins;
    public CatalogService(string project,string local,string appData,ShellBridge shell)
    {
        var directory=Path.GetFullPath(Environment.GetEnvironmentVariable("HIVE_TEMPLATES_DIR") is {Length:>0} d?d:Path.Combine(local,"templates"));
        var sourceValue=Environment.GetEnvironmentVariable("HIVE_TEMPLATES_SOURCE");
        var packaged = shell.Desktop && Environment.GetEnvironmentVariable("HIVE_DESKTOP_PACKAGED") == "1";
        var source = sourceValue is { Length: > 0 } ? Path.GetFullPath(sourceValue) : packaged ? null : Path.Combine(project, "templates");
        templates=new Templates(directory,Path.Combine(project,"templates"),source,new TemplateColors(project),new Icons(project),shell);
        var sample=Path.Combine(project,"plugin-examples","selection-lines.json");if(!File.Exists(sample))sample=Path.Combine(project,"server","plugin-examples","selection-lines.json");
        plugins=new Plugins(Path.Combine(appData,"plugins"),local,sample,shell);
    }
    public Task Initialize()=>templates.Initialize();
    public async Task<bool> Handle(HttpContext ctx,string route,JsonNode body)
    {
        JsonObject? result=null;var get=HttpMethods.IsGet(ctx.Request.Method);var post=HttpMethods.IsPost(ctx.Request.Method);
        if(route=="/templates"&&get)result=await templates.List();
        else if(route=="/plugins"&&get)result=await plugins.List();
        else if(route=="/plugins/enabled"&&post)result=await plugins.SetEnabled(body);
        else if(route=="/plugins/sample"&&post)result=await plugins.InstallSample();
        else if(route=="/plugins/open"&&post)result=await plugins.Open();
        else if(route.StartsWith("/templates/",StringComparison.Ordinal)) {
            var parts=route.Split('/');if(parts.Length is <3 or >4)return false;var id=Uri.UnescapeDataString(parts[2]);
            if(parts.Length==3&&get){result=await templates.Read(id);if(ctx.Request.Query["colorsOnly"]!="1"){var pack=await templates.ReadIcons(id);if(ctx.Request.Query["iconPackRevision"]==pack.S("packRevision"))result!["iconPackUnchanged"]=true;else result!["iconPack"]=pack;}}
            else if(parts.Length==3&&post)result=await templates.Save(id,body);
            else if(parts.Length==4&&parts[3]=="icons"&&get)result=await templates.ReadIcons(id);
            else if(parts.Length==4&&parts[3]=="icons"&&post)result=await templates.SaveIcons(id,body);
            else if(parts.Length==4&&parts[3]=="open"&&post)result=await templates.Open(id);
        }
        if(result==null)return false;await ctx.Response.WriteAsJsonAsync(result,J.Options,ctx.RequestAborted);return true;
    }
    public ValueTask DisposeAsync()=>templates.DisposeAsync();
}
