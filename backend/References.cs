using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Hive.J;

namespace Hive;

public sealed class References(Repository repository)
{
    const int MaxCharacters = 60000;
    static readonly CompareInfo Order = CultureInfo.GetCultureInfo("zh-CN").CompareInfo;
    sealed record Candidate(string Path, string Source, bool Explicit, JsonObject? Attachment = null);
    static bool IsId(string id) => Regex.IsMatch(id, @"^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$");
    string Target(string id)
    {
        Require(IsId(id), "参考附件标识无效。");
        var dir = Path.Combine(repository.State, "reference-attachments");
        if (Exists(dir)) Plain(dir);
        return Path.Combine(dir, id + ".json");
    }
    public async Task<JsonNode> Add(string? name, byte[] bytes)
    {
        Require(name?.Length is > 0 and <= 1000 && !Regex.IsMatch(name, "[\\\\/\\x00-\\x1f\\x7f]") &&
            name.EndsWith(".md", StringComparison.OrdinalIgnoreCase), "请选择 Markdown（.md）文件。");
        var text = Media.DecodeMarkdown(bytes).Replace("\r\n", "\n");
        var id = Id();
        await Write(Target(id), N(new { name, text }));
        return N(new { type = "attachment", id, path = name });
    }
    public JsonNode Remove(string id)
    {
        var file = Target(id);
        if (Exists(file)) { Plain(file); File.Delete(file); }
        return N(new { ok = true });
    }
    async Task<JsonNode> Read(string id)
    {
        var path = Target(id);
        if (!Exists(path)) throw new FileNotFoundException();
        return await ReadObject(path, "参考附件");
    }
    public async Task<JsonNode> Resolve(JsonNode input)
    {
        Require(input["sources"] is JsonArray && input.A("sources").Count <= 32, "参考资料列表无效，最多添加 32 项。");
        Require(input["budget"].IsInt(0, MaxCharacters), "参考资料长度无效。");
        var sources = new JsonArray();
        var sourceKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var attachmentIds = new HashSet<string>(StringComparer.Ordinal);
        var candidates = new List<Candidate>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var warnings = new List<string>();
        var overflow = false;
        var currentFile = Posix(input.S("currentFile"));
        void Include(Candidate candidate)
        {
            if (candidates.Count == 256) overflow = true;
            else candidates.Add(candidate);
        }
        foreach (var item in input.A("sources"))
        {
            var type = item.S("type");
            var path = item.S("path");
            if (type == "attachment")
            {
                var id = item.S("id");
                Require(IsId(id) && item is JsonObject attachment && attachment["path"].IsString() && path.Length <= 1000,
                    "参考附件标识无效。");
                if (!attachmentIds.Add(id)) continue;
                var source = (JsonObject)N(new { type, id, path });
                sources.Add(source);
                Include(new(path, path, false, source));
                continue;
            }
            Require(type is "file" or "folder" && item is JsonObject value && value["path"].IsString() && path.Length <= 2000, "参考资料路径无效。");
            var relative = Posix(path);
            var target = repository.Files.Resolve(relative, type == "folder");
            if (!sourceKeys.Add(relative)) continue;
            sources.Add(N(new { path = relative, type }));
            var paths = new[] { relative };
            if (type == "folder")
            {
                try
                {
                    if (!Directory.Exists(target)) throw new DirectoryNotFoundException();
                    var index = await repository.Files.Flat();
                    paths = index.Select(n => n.S("path")).Where(p => p.StartsWith(relative + "/", OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal) && p.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
                        .Order(Comparer<string>.Create((x, y) => Order.Compare(x, y, CompareOptions.NumericOrdering))).ToArray();
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ApiException)
                { throw new ApiException("无法读取参考文件夹“" + relative + "”，请检查它是否仍然存在。"); }
                if (paths.Length == 0) warnings.Add("文件夹“" + relative + "”中没有可读取的 Markdown 笔记。");
            }
            foreach (var p in paths)
            {
                if (!seen.Add(p)) continue;
                if (p.Equals(currentFile, StringComparison.OrdinalIgnoreCase))
                    warnings.Add("“" + p + "”已包含在当前正文中，不重复加入。");
                else Include(new(p, path, type == "file"));
            }
        }
        if (overflow) warnings.Add("参考笔记超过 256 份，仅处理优先级靠前的 256 份。");
        var overrides = new Dictionary<string, JsonNode>(StringComparer.OrdinalIgnoreCase);
        if (((JsonObject)input).ContainsKey("overrides"))
        {
            Require(input["overrides"] is JsonArray && input.A("overrides").Count <= 64, "未保存参考稿无效。");
            var total = 0;
            foreach (var value in input.A("overrides"))
            {
                Require(value is JsonObject o && o["path"].IsString() && o["text"].IsString() &&
                    o["characters"].IsInt(o.S("text").Length, Files.MaxBytes), "未保存参考稿无效。");
                total += value.S("text").Length;
                Require(total <= MaxCharacters, "未保存参考稿过长。");
                overrides[value.S("path")] = value!;
            }
        }
        var files = new JsonArray();
        var remaining = input.I("budget");
        foreach (var candidate in candidates)
        {
            var path = candidate.Path;
            var source = candidate.Source;
            if (remaining <= 0)
            {
                warnings.Add("未加入“" + path + "”：本轮参考空间已满。");
                continue;
            }
            var attachment = candidate.Attachment;
            JsonNode disk;
            try
            {
                disk = attachment != null ? await Read(attachment.S("id")) : await repository.Files.Read(path);
                if (attachment != null)
                {
                    path = source = disk.S("name");
                    attachment["path"] = path;
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or ApiException)
            {
                if (attachment != null)
                {
                    if (e is not (FileNotFoundException or DirectoryNotFoundException)) throw;
                    throw new ApiException("参考附件“" + path + "”已不存在，请重新添加。");
                }
                if (candidate.Explicit) throw new ApiException("无法读取参考笔记“" + path + "”：" + e.Message);
                warnings.Add("未加入“" + path + "”：无法读取。");
                continue;
            }
            var edited = attachment == null ? overrides.GetValueOrDefault(path) : null;
            var text = (edited ?? disk).S("text");
            var characters = edited?.I("characters") ?? text.Length;
            if (edited != null && characters > 0 && text.Length == 0)
            {
                warnings.Add("未加入“" + path + "”：未保存内容超出本轮空间，请提高优先级或先保存。");
                continue;
            }
            var selected = text[..Math.Min(remaining, text.Length)];
            var truncated = selected.Length < characters;
            var result = N(new { path, source, text = selected, characters, truncated });
            if (edited != null) result["unsaved"] = true;
            files.Add(result);
            remaining -= selected.Length;
            if (truncated) warnings.Add("“" + candidate.Path + "”已截短，优先保留开头 " + selected.Length + " 个字符。");
        }
        return N(new { sources, files, warnings });
    }
}
