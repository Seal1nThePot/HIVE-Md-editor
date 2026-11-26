using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Hive.J;

namespace Hive;

public sealed partial class ModelService(string state, Workspaces spaces) : IDisposable
{
    const int ServiceLimit = 40;
    const int ModelLimit = 100;
    static readonly string[] ReasoningLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    static readonly string[] InputTypes = ["text", "image"];
    static readonly string[] ReasoningParameters = ["reasoning_effort", "reasoning.effort", "thinking.type"];
    readonly string modelFile = Path.Combine(state, "model.json");
    readonly string keyFile = Path.Combine(state, "keys.json");
    readonly string envKey = Environment.GetEnvironmentVariable("HIVE_API_KEY") ?? "";
    readonly SemaphoreSlim changes = new(1);
    volatile Settings settings = null!;

    sealed record Settings(JsonObject Config, Dictionary<string, string> Keys, bool KeysExist);
    sealed record Endpoints(string Base, string Chat, string Models);
    sealed record ModelRoute(string Endpoint, string Model, string Key, JsonNode? ModelConfig = null, string? SessionId = null);

    static JsonNode? Field(JsonNode? node, string name) => (node as JsonObject)?[name];
    static JsonNode? Entry(JsonNode? node, int index = 0) => node is JsonArray items && index < items.Count ? items[index] : null;
    static bool Has(JsonNode? node, string key) => node is JsonObject obj && obj.ContainsKey(key);
    static string StringField(JsonNode? node, string key, string fallback = "") => Field(node, key) is JsonValue v && v.TryGetValue<string>(out var value) ? value : fallback;
    static IEnumerable<string> Strings(JsonNode? node) => node is JsonArray a ? a.Where(i => i.IsString()).Select(i => i.Str()) : [];
    static bool SingleLine(string value) => value.IndexOfAny(['\r', '\n', '\0']) < 0;

    static long? Integer(JsonNode? node)
    {
        const long max = 9_007_199_254_740_991;
        if (node is not JsonValue value) return null;
        if (value.TryGetValue<long>(out var number) && number is >= -max and <= max) return number;
        if (value.TryGetValue<int>(out var integer)) return integer;
        return value.TryGetValue<double>(out var decimalValue) && decimalValue is >= -max and <= max && Math.Truncate(decimalValue) == decimalValue
            ? (long)decimalValue : null;
    }
    static long? Capacity(JsonNode? node) => Integer(node) is > 0 and var number ? number : null;
    static string CheckedText(JsonNode? value, string label, int limit = 200)
    {
        var raw = value.Str();
        var clean = raw.Trim();
        Require(value.IsString() && clean.Length > 0 && clean.Length <= limit && SingleLine(raw), $"{label}格式无效。");
        return clean;
    }

    static Endpoints Addresses(JsonNode? value)
    {
        const string invalid = "请填写有效的 HTTP(S) 接口地址。";
        const string forbidden = "接口地址不能包含凭据、查询参数或片段。";
        var input = CheckedText(value, "接口地址", 4096).Replace("\t", "", StringComparison.Ordinal);
        var colon = input.IndexOf(':');
        Require(colon > 0 && Uri.CheckSchemeName(input[..colon]), invalid);
        var scheme = input[..colon].ToLowerInvariant();
        Require(scheme is "http" or "https" && input.IndexOfAny(['?', '#']) < 0, forbidden);
        var url = input[(colon + 1)..].Replace('\\', '/').TrimStart('/');
        var slash = url.IndexOf('/');
        var authority = slash < 0 ? url : url[..slash];
        Require(!authority.Contains('@'), forbidden);
        Require(Uri.TryCreate(scheme + "://" + authority + "/", UriKind.Absolute, out var uri) && uri.Host.Length > 0, invalid);
        var host = uri!.HostNameType == UriHostNameType.IPv6 ? uri.Host : uri.IdnHost;
        var port = uri.IsDefaultPort ? "" : ":" + uri.Port.ToString(CultureInfo.InvariantCulture);
        var pathname = slash < 0 ? "" : ModelPath(url[(slash + 1)..]);
        var endpoint = (scheme + "://" + host + port + pathname).TrimEnd('/');
        var root = endpoint.EndsWith("/chat/completions", StringComparison.Ordinal) ? endpoint[..^17] : endpoint;
        return new(endpoint, root + "/chat/completions", root + "/models");
    }

    static string ModelPath(string input)
    {
        // Follow the old URL path rules so escapes keep their spelling and credentials keep their exact binding.
        var segments = new List<string>();
        foreach (var part in input.Split('/'))
        {
            var dot = part.Replace("%2e", ".", StringComparison.OrdinalIgnoreCase);
            if (dot == ".") continue;
            if (dot == "..")
            {
                if (segments.Count > 0) segments.RemoveAt(segments.Count - 1);
                continue;
            }
            segments.Add(part);
        }
        var path = new StringBuilder();
        foreach (var rune in ("/" + string.Join('/', segments)).EnumerateRunes())
        {
            if (rune.Value <= ' ' || rune.Value > '~' || rune.Value is '"' or '<' or '>' or '^' or '`' or '{' or '}')
                path.Append(Uri.EscapeDataString(rune.ToString()));
            else path.Append((char)rune.Value);
        }
        return path.ToString();
    }

    static JsonObject ReasoningMapping(JsonNode? source)
    {
        var result = new JsonObject();
        foreach (var level in ReasoningLevels)
        {
            var mapping = Field(source, level);
            var parameter = StringField(mapping, "parameter");
            var value = StringField(mapping, "value");
            if (ReasoningParameters.Contains(parameter) && Regex.IsMatch(value, @"\A[A-Za-z0-9_\-]{1,48}\z"))
                result[level] = N(new { parameter, value });
        }
        return result;
    }
    static string[] InputMapping(JsonNode? source)
    {
        var declared = Strings(source).ToHashSet(StringComparer.Ordinal);
        return InputTypes.Where(declared.Contains).ToArray();
    }
    static JsonObject? Capabilities(JsonNode? source, bool catalog = false)
    {
        var declared = catalog ? Field(source, "capabilities") : source;
        var reasoning = ReasoningMapping(Field(declared, "reasoning") ?? (catalog ? Field(Field(source, "reasoning"), "levels") : null));
        var context = Capacity(Field(declared, "contextTokens"));
        var output = Capacity(Field(declared, "maxOutputTokens"));
        var input = InputMapping(Field(declared, "input"));
        if (catalog)
        {
            if (reasoning.Count == 0)
            {
                var parameter = Field(source, "reasoning_effort_parameter") ?? JsonValue.Create("reasoning_effort");
                var mapping = new JsonObject();
                foreach (var value in Strings(Field(source, "reasoning_efforts") ?? Field(source, "supported_reasoning_efforts")))
                {
                    var level = value == "none" ? "off" : value;
                    if (ReasoningLevels.Contains(level)) mapping[level] = N(new { parameter, value });
                }
                reasoning = ReasoningMapping(mapping);
            }
            var provider = Field(source, "top_provider");
            context ??= Capacity(Field(source, "context_length")) ?? Capacity(Field(source, "context_window"))
                ?? Capacity(Field(source, "max_model_len")) ?? Capacity(Field(provider, "context_length"));
            output ??= Capacity(Field(source, "max_output_tokens")) ?? Capacity(Field(source, "max_completion_tokens"))
                ?? Capacity(Field(provider, "max_completion_tokens"));
            if (input.Length == 0) input = InputMapping(Field(Field(source, "architecture"), "input_modalities"));
            if (input.Length == 0) input = InputMapping(Field(source, "input_modalities"));
        }
        var result = new JsonObject();
        if (reasoning.Count > 0) result["reasoning"] = reasoning;
        if (context is long c) result["contextTokens"] = c;
        if (output is long o) result["maxOutputTokens"] = o;
        if (input.Length > 0) result["input"] = N(input);
        return result.Count > 0 ? result : null;
    }
    static string[] EffectiveReasoning(JsonNode? model)
    {
        var manual = Strings(Field(model, "manualReasoningLevels")).ToHashSet(StringComparer.Ordinal);
        var configured = Strings(Field(model, "reasoningLevels")).ToHashSet(StringComparer.Ordinal);
        var declared = Field(Field(model, "capabilities"), "reasoning");
        return ReasoningLevels.Where(level => manual.Contains(level) || Has(declared, level) && (!Has(model, "reasoningLevels") || configured.Contains(level))).ToArray();
    }
    static string[] Configured(JsonNode? value, string[] options, string message)
    {
        Require(value is JsonArray entries && entries.Count <= options.Length && entries.All(x => x.IsString() && options.Contains(x.Str())), message);
        var configured = Strings(value).ToHashSet(StringComparer.Ordinal);
        return options.Where(configured.Contains).ToArray();
    }

    static JsonObject CleanModel(JsonNode? item)
    {
        var id = CheckedText(Field(item, "id"), "模型 ID");
        var name = Field(item, "name");
        var entry = new JsonObject { ["id"] = id, ["name"] = Truthy(name) ? CheckedText(name, "模型名称") : id };
        var capabilities = Capabilities(Field(item, "capabilities"));
        if (capabilities != null) entry["capabilities"] = capabilities;
        var context = Capacity(Field(item, "contextTokens"));
        if (Has(item, "contextTokens"))
        {
            Require(context.HasValue, "上下文容量需为有效的正整数 token。");
            entry["contextTokens"] = context!.Value;
        }
        if (Has(item, "maxOutputTokens"))
        {
            var output = Capacity(Field(item, "maxOutputTokens"));
            Require(output.HasValue, "最大输出长度需为有效的正整数 token。");
            var window = context ?? Capacity(Field(capabilities, "contextTokens"));
            var ceiling = Capacity(Field(capabilities, "maxOutputTokens"));
            Require(window == null || output < window, "最大输出长度必须小于上下文窗口，为输入预留空间。");
            Require(ceiling == null || output <= ceiling, "最大输出长度不能超过上游公布的上限。");
            entry["maxOutputTokens"] = output!.Value;
        }
        if (Has(item, "reasoningLevels"))
            entry["reasoningLevels"] = N(Configured(Field(item, "reasoningLevels"), ReasoningLevels, "推理档位配置无效。")
                .Where(level => Has(Field(capabilities, "reasoning"), level)));
        if (Has(item, "manualReasoningLevels"))
            entry["manualReasoningLevels"] = N(Configured(Field(item, "manualReasoningLevels"), ReasoningLevels, "推理档位配置无效。"));
        if (Has(item, "inputTypes"))
            entry["inputTypes"] = N(Configured(Field(item, "inputTypes"), InputTypes, "输入类型配置无效。"));
        var preferred = StringField(item, "defaultReasoning");
        if (EffectiveReasoning(entry).Contains(preferred)) entry["defaultReasoning"] = preferred;
        return entry;
    }
    static JsonObject CleanService(JsonNode? value, string id)
    {
        var items = Field(value, "models") as JsonArray;
        Require(items != null && Field(value, "enabled").IsBool(), "服务配置格式无效。");
        Require(items!.Count <= ModelLimit, $"每个服务最多配置 {ModelLimit} 个模型。");
        var models = items.Select(CleanModel).ToArray();
        Require(models.Select(x => x.S("id")).Distinct().Count() == models.Length, "同一个服务中不能重复添加相同模型 ID。");
        return new JsonObject
        {
            ["id"] = id,
            ["name"] = CheckedText(Field(value, "name"), "服务名称", 120),
            ["endpoint"] = Addresses(Field(value, "endpoint")).Base,
            ["enabled"] = value.B("enabled"),
            ["models"] = new JsonArray(models)
        };
    }
    static bool Truthy(JsonNode? value) => value != null && (value is not JsonValue v ||
        (v.TryGetValue<bool>(out var flag) ? flag : v.TryGetValue<string>(out var text) ? text.Length > 0 :
            !v.TryGetValue<double>(out var number) || number != 0));
    static JsonNode? Provider(JsonNode config, string id) => config.A("services").FirstOrDefault(x => x.S("id") == id);
    static (JsonNode? Service, JsonNode? Model) Selected(JsonNode config, JsonNode? selection = null)
    {
        var chosen = selection ?? config["selection"];
        var provider = Provider(config, StringField(chosen, "serviceId"));
        return (provider, provider.A("models").FirstOrDefault(x => x.S("id") == StringField(chosen, "modelId")));
    }
    static void Reconcile(JsonObject config)
    {
        var (provider, model) = Selected(config);
        if (model == null) config["selection"] = null;
        if (!provider.B("enabled") || model == null) config["demo"] = true;
    }
    static JsonObject Migrate(JsonNode? value)
    {
        var config = new JsonObject
        {
            ["schemaVersion"] = 2,
            ["revision"] = 0,
            ["demo"] = !Field(value, "demo").IsBool() || value.B("demo"),
            ["continuationLimit"] = Integer(Field(value, "continuationLimit")) is >= 1 and <= 10000 and var limit ? limit : 100,
            ["services"] = new JsonArray(),
            ["selection"] = null
        };
        if (Integer(Field(value, "schemaVersion")) == 2)
        {
            var list = Field(value, "services") as JsonArray;
            Require(list != null && list.Count <= ServiceLimit, "保存的模型服务配置格式无效。");
            var entries = list!.Select(x => CleanService(x, CheckedText(Field(x, "id"), "服务标识", 80))).ToArray();
            Require(entries.Select(x => x.S("id")).Distinct().Count() == entries.Length, "保存的服务标识重复。");
            config["services"] = new JsonArray(entries);
            config["revision"] = Integer(Field(value, "revision")) ?? 0;
            if (Field(value, "selection") is JsonObject selected)
                config["selection"] = N(new { serviceId = selected.S("serviceId"), modelId = selected.S("modelId") });
        }
        else if (StringField(value, "endpoint").Trim().Length > 0)
        {
            var model = StringField(value, "model");
            var list = model.Trim().Length == 0 ? new JsonArray() : new JsonArray(N(new { id = model, name = model }));
            var legacy = CleanService(N(new { name = "默认服务", endpoint = value!.S("endpoint"), enabled = true, models = list }), "legacy");
            config.A("services").Add(legacy);
            if (Entry(legacy["models"]) is JsonNode item)
                config["selection"] = N(new { serviceId = "legacy", modelId = item.S("id") });
        }
        Reconcile(config);
        return config;
    }

    public async Task Initialize()
    {
        JsonNode? saved = null;
        if (Exists(modelFile))
        {
            try
            {
                Plain(modelFile);
                saved = JsonNode.Parse(await File.ReadAllBytesAsync(modelFile));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
            {
                throw new ApiException("无法读取模型配置，请检查 model.json 或从备份恢复。", 500);
            }
        }
        var config = Migrate(saved);
        var keys = new Dictionary<string, string>(StringComparer.Ordinal);
        var keysExist = Exists(keyFile);
        if (keysExist)
        {
            Plain(keyFile);
            JsonObject? persisted = null;
            try { persisted = JsonNode.Parse(await File.ReadAllBytesAsync(keyFile)) as JsonObject; }
            catch (JsonException) { }
            foreach (var service in config.A("services"))
            {
                var id = service.S("id");
                var entry = persisted?[id];
                var key = entry.IsString() ? entry.Str() : StringField(entry, "endpoint") == Addresses(service!["endpoint"]).Chat ? StringField(entry, "key") : "";
                if (key.Trim().Length > 0 && SingleLine(key)) keys[id] = key;
            }
        }
        var first = Selected(config).Service ?? Entry(config["services"]);
        if (!keysExist && envKey.Length > 0 && SingleLine(envKey) && first != null) keys[first.S("id")] = envKey;
        settings = new(config, keys, keysExist);
    }
    static JsonNode PublicSettings(Settings snapshot)
    {
        var config = (JsonObject)snapshot.Config.DeepClone();
        var (provider, model) = Selected(config);
        config["endpoint"] = provider.S("endpoint");
        config["model"] = model.S("id");
        config["hasKey"] = provider != null && snapshot.Keys.ContainsKey(provider.S("id"));
        foreach (var item in config.A("services")) item!["hasKey"] = snapshot.Keys.ContainsKey(item.S("id"));
        return config;
    }
    public JsonNode Read() => PublicSettings(settings);
    static void CheckRevision(JsonNode body, Settings snapshot, bool required = false)
    {
        var revision = Integer(Field(body, "revision"));
        if (required) Require(revision.HasValue, "请重新载入模型配置。", 409);
        Require(!Has(body, "revision") || revision == Integer(snapshot.Config["revision"]), "模型配置已在其他窗口更新，请重新载入后再保存。", 409);
    }
    static bool SameEndpoint(JsonNode? a, JsonNode? b) => a != null && b != null && Addresses(a["endpoint"]).Chat == Addresses(b["endpoint"]).Chat;
    static JsonObject BoundKeys(JsonObject config, Dictionary<string, string> keys)
    {
        var result = new JsonObject();
        foreach (var provider in config.A("services"))
            if (keys.TryGetValue(provider.S("id"), out var key))
                result[provider.S("id")] = N(new { endpoint = Addresses(provider!["endpoint"]).Chat, key });
        return result;
    }

    static async Task<string> Stage(string name, JsonNode value, bool credentials)
    {
        var path = name + "." + Id() + ".tmp";
        try
        {
            var opts = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None, Options = FileOptions.Asynchronous };
            if (credentials && !OperatingSystem.IsWindows()) opts.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            await using var file = new FileStream(path, opts);
            await JsonSerializer.SerializeAsync(file, value, Options);
            await file.FlushAsync();
            file.Flush(true);
            return path;
        }
        catch { TryDelete(path); throw; }
    }
    static void TryDelete(string? path)
    {
        if (path == null) return;
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
    static void Publish(string temporary, string target)
    {
        if (Exists(target)) Plain(target);
        File.Move(temporary, target, true);
    }
    async Task<JsonNode> Mutate(JsonNode body, Action<JsonObject, Dictionary<string, string>, Settings> apply)
    {
        await changes.WaitAsync();
        try
        {
            var before = settings;
            CheckRevision(body, before);
            var config = (JsonObject)before.Config.DeepClone();
            var keys = new Dictionary<string, string>(before.Keys, StringComparer.Ordinal);
            apply(config, keys, before);
            Reconcile(config);
            config["revision"] = Integer(before.Config["revision"])!.Value + 1;
            var priorBindings = BoundKeys(before.Config, before.Keys);
            var nextBindings = BoundKeys(config, keys);
            var writeKeys = !JsonNode.DeepEquals(priorBindings, nextBindings) || !before.KeysExist && envKey.Length > 0;
            Directory.CreateDirectory(state);
            string? stagedModel = null, stagedKeys = null, rollbackKeys = null;
            var publishedKeys = false;
            try
            {
                stagedModel = await Stage(modelFile, config, false);
                if (writeKeys)
                {
                    if (before.KeysExist && File.Exists(keyFile))
                    {
                        Plain(keyFile);
                        rollbackKeys = await Stage(keyFile, priorBindings, true);
                    }
                    stagedKeys = await Stage(keyFile, nextBindings, true);
                    Publish(stagedKeys, keyFile);
                    publishedKeys = true;
                }
                Publish(stagedModel, modelFile);
            }
            catch
            {
                if (publishedKeys)
                {
                    if (rollbackKeys != null) Publish(rollbackKeys, keyFile);
                    else File.Delete(keyFile);
                }
                throw;
            }
            finally
            {
                TryDelete(stagedModel);
                TryDelete(stagedKeys);
                TryDelete(rollbackKeys);
            }
            var updated = new Settings(config, keys, before.KeysExist || writeKeys);
            settings = updated;
            return PublicSettings(updated);
        }
        finally { changes.Release(); }
    }

    void Update(JsonObject config, Dictionary<string, string> keys, Settings before, JsonNode body)
    {
        if (Has(body, "continuationLimit"))
        {
            var limit = Integer(Field(body, "continuationLimit"));
            Require(limit is >= 1 and <= 10000, "续写字数上限需为 1–10000 之间的整数。");
            config["continuationLimit"] = limit!.Value;
        }
        if (Has(body, "endpoint") || Has(body, "model"))
        {
            Require(Field(body, "endpoint").IsString() && Field(body, "model").IsString(), "模型配置格式无效。");
            var previous = Selected(config).Service ?? Provider(config, "legacy");
            var id = previous.S("id", "legacy");
            if (body.S("endpoint").Trim().Length > 0)
            {
                var endpoint = Addresses(body["endpoint"]).Base;
                var model = body.S("model");
                var candidate = N(new { endpoint });
                var previousModel = SameEndpoint(previous, candidate) ? previous.A("models").FirstOrDefault(item => item.S("id") == model.Trim()) : null;
                var models = model.Trim().Length == 0 ? new JsonArray() : new JsonArray(previousModel.Copy() ?? N(new { id = model, name = model }));
                var provider = CleanService(N(new { name = previous.S("name", "默认服务"), endpoint, enabled = true, models }), id);
                var services = config.A("services");
                if (previous != null) services.Remove(previous);
                else Require(services.Count < ServiceLimit, $"最多添加 {ServiceLimit} 个服务。");
                services.Add(provider);
                config["selection"] = Entry(provider["models"]) is JsonNode item ? N(new { serviceId = id, modelId = item.S("id") }) : null;
                if (!SameEndpoint(previous, provider)) keys.Remove(id);
                if (previous == null && envKey.Length > 0 && SingleLine(envKey) && !before.KeysExist && keys.Count == 0) keys[id] = envKey;
            }
            if (Truthy(Field(body, "clearKey"))) keys.Remove(id);
            else if (body.S("key").Length > 0 && Provider(config, id) != null) keys[id] = CheckedText(body["key"], "API Key", 8192);
        }
        if (Has(body, "selection"))
        {
            var selection = Field(body, "selection");
            Require(Field(selection, "serviceId").IsString() && Field(selection, "modelId").IsString(), "请选择有效的服务和模型。");
            config["selection"] = N(new { serviceId = selection!.S("serviceId"), modelId = selection.S("modelId") });
            var (provider, model) = Selected(config);
            Require(provider.B("enabled") && model != null, "所选服务已停用，或模型已被移除，请重新选择。");
        }
        if (Has(body, "demo"))
        {
            Require(body["demo"].IsBool(), "演示模式配置无效。");
            var (provider, model) = Selected(config);
            Require(body.B("demo") || provider.B("enabled") && model != null, "请先添加并启用服务，再选择一个模型。");
            config["demo"] = body.B("demo");
        }
    }

    static void Upsert(JsonObject config, Dictionary<string, string> keys, JsonNode body)
    {
        var input = Field(body, "service");
        var update = Truthy(Field(input, "id"));
        var id = update ? StringField(input, "id") : Id();
        var previous = Provider(config, id);
        if (update) Require(previous != null, "服务已不存在，请重新载入。", 409);
        else Require(config.A("services").Count < ServiceLimit, $"最多添加 {ServiceLimit} 个服务。");
        var provider = CleanService(input, id);
        var services = config.A("services");
        if (previous != null) services[services.IndexOf(previous)] = provider;
        else services.Add(provider);
        var clearKey = Truthy(Field(body, "clearKey"));
        if (clearKey || !SameEndpoint(previous, provider)) keys.Remove(id);
        if (!clearKey && body.S("key").Length > 0) keys[id] = CheckedText(body["key"], "API Key", 8192);
    }

    static void Remove(JsonObject config, Dictionary<string, string> keys, JsonNode body)
    {
        var provider = Provider(config, body.S("id"));
        Require(provider != null, "服务已不存在，请重新载入。", 409);
        config.A("services").Remove(provider);
        keys.Remove(body.S("id"));
    }

    static void Reorder(JsonObject config, JsonNode body)
    {
        Require(Integer(body["revision"]).HasValue, "请重新载入模型配置。", 409);
        var byId = config.A("services").ToDictionary(x => x.S("id"));
        var list = body["ids"] as JsonArray;
        var ids = Strings(list).ToArray();
        Require(list != null && list.Count == byId.Count && ids.Distinct().Count() == byId.Count && ids.All(byId.ContainsKey),
            "服务顺序已失效，请重新载入。", 409);
        config["services"] = Array(ids.Select(id => byId[id]));
    }

    ModelRoute Resolve(JsonNode? selection, string? sessionId = null)
    {
        var snapshot = settings;
        Require(!snapshot.Config.B("demo"), "当前为演示模式。");
        var (provider, model) = Selected(snapshot.Config, Truthy(selection) ? selection : null);
        Require(provider.B("enabled") && model != null, "所选服务已停用，或模型已被移除，请重新选择。");
        return new(provider.S("endpoint"), model.S("id"), snapshot.Keys.GetValueOrDefault(provider.S("id"), ""), model, sessionId);
    }
    ModelRoute ResolveProbe(JsonNode body)
    {
        var snapshot = settings;
        CheckRevision(body, snapshot, true);
        var service = Field(body, "service");
        var endpoint = Addresses(Field(service, "endpoint")).Base;
        var id = StringField(service, "id");
        var saved = Provider(snapshot.Config, id);
        Require(!Has(service, "id") || saved != null, "服务已不存在，请重新载入。", 409);
        Require((!Has(body, "key") || body["key"].IsString()) && (!Has(body, "clearKey") || body["clearKey"].IsBool()), "密钥选项无效。");
        var key = body.B("clearKey") ? "" : body.S("key").Trim().Length > 0 ? CheckedText(body["key"], "API Key", 8192)
            : SameEndpoint(saved, N(new { endpoint })) ? snapshot.Keys.GetValueOrDefault(id, "") : "";
        var model = Has(body, "modelId") ? CheckedText(body["modelId"], "模型 ID") : "";
        return new(endpoint, model, key);
    }

    public async Task<JsonNode> Handle(HttpContext ctx, string route, JsonNode body)
    {
        if (route.StartsWith("/api/", StringComparison.Ordinal)) route = route[4..];
        if (HttpMethods.IsGet(ctx.Request.Method) && route == "/config") return Read();
        Require(HttpMethods.IsPost(ctx.Request.Method), "接口不存在。", 404);
        Require(body is JsonObject, "请求格式无效。");
        switch (route)
        {
            case "/config": return await Mutate(body, (config, keys, before) => Update(config, keys, before, body));
            case "/model-services": return await Mutate(body, (config, keys, _) => Upsert(config, keys, body));
            case "/model-services/remove": return await Mutate(body, (config, keys, _) => Remove(config, keys, body));
            case "/model-services/reorder": return await Mutate(body, (config, _, _) => Reorder(config, body));
            case "/model-services/probe":
                var result = await Probe(ResolveProbe(body), ctx.RequestAborted);
                CheckRevision(body, settings, true);
                return result;
            default:
                if (route.StartsWith("/ai-tools/", StringComparison.Ordinal)) return await HandleTool(ctx, route[10..], body);
                throw new ApiException("接口不存在。", 404);
        }
    }

    public void Dispose() => changes.Dispose();
}
