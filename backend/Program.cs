using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Hive;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.FileProviders;
using static Hive.J;

const int MaxJsonBytes = 3 * 1024 * 1024;
static string Env(string key, string fallback) => Environment.GetEnvironmentVariable(key) is { Length: > 0 } value ? value : fallback;

Console.OutputEncoding = new UTF8Encoding(false);
if (await Updates.TryRunCli(args) is int updateExit) return updateExit;
var project = Path.GetFullPath(Env("HIVE_PROJECT", Directory.GetCurrentDirectory()));
var dist = Path.GetFullPath(Env("HIVE_DIST_DIR", Path.Combine(project, "dist")));
var standalone = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "HIVE-Backend");
var root = Path.GetFullPath(Env("HIVE_DOCUMENTS", Path.Combine(standalone, "documents")));
var local = Path.GetFullPath(Env("HIVE_STATE_DIR", Path.Combine(standalone, "state")));
var appData = Path.GetFullPath(Env("HIVE_APP_DATA_DIR", local));
var shell = new ShellBridge(Env("HIVE_PIPE", "") == "1", Env("HIVE_DESKTOP_SHELL", "") == "1");
var requestedPort = Env("HIVE_PORT", "4324");
if (!int.TryParse(requestedPort, out var port) || port is < 0 or > 65535)
{
    Console.Error.WriteLine("HIVE_PORT 无效。");
    return 1;
}

using var spaces = new Workspaces(local, root, appData, shell);
if (shell.Desktop && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("HIVE_TEMPLATES_SOURCE")))
{
    var templatesSource = DesktopPaths.FindTemplateSource(project);
    if (templatesSource != null) Environment.SetEnvironmentVariable("HIVE_TEMPLATES_SOURCE", templatesSource);
}
await using var catalog = new CatalogService(project, local, appData, shell);
var models = new ModelService(local, spaces);
var native = new NativeData(appData, spaces);
var updates = new Updates(appData, shell);
var development = Env("HIVE_DESKTOP_DEV", "") == "1" && Env("HIVE_DESKTOP_PACKAGED", "") != "1";
var developmentBuild = new Lazy<Task<JsonNode>>(() => Updates.DesktopBuildInfo(project, dist, true));
var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = [], ContentRootPath = project });
builder.Logging.ClearProviders();
builder.Configuration.Sources.Clear();
builder.WebHost.ConfigureKestrel(options =>
{
    options.Listen(IPAddress.Loopback, port);
    options.AddServerHeader = false;
    options.Limits.MaxRequestBodySize = Media.MaxImageBytes;
});
builder.Services.Configure<HostOptions>(options => options.ShutdownTimeout = TimeSpan.FromSeconds(2));
await using var app = builder.Build();
using var stopUpdates = app.Lifetime.ApplicationStopping.Register(updates.Stop);

async Task WriteJson(HttpContext context, JsonNode node, JsonSerializerOptions? options = null) =>
    await context.Response.WriteAsJsonAsync(node, options ?? Options, context.RequestAborted);

async Task<byte[]> ReadBytes(HttpContext context, int limit)
{
    var request = context.Request;
    if (request.ContentLength > limit) throw new ApiException("请求内容过大。", 413);
    var feature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
    if (feature is { IsReadOnly: false }) feature.MaxRequestBodySize = limit;
    using var bytes = new MemoryStream(request.ContentLength is > 0 ? (int)request.ContentLength.Value : 0);
    var buffer = new byte[65536];
    while (await request.Body.ReadAsync(buffer, context.RequestAborted) is var size && size > 0)
    {
        if (bytes.Length + size > limit) throw new ApiException("请求内容过大。", 413);
        bytes.Write(buffer, 0, size);
    }
    return bytes.ToArray();
}
async Task<JsonNode> ReadJson(HttpContext context)
{
    if (!context.Request.HasJsonContentType()) return new JsonObject();
    var bytes = await ReadBytes(context, MaxJsonBytes);
    if (bytes.Length == 0) return new JsonObject();
    var parsed = JsonNode.Parse(bytes.AsSpan().StartsWith(new byte[] { 0xef, 0xbb, 0xbf }) ? bytes.AsSpan(3) : bytes);
    return parsed is JsonObject ? parsed : throw new ApiException("请求 JSON 必须是对象。");
}
async Task<byte[]> ReadBinary(HttpContext context, int limit)
{
    Require(context.Request.ContentType?.Split(';')[0].Trim().Equals("application/octet-stream", StringComparison.OrdinalIgnoreCase) == true, "文件内容无效。");
    return await ReadBytes(context, limit);
}
async Task WriteImage(HttpContext context, Media.ImageData image)
{
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
    context.Response.ContentType = image.Mime;
    context.Response.ContentLength = image.Bytes.Length;
    if (!HttpMethods.IsHead(context.Request.Method)) await context.Response.Body.WriteAsync(image.Bytes, context.RequestAborted);
}
static string? Query(HttpContext context, string key) =>
    context.Request.Query.TryGetValue(key, out var value) && value.Count == 1 ? value[0] : null;

var workspaceRoutes = new HashSet<string>(StringComparer.Ordinal)
{
    "writing-outline", "annotations", "scratch", "outline", "tree", "file", "folder", "rename", "workspace",
    "explorer", "images", "image-file", "references", "import", "history"
};

async Task<JsonNode> Sync(Repository repository, JsonNode body, CancellationToken cancellation)
{
    Require(body["paths"] is JsonArray && body.A("paths").Count <= 100 && body.A("paths").All(n => n.IsString()), "同步文件列表无效。");
    var paths = body.A("paths").Select(n => n.Str()).Distinct(StringComparer.Ordinal).ToArray();
    var files = new JsonNode?[paths.Length];
    await Parallel.ForEachAsync(Enumerable.Range(0, paths.Length), new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = cancellation }, async (index, _) =>
    {
        var path = paths[index];
        try { files[index] = await repository.Files.Probe(path, body["baselines"].S(path)); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ApiException or ArgumentException or NotSupportedException)
        {
            var error = e is FileNotFoundException or DirectoryNotFoundException ? "文件已在磁盘删除或移动。" : e.Message;
            files[index] = N(new { path, error });
        }
    });
    var snapshot = await repository.Files.Snapshot();
    snapshot["workspace"] = spaces.Read(repository);
    snapshot["files"] = Array(files);
    return snapshot;
}

async Task DispatchWorkspace(HttpContext context, Repository repository, string method, string route, JsonNode body)
{
    const string scratch = "自由草稿.md";
    var queryPath = Query(context, "path") ?? "";
    var file = method == "GET" ? Query(context, "file") ?? "" : body.S("file");
    var source = method == "GET" ? Query(context, "source") ?? "" : body.S("source");
    var trash = repository.Explorer;
    JsonNode result;
    switch (method, route)
    {
        case ("POST", "/workspace"): result = await spaces.Change(body, false); break;
        case ("POST", "/workspace/repositories"): result = await spaces.Change(body, true); break;
        case ("POST", "/workspace/sync"): result = await Sync(repository, body, context.RequestAborted); break;
        case ("GET", "/tree"):
            result = await repository.Files.Snapshot(Query(context, "refresh") == "1");
            result["root"] = repository.Root;
            break;
        case ("GET", "/file"): result = await repository.Files.Read(queryPath); break;
        case ("POST", "/file"): result = await repository.Files.Save(body); break;
        case ("POST", "/folder"):
            result = await repository.Files.Transaction(() =>
            {
                Directory.CreateDirectory(repository.Files.Resolve(body.S("path"), true));
                return Task.FromResult(N(new { ok = true }));
            });
            break;
        case ("POST", "/rename"): result = await repository.Files.Rename(body, repository.Metadata); break;
        case ("GET", "/scratch"):
            try
            {
                var saved = await repository.Files.Read(scratch);
                result = N(new { path = scratch, text = saved.S("text"), hash = saved.S("hash") });
            }
            catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
            { result = N(new { path = scratch, text = "", hash = (string?)null }); }
            break;
        case ("POST", "/scratch"):
            JsonNode savedFormat;
            try { savedFormat = await repository.Files.Read(scratch); }
            catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException) { savedFormat = new JsonObject(); }
            body["path"] = scratch;
            body["eol"] = savedFormat.S("eol", "LF");
            body["bom"] = savedFormat.B("bom");
            result = await repository.Files.Save(body);
            break;
        case ("GET" or "POST", "/annotations"):
            Require(source is "document" or "scratch", "标注来源无效。");
            if (source == "document") await repository.Files.Read(file);
            else file = "自由草稿";
            if (method == "GET") result = await repository.Metadata.Read("text-annotations.json", source + ":" + file);
            else
            {
                body["source"] = source;
                body["file"] = file;
                result = await repository.Metadata.Annotations(body);
            }
            break;
        case ("GET" or "POST", "/outline" or "/writing-outline"):
            await repository.Files.Read(file);
            if (method == "GET")
                result = await repository.Metadata.Read(route == "/outline" ? "writing-outlines.json" : "writing-outline-nodes.json", file);
            else result = route == "/outline" ? await repository.Metadata.Outline(body) : await repository.Metadata.Nodes(body);
            break;
        case ("GET", "/explorer/trash"): result = await repository.Files.Transaction(trash.ListTrash); break;
        case ("GET", "/explorer/trash/document"): result = await repository.Files.Transaction(() => trash.ReadTrashed(Query(context, "id") ?? "")); break;
        case ("POST", "/explorer/trash/preview"): result = await repository.Files.Transaction(() => trash.Preview(body.I("days", -1))); break;
        case ("POST", "/explorer/trash/purge"): result = await repository.Files.Transaction(() => trash.Purge(body.S("token"))); break;
        case ("POST", "/explorer/trash/delete"): result = await repository.Files.Transaction(() => trash.Delete(body.A("ids").Select(n => n.Str()).ToArray())); break;
        case ("GET", "/explorer/search"): result = await trash.Search(Query(context, "folder") ?? "", Query(context, "query") ?? ""); break;
        case ("POST", "/explorer"): result = await trash.Manage(body); break;
        case ("POST", "/references/resolve"): result = await repository.References.Resolve(body); break;
        case ("POST", "/references/attachments"):
            result = await repository.References.Add(Query(context, "name"), await ReadBinary(context, Files.MaxBytes));
            break;
        case ("DELETE", _) when route.StartsWith("/references/attachments/", StringComparison.Ordinal) && !route[24..].Contains('/'):
            result = repository.References.Remove(route[24..]);
            break;
        case ("POST", "/import"):
            var importBytes = await ReadBinary(context, Media.MaxImageBytes);
            result = await repository.Files.Transaction(() => repository.Media.Import(Query(context, "name"), Query(context, "parent"), importBytes));
            break;
        case ("GET", "/import"): result = repository.Media.List(); break;
        case ("GET", "/import/references"): result = await repository.Media.References(queryPath); break;
        case ("GET", "/import/image"):
            await WriteImage(context, await repository.Media.ReadFile(queryPath, true));
            return;
        case ("POST", "/images"):
            var imageBytes = await ReadBinary(context, Media.MaxImageBytes);
            result = await repository.Files.Transaction(() => repository.Media.Insert(Query(context, "document") ?? "", Query(context, "name"), imageBytes));
            break;
        case ("GET", "/image-file/info"):
            var image = await repository.Media.ReadFile(queryPath);
            result = N(new { path = queryPath, mime = image.Mime, bytes = image.Bytes.Length });
            break;
        case ("GET", "/image-file" or "/images"):
            Require(Query(context, "workspace") == repository.Id, "图片所属写作空间已变化。", 409);
            await WriteImage(context, route == "/image-file" ? await repository.Media.ReadFile(queryPath) :
                await repository.Media.ReadReference(Query(context, "document") ?? "", Query(context, "path")));
            return;
        case ("GET" or "POST", _) when route == "/history" || route.StartsWith("/history/", StringComparison.Ordinal):
            var segments = route.Split('/');
            Require(segments.Length <= 4, "接口不存在。", 404);
            result = await repository.History.Handle(method, segments.ElementAtOrDefault(2) ?? "", segments.ElementAtOrDefault(3) ?? "", body);
            break;
        default: throw new ApiException("接口不存在。", 404);
    }
    await WriteJson(context, result, route is "/tree" or "/workspace/sync" ? Files.TreeJsonOptions : Options);
}

app.Map("/api", (IApplicationBuilder branch) => branch.Run(async context =>
{
    try
    {
        var host = context.Request.Host.Value;
        var origin = context.Request.Headers.Origin.ToString();
        Require(host == "127.0.0.1:" + port || host == "localhost:" + port, "只允许本机访问。", 403);
        Require(origin.Length == 0 || origin == "http://127.0.0.1:" + port || origin == "http://localhost:" + port, "请求来源不匹配。", 403);
        context.Response.Headers.CacheControl = "no-store";
        var request = context.Request;
        var route = (request.Path.Value ?? "").TrimEnd('/');
        var method = HttpMethods.IsHead(request.Method) ? "GET" : request.Method;
        var binary = method == "POST" && route is "/images" or "/import" or "/references/attachments";
        var body = !binary && method == "POST" ? await ReadJson(context) : new JsonObject();
        if (method == "GET" && route == "/health")
        {
            await WriteJson(context, N(new { app = "hive-writing-prototype", pid = Environment.ProcessId, project, ready = true, backend = "dotnet" }));
            return;
        }
        if (method == "GET" && route == "/workspace") { await WriteJson(context, spaces.Read()); return; }
        if (method == "POST" && route == "/generate") { await models.Generate(context, body); return; }
        var first = route.Split('/', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "";
        if (first is "config" or "model-services" or "ai-tools")
        {
            await WriteJson(context, await models.Handle(context, route, body));
            return;
        }
        if (workspaceRoutes.Contains(first))
        {
            var repository = spaces.Capture(request.Headers["x-hive-workspace"].ToString());
            if (method is "POST" or "DELETE" && route != "/workspace/sync")
            {
                await repository.Mutations.WaitAsync(context.RequestAborted);
                try { await DispatchWorkspace(context, repository, method, route, body); }
                finally { repository.Mutations.Release(); }
            }
            else await DispatchWorkspace(context, repository, method, route, body);
            return;
        }
        if (await catalog.Handle(context, route, body)) return;
        throw new ApiException("接口不存在。", 404);
    }
    catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
    catch (Exception error)
    {
        if (context.Response.HasStarted) { context.Abort(); return; }
        var (status, message, code) = error switch
        {
            ApiException e => (e.Status, e.Message, e.Code),
            JsonException => (400, "请求 JSON 格式无效。", null),
            BadHttpRequestException e => (e.StatusCode, "请求内容无效或过大。", null),
            FileNotFoundException or DirectoryNotFoundException => (404, "文件不存在，请刷新文件列表。", null),
            IOException e when (e.HResult & 0xffff) is 80 or 183 => (409, "同名文件已存在，已阻止覆盖。", null),
            _ => (500, error.Message.Length > 0 ? error.Message : "本地操作失败。", null)
        };
        context.Response.StatusCode = status;
        var result = N(new { error = message });
        if (code != null) result["code"] = code;
        await WriteJson(context, result);
    }
}));
if (Directory.Exists(dist))
{
    using var assets = new PhysicalFileProvider(dist);
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = assets });
    app.UseStaticFiles(new StaticFileOptions { FileProvider = assets });
    try { await Run(); }
    catch (Exception e) { return Fail(e); }
}
else
{
    try { await Run(); }
    catch (Exception e) { return Fail(e); }
}
return 0;

async Task Run()
{
    await spaces.Initialize();
    await models.Initialize();
    await catalog.Initialize();
    await app.StartAsync();
    port = new Uri(app.Urls.Single()).Port;
    Console.WriteLine("HIVE ready: http://127.0.0.1:" + port);
    Console.WriteLine("Documents: " + spaces.Read().S("root"));
    shell.Emit(N(new { type = "hive-ready", port, pid = Environment.ProcessId }));
    _ = shell.ReadInput(app.Lifetime.StopApplication, (method, body) => method switch
    {
        "about-info" => development ? developmentBuild.Value : Updates.DesktopBuildInfo(project, dist, false),
        _ when method.StartsWith("update-", StringComparison.Ordinal) => updates.Handle(method, body),
        _ => native.Handle(method, body),
    });
    await app.WaitForShutdownAsync();
    await shell.Drain();
    await updates.Drain();
}
int Fail(Exception error)
{
    var message = error.Message;
    if (error is IOException { InnerException: Microsoft.AspNetCore.Connections.AddressInUseException })
        message = "端口 " + port + " 已使用，请复用已运行的 HIVE，或设置 HIVE_PORT。";
    Console.Error.WriteLine(message);
    shell.Emit(N(new { type = "hive-startup-error", message }));
    return 1;
}
