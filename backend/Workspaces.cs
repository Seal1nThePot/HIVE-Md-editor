using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Hive.J;

namespace Hive;

public sealed class Repository(string root, string state)
{
    public string Root { get; } = root;
    public string State { get; } = state;
    public string Id { get; } = Workspaces.IdFor(root);
    public Files Files { get; } = new(root, state);
    public SemaphoreSlim Mutations { get; } = new(1);
    public Metadata Metadata { get; } = new(state);
    public Explorer Explorer { get; private set; } = null!;
    public History History { get; } = new(state);
    public Media Media => new(this);
    public References References => new(this);
    public void Initialize(ShellBridge shell) => Explorer = new(this, shell);
}

public sealed class Workspaces : IDisposable
{
    const string WorkspaceChanged = "写作空间已在其他窗口切换。请刷新页面后继续；当前内容尚未覆盖磁盘。";
    readonly string local, manifestDirectory;
    string defaultRoot;
    readonly ShellBridge shell;
    readonly Dictionary<string, Repository> contexts = new(StringComparer.Ordinal);
    readonly SemaphoreSlim gate = new(1);
    sealed record Configuration(Repository Current, bool AutoSave, int Revision, JsonArray Repositories);
    volatile Configuration config = null!;
    public string DefaultId => IdFor(defaultRoot);
    public Workspaces(string local, string root, string appData, ShellBridge shell) { this.local = local; defaultRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)); manifestDirectory = appData; this.shell = shell; }
    public static string IdFor(string root) => Hash(OperatingSystem.IsWindows() ? root.ToLowerInvariant() : root)[..24];
    public async Task Initialize()
    {
        Directory.CreateDirectory(local);
        Directory.CreateDirectory(defaultRoot);
        defaultRoot = FileSystemIdentity.Canonical(defaultRoot);
        var saved = await ReadObject(Path.Combine(local, "workspace.json"), "工作区配置");
        var current = Prepare(saved.S("root", defaultRoot));
        var repositories = new JsonArray();
        foreach (var entry in saved.A("repositories"))
        {
            var root = entry.S("root");
            if (!Path.IsPathFullyQualified(root) || root.Contains('\0')) continue;
            var e = Entry(Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)), entry.S("name"));
            if (!repositories.Any(x => x.S("id") == e.S("id"))) repositories.Add(e);
        }
        foreach (var root in new[] { current.Root, defaultRoot }) if (!repositories.Any(x => x.S("id") == IdFor(root))) repositories.Add(Entry(root));
        var legacy = Path.Combine(local, "scratch.md");
        if (current.Id == DefaultId && !File.Exists(current.Files.Resolve("自由草稿.md")) && File.Exists(legacy))
        { var bytes = await File.ReadAllBytesAsync(legacy); var raw = System.Text.Encoding.UTF8.GetString(bytes); await current.Files.Save(N(new { path = "自由草稿.md", text = Normalize(raw), eol = raw.Contains("\r\n") ? "CRLF" : "LF", bom = raw.StartsWith('\uFEFF'), baseline = (string?)null })); }
        config = new(current, saved.B("autoSave", true), saved.I("revision"), repositories);
        await WriteManifest(config);
        current.Files.Active(true);
    }
    public static string ResolveRoot(string input)
    {
        Require(Path.IsPathFullyQualified(input.Trim()) && !input.Contains('\0'), "请填写现有文件夹的绝对路径。");
        var path = Path.TrimEndingDirectorySeparator(Path.GetFullPath(input.Trim()));
        Require(Directory.Exists(path), "无法访问这个文件夹，请检查路径和读写权限。");
        Require((File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0, "请选择普通文件夹，不使用目录联接或符号链接。");
        try
        {
            path = FileSystemIdentity.Canonical(path);
            using var entries = Directory.EnumerateFileSystemEntries(path).GetEnumerator();
            entries.MoveNext();
            return path;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        { throw new ApiException("无法访问这个文件夹，请检查路径和读写权限。"); }
    }
    Repository Prepare(string root)
    {
        root = ResolveRoot(root); var id = IdFor(root); if (contexts.TryGetValue(id, out var found)) return found;
        var state = id == DefaultId ? local : Path.Combine(local, "workspaces", id); Directory.CreateDirectory(state);
        var repository = new Repository(root, state); repository.Initialize(shell); contexts.Add(id, repository); return repository;
    }
    static JsonNode Entry(string root, string name = "") { var entry = N(new { id = IdFor(root), root }); if (ValidName(name) && name.Trim().Length > 0) entry["name"] = name.Trim(); return entry; }
    static bool ValidName(string name) => name.Trim().Length <= 80 && !Regex.IsMatch(name, "[\\x00-\\x1f\\x7f]");
    JsonNode Read(Configuration value) => N(new { id = value.Current.Id, root = value.Current.Root, defaultRepositoryId = DefaultId, autoSave = value.AutoSave, revision = value.Revision, repositories = value.Repositories });
    public JsonNode Read() => Read(config);
    public JsonNode Read(Repository repository)
    {
        var value = config;
        Require(value.Current == repository, WorkspaceChanged, 409);
        return Read(value);
    }
    public Repository Capture(string? id)
    {
        var current = config.Current;
        Require(string.IsNullOrEmpty(id) || id == current.Id, WorkspaceChanged, 409);
        return current;
    }
    async Task<JsonNode> WriteManifest(Configuration configuration)
    {
        var manifest = N(new { revision = configuration.Revision, repositories = configuration.Repositories.Select(x =>
        {
            var path = x.S("root");
            var leaf = Path.GetFileName(path);
            return new { id = x.S("id"), name = x.S("name", leaf.Length == 0 ? path : leaf), path };
        }) });
        var target = Path.Combine(manifestDirectory, "repositories.json");
        if (File.Exists(target))
        {
            Plain(target);
            try { if (JsonNode.DeepEquals(JsonNode.Parse(await File.ReadAllBytesAsync(target)), manifest)) return manifest; }
            catch (System.Text.Json.JsonException) { }
        }
        await Write(target, manifest);
        return manifest;
    }
    public Task Manifest() => ReadRepositoryManifest("");
    public async Task<JsonNode> ReadRepositoryManifest(string workspaceId)
    {
        await gate.WaitAsync();
        try { Capture(workspaceId); return await WriteManifest(config); }
        finally { gate.Release(); }
    }
    static void RequireRevision(JsonNode input, Configuration current) =>
        Require(input["revision"].IsInt() && input.I("revision") == current.Revision, "写作空间设置已变化，请刷新后重试。", 409);
    async Task<JsonNode> Commit(Configuration current, Configuration next)
    {
        var value = N(new { root = next.Current.Root, autoSave = next.AutoSave, revision = next.Revision, repositories = next.Repositories });
        await WriteManifest(next);
        try { await Write(Path.Combine(local, "workspace.json"), value); }
        catch
        {
            try { await WriteManifest(current); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ApiException) { }
            throw;
        }
        if (next.Current != current.Current)
        {
            current.Current.Files.Active(false);
            next.Current.Files.Active(true);
        }
        config = next;
        return Read(next);
    }
    public async Task<JsonNode> Change(JsonNode b, bool manage)
    {
        await gate.WaitAsync();
        try
        {
            var current = config;
            RequireRevision(b, current);
            var next = current.Current;
            var nextAuto = current.AutoSave;
            var list = (JsonArray)current.Repositories.DeepClone();
            if (!manage)
            {
                var values = (JsonObject)b;
                if (values.ContainsKey("autoSave")) Require(b["autoSave"].IsBool(), "自动保存设置无效。");
                nextAuto = b.B("autoSave", current.AutoSave);
                if (values.ContainsKey("root")) next = Prepare(b.S("root"));
                if (!list.Any(x => x.S("id") == next.Id)) list.Add(Entry(next.Root));
            }
            else switch (b.S("action"))
            {
                case "add": var entry = Entry(ResolveRoot(b.S("root"))); if (!list.Any(x => x.S("id") == entry.S("id"))) list.Add(entry); break;
                case "rename": Require(b["name"].IsString() && ValidName(b.S("name")), "备注名称请使用 80 个字以内的单行文字。"); var found = list.FirstOrDefault(x => x.S("id") == b.S("id")); Require(found != null, "这个仓库已不在列表中，请刷新后重试。", 409); ((JsonObject)found!).Remove("name"); if (b.S("name").Trim().Length > 0) found["name"] = b.S("name").Trim(); break;
                case "remove": Require(b.S("id") != DefaultId, "默认根目录不能移出仓库列表。"); var remove = list.FirstOrDefault(x => x.S("id") == b.S("id")); Require(remove != null, "这个仓库已不在列表中，请刷新后重试。", 409); list.Remove(remove); if (b.S("id") == current.Current.Id) next = Prepare(defaultRoot); break;
                case "reorder": var order = b.A("order").Select(x => x.Str()).ToArray(); Require(order.Length == list.Count && order.Distinct().Count() == list.Count && order.All(id => list.Any(x => x.S("id") == id)), "仓库排列已变化，请刷新后重试。", 409); list = Array(order.Select(id => list.First(x => x.S("id") == id))); break;
                default: throw new ApiException("仓库管理操作无效。");
            }
            return await Commit(current, new(next, nextAuto, current.Revision + 1, list));
        }
        finally { gate.Release(); }
    }
    public async Task<JsonNode> CreateRepository(JsonNode b)
    {
        await gate.WaitAsync();
        try
        {
            var current = config;
            RequireRevision(b, current);
            Capture(b.S("workspaceId"));
            var name = b.S("name");
            try { Name(name); Require(ValidName(name), ""); }
            catch (ApiException) { throw new ApiException("仓库名称需为有效的单个文件夹名称。"); }
            var parent = ResolveRoot(b.S("parent"));
            var candidate = Path.Combine(parent, name);
            var existing = current.Repositories.FirstOrDefault(x => x.S("id") == IdFor(candidate));
            if (existing != null)
            {
                ResolveRoot(candidate);
                return N(new { workspace = Read(current), repository = existing });
            }
            FileSystemIdentity.NewDirectory(candidate);
            try
            {
                var repository = Entry(candidate, name);
                var list = Array(current.Repositories.Append(repository));
                var workspace = await Commit(current, current with { Revision = current.Revision + 1, Repositories = list });
                return N(new { workspace, repository });
            }
            catch
            {
                try { Directory.Delete(candidate); }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException) { }
                throw;
            }
        }
        finally { gate.Release(); }
    }
    public void Dispose() { foreach (var r in contexts.Values) r.Files.Dispose(); gate.Dispose(); }
}
