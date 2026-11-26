using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Hive.J;

namespace Hive;

public sealed class Metadata(string state)
{
    static readonly string[] Names = ["text-annotations.json", "writing-outline-nodes.json", "writing-outlines.json", "file-times.json"];
    public async Task<JsonNode> Read(string kind, string key) { var all = await ReadObject(Path.Combine(state, kind), kind); return all[key].Copy() ?? (kind == Names[0] ? N(new { revision = 0, fingerprint = "", items = new object[0] }) : kind == Names[1] ? N(new { revision = 0, initialized = false, nodes = new object[0] }) : new JsonObject()); }
    public async Task<JsonNode> Annotations(JsonNode b)
    {
        var source = b.S("source"); var file = b.S("file");
        Require((source is "document" or "scratch") && b["revision"].IsInt() && Regex.IsMatch(b.S("fingerprint"), "^[a-f0-9]{64}$") && b["items"] is JsonArray && b.A("items").Count <= 2000, "文本标注数据格式无效。");
        var ids = new HashSet<string>(); var items = new JsonArray();
        foreach (var i in b.A("items"))
        {
            Require(i is JsonObject entry && i.S("id").Length is > 0 and <= 100 && ids.Add(i.S("id")) && i.S("source") == source && i.S("file") == file && i["from"].IsInt(0, 2_000_000) && i["to"].IsInt(i.I("from"), 2_000_000) && i.S("original").Length is > 0 and <= 2_000_000 && i["note"].IsString() && i.S("note").Length <= 20000 && i["stale"].IsBool() && (i.B("stale") || i.I("to") - i.I("from") == i.S("original").Length) && (!entry.ContainsKey("order") || i["order"].IsInt(0, 3999)) && i["createdAt"].IsString() && i.S("createdAt").Length <= 80 && (!entry.ContainsKey("respondedSignature") || i["respondedSignature"].IsString()), "文本标注的原文、位置或备注无效。");
            var clean = new JsonObject();
            foreach (var k in new[] { "id", "source", "file", "from", "to", "original", "note", "stale", "createdAt", "order" })
                if (i![k] != null) clean[k] = i[k].Copy();
            if (i.S("respondedSignature").Length > 0) clean["respondedSignature"] = i.S("respondedSignature");
            items.Add(clean);
        }
        var all = await ReadObject(Path.Combine(state, Names[0]), "标注存储"); var key = source + ":" + file;
        Require(all[key].I("revision") == b.I("revision"), "标注已被其他窗口修改，已阻止覆盖。请导出当前标注备份后刷新核对。", 409);
        all[key] = N(new { revision = b.I("revision") + 1, fingerprint = b.S("fingerprint"), items }); await Write(Path.Combine(state, Names[0]), all); return N(new { revision = b.I("revision") + 1 });
    }
    public async Task<JsonNode> Nodes(JsonNode b)
    {
        Require(b["revision"].IsInt() && b["nodes"] is JsonArray && b.A("nodes").Count <= 2000, "写作大纲数据无效。"); var ids = new HashSet<string>(); var nodes = new JsonArray();
        foreach (var n in b.A("nodes"))
        {
            Require(n is JsonObject node && n.S("id").Length is > 0 and <= 100 && ids.Add(n.S("id")) && n.S("title").Trim().Length > 0 && n.S("title").Length <= 500 && !Regex.IsMatch(n.S("title"), "[\\r\\n]") && n["description"].IsString() && n.S("description").Length <= 10000 && n["level"].IsInt(1, 6) && node.ContainsKey("targetHeading") && (n["targetHeading"] == null || n["targetHeading"].IsString() && n.S("targetHeading").Length <= 4000), "大纲节点的标题、描述或层级无效。");
            nodes.Add(N(new { id = n.S("id"), title = n.S("title").Trim(), description = n.S("description"), level = n.I("level"), targetHeading = n!["targetHeading"] }));
        }
        var all = await ReadObject(Path.Combine(state, Names[1]), "写作大纲"); var file = b.S("file"); Require(all[file].I("revision") == b.I("revision"), "大纲已在其他窗口变化，请刷新核对后再保存；当前输入没有覆盖磁盘。", 409);
        var next = N(new { revision = b.I("revision") + 1, initialized = true, nodes }); all[file] = next.Copy(); await Write(Path.Combine(state, Names[1]), all); return next;
    }
    public async Task<JsonNode> Outline(JsonNode b)
    {
        Require(b.S("key").Length is > 0 and <= 4000 && b["description"].IsString() && b.S("description").Length <= 10000, "大纲节点描述无效或过长。");
        var all = await ReadObject(Path.Combine(state, Names[2]), "大纲备注"); var file = b.S("file"); var record = all[file] as JsonObject ?? new(); record[b.S("key")] = b.S("description"); all[file] = record.Copy(); await Write(Path.Combine(state, Names[2]), all); return record;
    }
    static string Map(string s, string from, string to) => s == from || s.StartsWith(from + "/", StringComparison.Ordinal) ? to + s[from.Length..] : s;
    public async Task Remap(string from, string to)
    {
        var changed = new List<(string Path, byte[] Bytes)>();
        try
        {
            foreach (var name in Names)
            {
                var target = Path.Combine(state, name); if (!File.Exists(target)) continue; Plain(target); var raw = await File.ReadAllBytesAsync(target); var all = await ReadObject(target); var next = new JsonObject(); var dirty = false;
                foreach (var (key, value) in all.OrderBy(kv => Map(kv.Key, from, to) == kv.Key ? 0 : 1))
                {
                    var file = name == Names[0] ? (key.StartsWith("document:") ? key[9..] : null) : key;
                    var mapped = file == null ? null : Map(file, from, to); var dest = mapped == null ? key : name == Names[0] ? "document:" + mapped : mapped;
                    Require(name == Names[3] || dest == key || !all.ContainsKey(dest), "目标路径已有标注或大纲记录，请换一个名称。");
                    var copy = value.Copy(); if (dest != key) { dirty = true; if (name == Names[0]) foreach (var item in copy.A("items")) item!["file"] = mapped; } next[dest] = copy;
                }
                if (dirty) { await Write(target, next); changed.Add((target, raw)); }
            }
        }
        catch { foreach (var (target, bytes) in changed.AsEnumerable().Reverse()) await Atomic(target, bytes); throw; }
    }
    public async Task Remove(string prefix)
    {
        foreach (var name in Names)
        {
            var target = Path.Combine(state, name);
            if (!Exists(target)) continue;
            var all = await ReadObject(target);
            var keys = all.Select(kv => kv.Key).ToArray();
            foreach (var key in keys)
            {
                var file = name == Names[0] ? (key.StartsWith("document:") ? key[9..] : null) : key;
                if (file != null && (file == prefix || file.StartsWith(prefix + "/", StringComparison.Ordinal))) all.Remove(key);
            }
            if (all.Count != keys.Length) await Write(target, all);
        }
    }
}
