using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Encodings.Web;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Diagnostics.CodeAnalysis;

namespace Hive;

public sealed class ApiException(string message, int status = 400, string? code = null) : Exception(message)
{
    public int Status { get; } = status;
    public string? Code { get; } = code;
}

public static class J
{
    public static readonly JsonSerializerOptions Options = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    public static JsonNode N(object? value) => JsonSerializer.SerializeToNode(value, Options)!;
    public static JsonNode? Copy(this JsonNode? n) => n?.DeepClone();
    public static string S(this JsonNode? n, string key, string fallback = "") => (n as JsonObject)?[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : fallback;
    public static int I(this JsonNode? n, string key, int fallback = 0) => Integer((n as JsonObject)?[key], out var x) ? x : fallback;
    public static bool B(this JsonNode? n, string key, bool fallback = false) => (n as JsonObject)?[key] is JsonValue v && v.TryGetValue<bool>(out var x) ? x : fallback;
    public static JsonArray A(this JsonNode? n, string key) => (n as JsonObject)?[key] as JsonArray ?? [];
    public static string Str(this JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out var s) ? s : "";
    public static bool IsString(this JsonNode? n) => n is JsonValue v && v.TryGetValue<string>(out _);
    static bool Integer(JsonNode? node, out int result)
    {
        result = 0;
        if (node is not JsonValue value) return false;
        if (value.TryGetValue<int>(out result)) return true;
        if (!value.TryGetValue<double>(out var d) || d < int.MinValue || d > int.MaxValue || Math.Truncate(d) != d) return false;
        result = (int)d;
        return true;
    }
    public static bool IsInt(this JsonNode? n, int min = 0, int max = int.MaxValue) => Integer(n, out var x) && x >= min && x <= max;
    public static bool IsBool(this JsonNode? n) => n is JsonValue v && v.TryGetValue<bool>(out _);
    public static JsonArray Array(IEnumerable<JsonNode?> nodes) => new(nodes.Select(n => n.Copy()).ToArray());
    public static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
    public static string Hash(string text) => Hash(Encoding.UTF8.GetBytes(text));
    public static string Id() => Guid.NewGuid().ToString();
    public static void Require([DoesNotReturnIf(false)] bool condition, string message, int status = 400) { if (!condition) throw new ApiException(message, status); }
    public static bool Exists(string p)
    {
        try { File.GetAttributes(p); return true; }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
    }
    public static void Plain(string p) { if ((File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0) throw new ApiException("不能操作符号链接或目录联接。"); }
    public static async Task<JsonObject> ReadObject(string path, string label = "状态")
    {
        if (!Exists(path)) return new();
        Plain(path);
        try { return JsonNode.Parse(await File.ReadAllBytesAsync(path)) as JsonObject ?? throw new JsonException(); }
        catch (JsonException) { throw new ApiException($"{label}文件损坏：{path}\n请先备份打开的文稿并退出 HIVE，再复制保留损坏文件。将有效备份恢复到上述路径后，重新启动 HIVE。", 500, "HIVE_STATE_CORRUPT"); }
    }
    public static async Task Atomic(string target, byte[] bytes)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        if (Exists(target)) Plain(target);
        var temp = target + "." + Id() + ".tmp";
        try
        {
            await using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.Asynchronous))
            { await stream.WriteAsync(bytes); await stream.FlushAsync(); stream.Flush(true); }
            if (Exists(target)) Plain(target);
            File.Move(temp, target, true);
        }
        finally { File.Delete(temp); }
    }
    public static Task Write(string target, JsonNode node) => Atomic(target, Encoding.UTF8.GetBytes(node.ToJsonString(Options)));
    public static string Normalize(string text) => (text.StartsWith('\uFEFF') ? text[1..] : text).Replace("\r\n", "\n");
    public static string Posix(string p) => p.Replace('\\', '/');
    public static string Parent(string p) => Posix(Path.GetDirectoryName(p) ?? "");
    public static string Join(string a, string b) => a.Length == 0 ? b : a + "/" + b;
    public static bool Image(string p) => Regex.IsMatch(p, @"\.(png|jpe?g|gif|webp)$", RegexOptions.IgnoreCase);
    public static bool Document(string p) => p.EndsWith(".md", StringComparison.OrdinalIgnoreCase) || Image(p);
    public static void Name(string name)
    {
        Require(name.Length > 0 && name == name.Trim() && !name.StartsWith('.') && !Regex.IsMatch(name, "[\\\\/:*?\"<>|\\x00-\\x1f]|[. ]$|^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\\.|$)", RegexOptions.IgnoreCase), "文件名称无效。");
    }
}
