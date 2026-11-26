using System.Text;
using System.Text.Json.Nodes;
using System.Security.Cryptography;
using static Hive.J;

namespace Hive;

public sealed class Explorer(Repository repository, ShellBridge shell)
{
    string Trash => Path.Combine(repository.Root, ".hive-trash");
    readonly Dictionary<string, (DateTime Expires, List<TrashEntry> Entries)> tokens = new();
    sealed record Plan(string Path, bool Directory, string Identity, string Stamp, string? Hash);
    sealed record TrashEntry(JsonNode Item, string Fingerprint, List<Plan> Plan);
    static ApiException Conflict() => new("回收站内容已变化或预览已过期，请重新预览并确认。", 409);
    void TrashRoot()
    {
        Plain(repository.Root);
        if (!Exists(Trash)) Directory.CreateDirectory(Trash);
        Require(Directory.Exists(Trash) && (File.GetAttributes(Trash) & FileAttributes.ReparsePoint) == 0, "回收站记录或数据不可用。", 409);
    }
    static void WalkPlain(string target) { Plain(target); if (Directory.Exists(target)) foreach (var p in Directory.EnumerateFileSystemEntries(target)) WalkPlain(p); }
    public string Parent(string relative) { var dir = relative.Length == 0 ? repository.Root : repository.Files.Resolve(relative, true); Require(Directory.Exists(dir), "目标必须是文件夹。"); Plain(dir); return dir; }
    static string Unique(string dir, string name, string type) { var ext = type == "file" ? Path.GetExtension(name) : ""; var stem = ext.Length > 0 ? name[..^ext.Length] : name; for (var n = 1; n < 10000; n++) { var leaf = stem + (n == 1 ? "" : " " + n) + ext; if (!Exists(Path.Combine(dir, leaf))) return leaf; } throw new ApiException("同名文件过多。"); }
    public JsonNode PrepareCreate(JsonNode b)
    {
        var type = b.S("type") == "folder" ? "folder" : "file"; var parent = b.S("parent"); var dir = Parent(parent); var name = b.S("name");
        if (!((JsonObject)b).ContainsKey("name")) name = Unique(dir, type == "folder" ? "新建文件夹" : "新建文档.md", type); else { Name(name); if (type == "file" && !name.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) name += ".md"; }
        var relative = Join(parent, name); repository.Files.Resolve(relative, type == "folder"); return N(new { path = relative, name, type });
    }
    async Task Relocate(string from, string to, string source, string destination)
    {
        Require(!Exists(destination), "目标已存在，请换一个名称。", 409);
        if (Directory.Exists(source)) Directory.Move(source, destination); else File.Move(source, destination);
        try { await repository.Metadata.Remap(from, to); }
        catch { if (Directory.Exists(destination)) Directory.Move(destination, source); else File.Move(destination, source); throw; }
    }
    static void CopyTree(string source, string target) { Plain(source); Require(!Exists(target), "目标已存在。", 409); if (Directory.Exists(source)) { Directory.CreateDirectory(target); foreach (var p in Directory.EnumerateFileSystemEntries(source)) CopyTree(p, Path.Combine(target, Path.GetFileName(p))); } else File.Copy(source, target); }
    public Task<JsonNode> Manage(JsonNode b) => repository.Files.Transaction(() => ManageTransaction(b));
    async Task<JsonNode> ManageTransaction(JsonNode b)
    {
        try
        {
            var action = b.S("action");
            if (action == "create") { var p = PrepareCreate(b); var dest = repository.Files.Resolve(p.S("path"), true); Require(!Exists(dest), "同名文件已存在，已阻止覆盖。", 409); if (p.S("type") == "folder") FileSystemIdentity.NewDirectory(dest); else { await using var stream = new FileStream(dest, FileMode.CreateNew); } return N(new { path = p.S("path"), type = p.S("type") }); }
            if (action == "restore") { var record = (await Snapshot(b.S("id"), false)).Item; Require(!record.B("missing"), "文稿内容已不在回收站中。", 404); var path = record.S("path"); Parent(J.Parent(path)); var source = Path.Combine(Trash, b.S("id")); WalkPlain(source); await Relocate("@trash/" + b.S("id"), path, source, repository.Files.Resolve(path, true)); File.Delete(Path.Combine(Trash, b.S("id") + ".json")); return N(new { path, type = record.S("type") }); }
            var relative = b.S("path"); var target = repository.Files.Resolve(relative, true); if (!Exists(target)) throw new FileNotFoundException(); var folder = Directory.Exists(target); Require(folder || File.Exists(target) && Document(relative), "仅处理 Markdown 和图片文件。"); var type = folder ? "folder" : "file";
            if (action == "reveal") { await shell.Call("reveal-file", target); return N(new { ok = true }); }
            WalkPlain(target);
            if (action == "trash") { TrashRoot(); var id = Id(); var record = N(new { id, path = relative, type, deletedAt = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") }); var manifest = Path.Combine(Trash, id + ".json"); await Write(manifest, record); try { await Relocate(relative, "@trash/" + id, target, Path.Combine(Trash, id)); } catch { File.Delete(manifest); throw; } return record; }
            Require(action is "rename" or "move" or "duplicate", "文件操作无效。"); Require(relative != "自由草稿.md" || action == "duplicate", "自由草稿的文件名和位置由草稿面板管理。");
            var parent = action == "move" ? b.S("parent") : J.Parent(relative); var dir = Parent(parent); var name = action == "rename" ? b.S("name") : Path.GetFileName(target); Name(name);
            var extension = Path.GetExtension(relative); if (!folder && !(Image(relative) ? name.EndsWith(extension, StringComparison.OrdinalIgnoreCase) : name.EndsWith(".md", StringComparison.OrdinalIgnoreCase))) name += Image(relative) ? extension : ".md";
            if (action == "duplicate") { var ext = folder ? "" : Path.GetExtension(name); name = Unique(dir, (ext.Length == 0 ? name : name[..^ext.Length]) + " 副本" + ext, type); }
            var destinationRelative = Join(parent, name); var destination = repository.Files.Resolve(destinationRelative, true); if (destinationRelative == relative) return N(new { path = relative, type });
            Require(!folder || !(destination + Path.DirectorySeparatorChar).StartsWith(target + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "不能把文件夹放入自身或其子文件夹。");
            if (action == "duplicate") { CopyTree(target, destination); return N(new { path = destinationRelative, type }); }
            await Relocate(relative, destinationRelative, target, destination); return N(new { path = destinationRelative, from = relative, type });
        }
        finally { repository.Files.Invalidate(); }
    }
    static string Identity(string p)
    {
        Plain(p);
        var (dev, index, birth) = FileSystemIdentity.Stat(p);
        return N(new { dev, index, birth, attributes = (int)File.GetAttributes(p) }).ToJsonString();
    }
    static string Stamp(string path)
    {
        FileSystemInfo info = Directory.Exists(path) ? new DirectoryInfo(path) : new FileInfo(path);
        return N(new { size = info is FileInfo f ? f.Length : 0, modified = info.LastWriteTimeUtc.Ticks }).ToJsonString();
    }
    static async Task<string> HashFile(string path)
    {
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 65536, FileOptions.Asynchronous | FileOptions.SequentialScan);
        return Convert.ToHexStringLower(await SHA256.HashDataAsync(file));
    }
    async Task<TrashEntry> Snapshot(string id, bool content = true, bool createRoot = true)
    {
        Require(Guid.TryParseExact(id, "D", out _), "回收站记录无效。");
        if (!createRoot && !Exists(Trash)) throw new ApiException("此回收站没有文稿。", 404);
        TrashRoot();
        var manifest = Path.Combine(Trash, id + ".json");
        if (!Exists(manifest)) throw new FileNotFoundException();
        Require(File.Exists(manifest) && (File.GetAttributes(manifest) & FileAttributes.ReparsePoint) == 0, "回收站记录或数据不可用。", 409);
        JsonObject record;
        try { record = await ReadObject(manifest); }
        catch (ApiException e) when (e.Code == "HIVE_STATE_CORRUPT") { throw new ApiException("回收站记录或数据不可用。", 409); }
        var path = record.S("path"); var type = record.S("type");
        Require(record.S("id") == id && type is "file" or "folder" && !path.Contains('\\') && DateTimeOffset.TryParse(record.S("deletedAt"), out _) && (type != "file" || Document(path)), "回收站记录或数据不可用。", 409); repository.Files.Resolve(path, true);
        var data = Path.Combine(Trash, id);
        var missing = !Exists(data);
        var plan = new List<Plan>();
        var fingerprint = new StringBuilder(Identity(manifest)).Append(Stamp(manifest)).Append(record.ToJsonString());
        async Task Walk(string p)
        {
            var identity = Identity(p); var stamp = Stamp(p); var directory = Directory.Exists(p); var hash = directory ? null : await HashFile(p); fingerprint.Append(p).Append(identity).Append(stamp).Append(hash);
            if (directory) foreach (var child in Directory.EnumerateFileSystemEntries(p).Order(StringComparer.Ordinal)) await Walk(child);
            if (Identity(p) != identity || Stamp(p) != stamp) throw Conflict();
            plan.Add(new(p, directory, identity, stamp, hash));
        }
        if (!missing)
        {
            Require((type == "folder") == Directory.Exists(data) && (File.GetAttributes(data) & FileAttributes.ReparsePoint) == 0, "回收站记录或数据不可用。", 409);
            if (content) await Walk(data);
        }
        var item = N(new { id, path, type, deletedAt = record.S("deletedAt") });
        if (missing) item["missing"] = true;
        return new(item, Hash(fingerprint.ToString()), plan);
    }
    public async Task<JsonArray> ListTrash()
    {
        TrashRoot(); var items = new List<JsonNode>(); foreach (var manifest in Directory.EnumerateFiles(Trash, "*.json")) { var id = Path.GetFileNameWithoutExtension(manifest); if (Guid.TryParseExact(id, "D", out _)) items.Add((await Snapshot(id, false)).Item); } return Array(items.OrderByDescending(x => x.S("deletedAt"), StringComparer.Ordinal));
    }
    public async Task<JsonNode> ReadTrashed(string id)
    {
        try
        {
            var entry = await Snapshot(id, false, false);
            Require(entry.Item.S("type") == "file" && entry.Item.S("path").EndsWith(".md", StringComparison.OrdinalIgnoreCase), "回收站仅预览 Markdown 文稿。");
            Require(!entry.Item.B("missing"), "文稿内容已不在回收站中。", 404);
            var target = Path.Combine(Trash, id);
            Require(new FileInfo(target).Length <= Files.MaxBytes, "仅支持预览 2 MB 以内的 Markdown 文稿。");
            var identity = Identity(target);
            var stamp = Stamp(target);
            var file = await Files.ReadDocument(entry.Item.S("path"), target);
            if ((await Snapshot(id, false, false)).Fingerprint != entry.Fingerprint || Identity(target) != identity || Stamp(target) != stamp) throw Conflict();
            return N(new { id, path = entry.Item.S("path"), text = file.S("text") });
        }
        catch (Exception e) when (e is DirectoryNotFoundException or FileNotFoundException)
        { throw new ApiException("文稿内容已不在回收站中。", 404); }
    }
    public async Task<JsonNode> Preview(int days)
    {
        Require(new[] { 0, 7, 15, 30, 90 }.Contains(days), "清理天数无效。"); var now = DateTime.UtcNow; var cutoff = now.AddDays(-days); var selected = new List<TrashEntry>();
        foreach (var item in await ListTrash()) if (days == 0 || DateTime.Parse(item.S("deletedAt")).ToUniversalTime() < cutoff)
        {
            var entry = await Snapshot(item.S("id"));
            if (!JsonNode.DeepEquals(entry.Item, item)) throw Conflict();
            selected.Add(entry);
        }
        foreach (var key in tokens.Where(x => x.Value.Expires <= now).Select(x => x.Key).ToArray()) tokens.Remove(key); while (tokens.Count >= 32) tokens.Remove(tokens.Keys.First()); var token = Id(); var expires = now.AddMinutes(5); tokens[token] = (expires, selected);
        return N(new { token, days, cutoff = cutoff.ToString("O"), expiresAt = expires.ToString("O"), items = selected.Select(x => x.Item), count = selected.Count });
    }
    public async Task<JsonNode> Purge(string token)
    {
        if (!tokens.Remove(token, out var saved) || saved.Expires <= DateTime.UtcNow) throw Conflict();
        foreach (var e in saved.Entries) { try { if ((await Snapshot(e.Item.S("id"))).Fingerprint != e.Fingerprint) throw Conflict(); } catch { throw Conflict(); } }
        return await DeletePlans(saved.Entries.Select(x => x.Item.S("id")).ToArray(), saved.Entries);
    }
    public Task<JsonNode> Delete(string[] ids) => DeletePlans(ids);
    async Task<JsonNode> DeletePlans(string[] ids, List<TrashEntry>? expected = null)
    {
        if (expected == null) Require(ids.Length is > 0 and <= 100 && ids.All(x => Guid.TryParseExact(x, "D", out _)), "请选择要删除的回收站条目。"); TrashRoot(); var deletedIds = new List<string>(); var failed = new JsonArray();
        foreach (var id in ids.Distinct())
        {
            if (!Exists(Path.Combine(Trash, id + ".json"))) continue; TrashEntry? entry = null; var dataDeleted = false; var removed = 0;
            try
            {
                entry = await Snapshot(id); var old = expected?.First(x => x.Item.S("id") == id); if (old != null && old.Fingerprint != entry.Fingerprint) throw Conflict();
                var plans = entry.Plan.ToDictionary(p => p.Path, StringComparer.Ordinal);
                foreach (var node in entry.Plan)
                {
                    TrashRoot();
                    var parent = Path.GetDirectoryName(node.Path)!;
                    while (!parent.Equals(Trash, StringComparison.Ordinal))
                    {
                        if (!plans.TryGetValue(parent, out var folder) || !folder.Directory || !Directory.Exists(parent) || Identity(parent) != folder.Identity) throw Conflict();
                        parent = Path.GetDirectoryName(parent)!;
                    }
                    if (Identity(node.Path) != node.Identity || Directory.Exists(node.Path) != node.Directory) throw Conflict();
                    if (node.Directory) Directory.Delete(node.Path);
                    else
                    {
                        if (Stamp(node.Path) != node.Stamp || await HashFile(node.Path) != node.Hash || Identity(node.Path) != node.Identity || Stamp(node.Path) != node.Stamp) throw Conflict();
                        File.Delete(node.Path);
                    }
                    removed++;
                }
                dataDeleted = true; await repository.Metadata.Remove("@trash/" + id); var manifest = Path.Combine(Trash, id + ".json"); Plain(manifest); File.Delete(manifest); deletedIds.Add(id);
            }
            catch (Exception e) { var f = N(new { id, path = entry?.Item.S("path") ?? "", error = dataDeleted ? "内容已永久删除，但记录或元数据清理失败：" + e.Message : removed > 0 ? "文件夹内容可能已部分永久删除，剩余内容和记录已保留：" + e.Message : e.Message }); if (dataDeleted) f["dataDeleted"] = true; else if (removed > 0) f["partialDataDeleted"] = true; failed.Add(f); }
        }
        Require(expected != null || deletedIds.Count + failed.Count > 0, "这些条目已不在回收站中。", 404); return N(new { deletedIds, failed });
    }
    public async Task<JsonNode> Search(string folder, string query)
    {
        Require(query.Trim().Length > 0 && query.Length <= 200, "请填写 1–200 字的查找内容。"); Parent(folder); var matches = new JsonArray(); var truncated = false;
        foreach (var e in await repository.Files.Flat())
        {
            var path = e.S("path"); if (folder.Length > 0 && !path.StartsWith(folder + "/")) continue; var index = -1; var text = "";
            if (!Image(path)) { try { text = (await repository.Files.Read(path)).S("text"); index = text.IndexOf(query, StringComparison.OrdinalIgnoreCase); } catch (FileNotFoundException) { continue; } catch (ApiException ex) when (ex.Message.Contains("2 MB")) { continue; } }
            if (index < 0 && !e.S("name").Contains(query, StringComparison.OrdinalIgnoreCase)) continue; if (matches.Count == 200) { truncated = true; break; }
            matches.Add(N(new { path, line = index < 0 ? (int?)null : text[..index].Count(x => x == '\n') + 1, excerpt = index < 0 ? "" : text.Substring(Math.Max(0, index - 25), Math.Min(text.Length, index + query.Length + 60) - Math.Max(0, index - 25)).Replace('\n', ' ') }));
        }
        return N(new { matches, truncated });
    }
}
