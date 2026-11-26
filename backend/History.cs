using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Hive.J;

namespace Hive;

public sealed class History(string state)
{
    readonly SemaphoreSlim gate = new(1);
    string Pathname => Path.Combine(state, "history.json");
    JsonNode? data;

    static bool Shape(JsonNode? value, string[] required, string[]? optional = null) =>
        value is JsonObject o && required.All(o.ContainsKey) && o.All(p => required.Contains(p.Key) || optional?.Contains(p.Key) == true);
    static bool Nonempty(JsonNode? value) => value.Str().Length > 0;
    static bool Status(string value) => value is "applied" or "reverted";
    static bool Limits(JsonNode? value) => Shape(value, ["human", "ai"]) && value!["human"].IsInt(0, 1000) && value["ai"].IsInt(0, 1000);
    static bool Outline(JsonNode? value, bool snapshot = false) =>
        Shape(value, ["revision", "nodes"], ["initialized"]) && value!["revision"].IsInt() &&
        (value["initialized"].IsBool() || !snapshot && !((JsonObject)value).ContainsKey("initialized")) &&
        value["nodes"] is JsonArray nodes && nodes.All(n => n is JsonObject);
    static bool Optional(JsonObject value, string key, Func<JsonNode?, bool> valid) =>
        !value.TryGetPropertyValue(key, out var node) || valid(node);
    static bool Base(JsonNode value) =>
        Nonempty(value["id"]) && value.S("actor") is "human" or "ai" && Nonempty(value["label"]) &&
        Regex.IsMatch(value.S("createdAt"), @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$") &&
        DateTimeOffset.TryParse(value.S("createdAt"), out _);
    static bool Patch(JsonNode? value) =>
        Shape(value, ["from", "before", "after", "contextBefore", "contextAfter"]) && value!["from"].IsInt() &&
        new[] { "before", "after", "contextBefore", "contextAfter" }.All(k => value[k].IsString());
    static bool Polish(JsonNode? value) =>
        Shape(value, ["id", "reason", "node"], ["annotationIds"]) && Nonempty(value!["id"]) &&
        value["reason"].IsString() && value["node"].IsString() &&
        Optional((JsonObject)value, "annotationIds", n => n is JsonArray array && array.All(Nonempty));
    static bool FileAction(JsonNode? value) =>
        Shape(value, ["action", "path"], ["id", "from"]) && Nonempty(value!["action"]) && Nonempty(value["path"]) &&
        Optional((JsonObject)value, "id", Nonempty) && Optional((JsonObject)value, "from", Nonempty);
    static bool Changes(JsonNode? value) =>
        Shape(value, [], ["text", "polish", "outline", "file"]) &&
        Optional((JsonObject)value!, "text", n => n is JsonArray array && array.All(Patch)) &&
        Optional((JsonObject)value!, "polish", Polish) &&
        Optional((JsonObject)value!, "outline", n => Shape(n, ["before", "after"]) && Outline(n!["before"]) && Outline(n["after"])) &&
        Optional((JsonObject)value!, "file", FileAction);
    static bool Entry(JsonNode? value) =>
        Shape(value, ["id", "actor", "createdAt", "label", "status", "kind", "changes"], ["file"]) &&
        Base(value!) && Optional((JsonObject)value!, "file", Nonempty) && Status(value.S("status")) &&
        value.S("kind") is "text" or "properties" or "outline" or "file" or "snapshot-restore" && Changes(value!["changes"]);
    static bool Snapshot(JsonNode? value) =>
        Shape(value, ["id", "actor", "createdAt", "label", "file", "text", "outline"]) &&
        Base(value!) && Nonempty(value!["file"]) && value["text"].IsString() && Outline(value["outline"], true);
    static bool ValidState(JsonNode value) =>
        Shape(value, ["revision", "limits", "entries", "snapshots"]) && value["revision"].IsInt() &&
        Limits(value["limits"]) && value["entries"] is JsonArray entries && entries.All(Entry) &&
        value["snapshots"] is JsonArray snapshots && snapshots.All(Snapshot);

    async Task<JsonNode> Load()
    {
        if (data != null) return data;
        if (!Exists(Pathname)) return data = N(new { revision = 0, limits = new { human = 100, ai = 100 }, entries = new JsonArray(), snapshots = new JsonArray() });
        try
        {
            var saved = await ReadObject(Pathname);
            Require(ValidState(saved), "历史记录文件无法读取，请保留原文件后检查内容。", 500);
            return data = saved;
        }
        catch (ApiException ex) when (ex.Code == "HIVE_STATE_CORRUPT")
        {
            throw new ApiException("历史记录文件无法读取，请保留原文件后检查内容。", 500);
        }
    }

    static IEnumerable<JsonNode?> Sort(IEnumerable<JsonNode?> entries) =>
        entries.OrderByDescending(n => DateTimeOffset.Parse(n.S("createdAt")));
    static JsonArray Keep(IEnumerable<JsonNode?> entries, JsonNode limits)
    {
        var human = limits.I("human");
        var ai = limits.I("ai");
        return Array(entries.Where(n => n.S("actor") == "human" ? human-- > 0 : ai-- > 0));
    }
    static string Preview(string text) => text.Length > 2000 ? text[..2000] + "\n…" : text;
    static string OutlinePreview(JsonNode? outline) => Preview(string.Join('\n', outline.A("nodes").Select(n =>
        new string('#', Math.Clamp(n.I("level"), 0, 500)) + " " + n.S("title") +
        (n.S("description").Length == 0 ? "" : "\n" + n.S("description")))));

    static JsonNode Summary(JsonNode current)
    {
        var result = current.DeepClone();
        foreach (var item in result.A("entries").OfType<JsonObject>())
        {
            var c = (JsonObject)item["changes"]!;
            var sections = new JsonArray();
            foreach (var patch in c.A("text").Take(20))
                sections.Add(N(new { title = "正文位置 " + (patch.I("from") + 1), before = Preview(patch.S("before")), after = Preview(patch.S("after")) }));
            if (c["outline"] is JsonObject outline)
                sections.Add(N(new { title = "写作大纲", before = OutlinePreview(outline["before"]), after = OutlinePreview(outline["after"]) }));
            if (c["file"] is JsonObject file)
                sections.Add(file.ContainsKey("from") ? N(new { title = "文件", before = file.S("from"), after = file.S("path") }) : N(new { title = "文件", text = file.S("path") }));
            item["sections"] = sections;
            item["reversible"] = c["text"] != null || c["outline"] != null || c["file"].S("action") is "create" or "duplicate" or "trash" or "restore" or "move" or "rename";
            item.Remove("changes");
        }
        foreach (var item in result.A("snapshots").OfType<JsonObject>())
        {
            item["sections"] = N(new[] { new { title = "正文与属性", text = Preview(item.S("text")) }, new { title = "写作大纲", text = OutlinePreview(item["outline"]) } });
            item.Remove("text");
            item.Remove("outline");
        }
        return result;
    }

    public async Task<JsonNode> Handle(string method, string collection, string id, JsonNode input)
    {
        await gate.WaitAsync();
        try
        {
            var current = await Load();
            if (method == "GET")
            {
                if (collection.Length == 0) return Summary(current);
                Require(collection is "entries" or "snapshots" && id.Length > 0, "接口不存在。", 404);
                return current.A(collection).FirstOrDefault(n => n.S("id") == id).Copy() ?? throw new ApiException("这条历史记录已不存在。", 404);
            }
            Require(method == "POST" && id.Length == 0, "接口不存在。", 404);
            var next = current.DeepClone();
            var changed = false;
            switch (collection)
            {
                case "entries":
                    Require(Entry(input), "操作历史格式无效。");
                    if (next["limits"].I(input.S("actor")) == 0 || next.A("entries").Any(n => n.S("id") == input.S("id"))) break;
                    var retained = Keep(Sort(next.A("entries").Prepend(input)), next["limits"]!);
                    changed = retained.Any(n => n.S("id") == input.S("id"));
                    next["entries"] = retained;
                    break;
                case "snapshots":
                    Require(Snapshot(input), "文件快照格式无效。");
                    changed = !next.A("snapshots").Any(n => n.S("id") == input.S("id"));
                    if (changed) next["snapshots"] = Array(Sort(next.A("snapshots").Prepend(input)));
                    break;
                case "limits":
                    Require(Limits(input), "人工和 AI 历史保留条数应为 0 到 1000 的整数。");
                    changed = input.I("human") != next["limits"].I("human") || input.I("ai") != next["limits"].I("ai");
                    next["limits"] = input.Copy();
                    next["entries"] = Keep(next.A("entries"), input);
                    break;
                case "status":
                    Require(Shape(input, ["id", "status", "expectedStatus"], ["fileId"]) && Nonempty(input["id"]) &&
                        Status(input.S("status")) && Status(input.S("expectedStatus")) && Optional((JsonObject)input, "fileId", Nonempty), "历史状态请求无效。");
                    var item = next.A("entries").FirstOrDefault(n => n.S("id") == input.S("id")) ?? throw new ApiException("操作历史已不存在。", 404);
                    Require(item.S("status") == input.S("expectedStatus"), "操作历史状态已变化，请刷新后重试。", 409);
                    var file = item["changes"]?["file"];
                    var fileId = input.S("fileId");
                    Require(fileId.Length == 0 || file != null, "这条历史没有回收站目标。");
                    changed = item.S("status") != input.S("status") || fileId.Length > 0 && file.S("id") != fileId;
                    item["status"] = input.S("status");
                    if (fileId.Length > 0) file!["id"] = fileId;
                    break;
                default: throw new ApiException("接口不存在。", 404);
            }
            if (!changed) return Summary(current);
            next["revision"] = current.I("revision") + 1;
            await Write(Pathname, next);
            data = next;
            return Summary(next);
        }
        finally { gate.Release(); }
    }
}
