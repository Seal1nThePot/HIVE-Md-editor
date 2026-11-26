using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Hive.J;

namespace Hive;

public sealed class NativeData(string appData, Workspaces spaces)
{
    static readonly HashSet<string> Keys =
    [
        "hive.modelPicker.recent", "hive.ai.references.v1", "hive.editor-status.v1", "hive.editor-status.v2",
        "hive.editor-status.v3", "hive.table.sizes.v1", "hive.explorer.v1", "hive.annotationPreferences.v1",
        "hive.shortcuts.v1", "hive.appearance.v1", "hive.theme.v1", "hive.frontmatter-visible.v1", "hive.typography.v1",
        "hive.panelIconDragPreferences.v1", "hive.views.v1", "hive.aiButtonLayout.v1", "hive.recentRepositories.v1",
        "hive.aiResponsePreferences.v1"
    ];
    static readonly string[] Prefixes = ["hive.explorer.v1:", "hive.views.v1:", "hive.ai.references.v1:", "hive.recentDocuments.v1:", "hive.quickOpen.v1:"];
    static readonly HashSet<string> Reasoning = ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const string ReasoningPrefix = "hive.reasoning.";
    readonly SemaphoreSlim prefs = new(1);
    readonly SemaphoreSlim documents = new(1);
    readonly HashSet<string> opened = new(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
    string? savedPreferences;
    string PreferencesPath => Path.Combine(appData, "ui-preferences.json");

    static bool Allowed(string key)
    {
        if (Keys.Contains(key)) return true;
        if (key.Length <= 4096 && Prefixes.Any(p => key.Length > p.Length && key.StartsWith(p, StringComparison.Ordinal))) return true;
        if (key.Length > 512 || !key.StartsWith(ReasoningPrefix, StringComparison.Ordinal)) return false;
        try { return JsonNode.Parse(key[ReasoningPrefix.Length..]) is JsonArray { Count: 2 } pieces && pieces.All(n => n.IsString()); }
        catch (JsonException) { return false; }
    }
    static JsonObject NormalizePreferences(JsonNode input)
    {
        var source = input as JsonObject ?? throw new ApiException("Invalid preferences");
        Require(source.Count <= 256, "Too many preferences");
        var result = new JsonObject();
        foreach (var (key, node) in source.OrderBy(x => x.Key, StringComparer.Ordinal))
        {
            Require(Allowed(key) && node.IsString() && Encoding.UTF8.GetByteCount(node.Str()) <= 131072, "Invalid preference");
            if (key.StartsWith(ReasoningPrefix, StringComparison.Ordinal)) Require(Reasoning.Contains(node.Str()), "Invalid reasoning preference");
            result[key] = node.Copy();
        }
        Require(Encoding.UTF8.GetByteCount(result.ToJsonString(Options)) <= 524288, "Preferences too large");
        return result;
    }
    async Task<JsonNode> Preferences(string method, JsonNode input)
    {
        await prefs.WaitAsync();
        try
        {
            if (method == "preferences-read")
            {
                try
                {
                    var loaded = NormalizePreferences(await ReadObject(PreferencesPath, "界面偏好"));
                    savedPreferences = loaded.ToJsonString(Options);
                    return loaded;
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException or ApiException)
                {
                    Console.Error.WriteLine("Unable to load UI preferences: " + e.Message);
                    return new JsonObject();
                }
            }
            var values = NormalizePreferences(input);
            var serialized = values.ToJsonString(Options);
            if (savedPreferences != serialized)
            {
                await Atomic(PreferencesPath, Encoding.UTF8.GetBytes(serialized));
                savedPreferences = serialized;
            }
            return new JsonObject();
        }
        finally { prefs.Release(); }
    }
    static string DriveMarkdown(string path)
    {
        Require(path.Length <= 32767 && Regex.IsMatch(path, @"^[a-zA-Z]:[\\/]") &&
            !Regex.IsMatch(path[2..], "[*:?\"<>|\\x00-\\x1f]") && Path.GetExtension(path).Equals(".md", StringComparison.OrdinalIgnoreCase),
            "请输入有效的 Markdown（.md）绝对路径。");
        return Path.GetFullPath(path);
    }
    static string Existing(string target)
    {
        if (!Exists(target)) throw new ApiException("找不到 Markdown 文件，请核对路径。", 404);
        var file = FileSystemIdentity.Canonical(target);
        Require(File.Exists(file), "目标路径必须指向 Markdown 文件。");
        return DriveMarkdown(file);
    }
    static string? Inside(string root, string file)
    {
        var relative = Path.GetRelativePath(root, file);
        return relative is "." or ".." || relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal) || Path.IsPathRooted(relative)
            ? null : Posix(relative);
    }
    async Task<JsonNode> LocalDocument(string method, JsonNode input)
    {
        var target = DriveMarkdown(input.S("path"));
        await documents.WaitAsync();
        try
        {
            var file = Existing(target);
            if (method == "open-local-markdown")
            {
                var root = spaces.Capture(null).Root;
                Require(root.Equals(input.S("root"), OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal),
                    "写作空间已在其他窗口切换。请刷新页面后继续；当前内容尚未覆盖磁盘。", 409);
                var relative = Inside(FileSystemIdentity.Canonical(root), file);
                if (relative != null) return N(new { relative });
                Require(Inside(root, target) == null, "路径指向仓库外的符号链接或目录联接。");
                var external = await Files.ReadDocument(Posix(file), file);
                opened.Add(file);
                return N(new { external });
            }
            Require(Regex.IsMatch(input.S("baseline"), "^[a-f0-9]{64}$") && opened.Contains(file), "保存前请先打开这个 Markdown 文件。");
            Require(file.Equals(target, StringComparison.OrdinalIgnoreCase), "目标路径已变化，请核对后重新打开。");
            try
            {
                return await Files.SaveDocument(input, Posix(file), file, null, () =>
                {
                    Require(Existing(target).Equals(file, StringComparison.OrdinalIgnoreCase), "目标路径已变化，请核对后重新打开。");
                });
            }
            catch (ApiException e) when (e.Status == 409)
            { throw new ApiException("磁盘文件已变化，已阻止覆盖。请复制需保留的内容，或重新读取磁盘。", 409); }
        }
        finally { documents.Release(); }
    }
    public Task<JsonNode> Handle(string method, JsonNode input) => method switch
    {
        "preferences-read" or "preferences-save" => Preferences(method, input),
        "open-local-markdown" or "save-local-markdown" => LocalDocument(method, input),
        _ => throw new ApiException("接口不存在。", 404)
    };
}
