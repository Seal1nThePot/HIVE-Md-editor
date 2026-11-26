using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.Features;
using static Hive.J;

namespace Hive;

public sealed partial class ModelService
{
    const int CatalogBytes = 8 * 1024 * 1024;
    const int ProbeBytes = 64 * 1024;
    const int ToolBytes = 128 * 1024;
    const int RequestCharacters = 120000;
    static readonly string[] ImageParts = ["image_url", "input_image", "image"];
    static readonly HttpClient Http = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        UseCookies = false,
        AutomaticDecompression = DecompressionMethods.All,
        PooledConnectionLifetime = TimeSpan.FromMinutes(5)
    })
    {
        Timeout = Timeout.InfiniteTimeSpan
    };

    static string WireJson(JsonNode? node)
    {
        // System.Text.Json escapes supplementary characters even with its relaxed encoder.
        // The provider request and HIVE's UTF-16/UTF-8 budgets use the same JSON representation.
        var output = new StringBuilder();
        void AddString(string value)
        {
            output.Append('"');
            for (var i = 0; i < value.Length; i++)
            {
                var character = value[i];
                switch (character)
                {
                    case '"': output.Append("\\\""); break;
                    case '\\': output.Append("\\\\"); break;
                    case '\b': output.Append("\\b"); break;
                    case '\f': output.Append("\\f"); break;
                    case '\n': output.Append("\\n"); break;
                    case '\r': output.Append("\\r"); break;
                    case '\t': output.Append("\\t"); break;
                    default:
                        if (char.IsHighSurrogate(character) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
                            output.Append(character).Append(value[++i]);
                        else if (character < ' ' || char.IsSurrogate(character))
                            output.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                        else output.Append(character);
                        break;
                }
            }
            output.Append('"');
        }
        void Add(JsonNode? value)
        {
            if (value is JsonObject obj)
            {
                output.Append('{');
                var first = true;
                foreach (var (key, item) in obj)
                {
                    if (!first) output.Append(',');
                    first = false;
                    AddString(key);
                    output.Append(':');
                    Add(item);
                }
                output.Append('}');
            }
            else if (value is JsonArray array)
            {
                output.Append('[');
                for (var i = 0; i < array.Count; i++)
                {
                    if (i > 0) output.Append(',');
                    Add(array[i]);
                }
                output.Append(']');
            }
            else if (value.IsString()) AddString(value.Str());
            else output.Append(value?.ToJsonString(Options) ?? "null");
        }
        Add(node);
        return output.ToString();
    }

    static ApiException UpstreamError(string message, int status = 502) => new(message, status);
    static string ErrorForStatus(int status, bool catalog = false) => status switch
    {
        401 or 403 => $"模型端点未通过鉴权（HTTP {status}），请检查密钥和访问权限。",
        >= 300 and < 400 => "模型端点要求跳转。请直接填写最终的兼容接口地址。",
        404 when catalog => "此地址未提供模型列表（HTTP 404），请核对接口地址或手动填写模型 ID。",
        429 => "模型端点已限流或额度不足（HTTP 429），请稍后重试或检查额度。",
        _ => $"模型端点返回 HTTP {status}，请检查接口地址、模型或服务配置。"
    };

    static void Headers(HttpRequestMessage request, string key)
    {
        if (key.Length > 0) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
    }
    static async Task<JsonNode?> UpstreamJson(HttpResponseMessage response, int limit, CancellationToken token)
    {
        await using var input = await response.Content.ReadAsStreamAsync(token);
        using var bytes = new MemoryStream();
        var buffer = new byte[8192];
        int count;
        while ((count = await input.ReadAsync(buffer, token)) > 0)
        {
            if (bytes.Length + count > limit) throw UpstreamError("模型端点返回的内容超出读取上限。");
            bytes.Write(buffer, 0, count);
        }
        try
        {
            var data = bytes.GetBuffer().AsSpan(0, (int)bytes.Length);
            if (data.StartsWith(new byte[] { 0xef, 0xbb, 0xbf })) data = data[3..];
            return JsonNode.Parse(Encoding.UTF8.GetString(data));
        }
        catch (JsonException) { throw UpstreamError("模型端点未返回有效的 JSON。"); }
    }
    static bool UnsupportedLimit(JsonNode? error)
    {
        var detail = Field(error, "error");
        if (StringField(detail, "param") == "max_completion_tokens" &&
            StringField(detail, "code") is "unsupported_parameter" or "unknown_parameter" or "unrecognized_request_argument") return true;
        var message = StringField(detail, "message");
        return message.Contains("max_completion_tokens", StringComparison.OrdinalIgnoreCase)
            && Regex.IsMatch(message, "unsupported|not supported|unknown|unrecognized|extra inputs", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }
    // Addresses has already validated the authority and escaped the path. Uri's default
    // path canonicalization decodes existing escapes such as %41 before sending the request.
    static Uri ModelUri(string address) => new(address, new UriCreationOptions { DangerousDisablePathAndQueryCanonicalization = true });

    static async Task<HttpResponseMessage> SendChat(ModelRoute route, JsonObject payload, CancellationToken token, long? output = null)
    {
        var endpoint = ModelUri(Addresses(JsonValue.Create(route.Endpoint)).Chat);
        string? opencodeSession = null;
        if (endpoint.GetLeftPart(UriPartial.Authority) == "https://opencode.ai" &&
            endpoint.AbsolutePath is "/zen/go/v1/chat/completions" or "/inference/go/openai/v1/chat/completions")
            opencodeSession = Guid.TryParseExact(route.SessionId, "D", out _) ? route.SessionId : Id();

        async Task<HttpResponseMessage> Send(string? limit)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
            Headers(request, route.Key);
            if (payload.B("stream")) request.Headers.Accept.ParseAdd("text/event-stream");
            request.Headers.Accept.ParseAdd("application/json");
            if (opencodeSession != null)
            {
                request.Headers.UserAgent.ParseAdd("HIVE-markdown-editor");
                request.Headers.Add("x-opencode-session", opencodeSession);
            }
            var body = (JsonObject)payload.DeepClone();
            if (limit != null) body[limit] = output!.Value;
            request.Content = new StringContent(WireJson(body), Encoding.UTF8, "application/json");
            return await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
        }

        var response = await Send(output.HasValue ? "max_completion_tokens" : null);
        if (output.HasValue && (int)response.StatusCode is 400 or 422)
        {
            JsonNode? error = null;
            try { error = await UpstreamJson(response, ProbeBytes, token); }
            catch (ApiException) { }
            catch (IOException) { }
            catch (HttpRequestException) { }
            catch
            {
                response.Dispose();
                throw;
            }
            if (UnsupportedLimit(error))
            {
                response.Dispose();
                return await Send("max_tokens");
            }
        }
        return response;
    }

    static JsonArray Catalog(JsonNode? data, string key)
    {
        if (Truthy(Field(data, "error")) || Field(data, "data") is not JsonArray raw)
            throw UpstreamError("模型端点未返回兼容的模型列表（需要 data 数组）。");
        var models = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var item in raw)
        {
            var id = StringField(item, "id").Trim();
            if (id.Length is 0 or > 200 || !SingleLine(id)) continue;
            var label = StringField(item, "name").Trim();
            var name = label.Length is > 0 and <= 200 && SingleLine(label) ? label : id;
            var capabilities = Capabilities(item, catalog: true);
            if (!models.TryGetValue(id, out var original))
            {
                original = new() { ["id"] = id, ["name"] = name };
                models.Add(id, original);
            }
            if (capabilities == null) continue;
            if (original["capabilities"] is JsonObject retained)
                foreach (var (kind, value) in retained) capabilities[kind] = value.Copy();
            original["capabilities"] = capabilities;
        }
        bool Echoes(string value) => value == key || key.Length >= 8 && value.Contains(key, StringComparison.Ordinal);
        foreach (var model in models.Values)
        {
            var reasoning = Field(Field(model, "capabilities"), "reasoning") as JsonObject;
            if (key.Length > 0 && (Echoes(model.S("id")) || Echoes(model.S("name")) ||
                reasoning != null && reasoning.Any(option => Echoes(option.Value.S("value")))))
                throw UpstreamError("模型列表包含不应返回的连接信息，已停止读取。");
        }
        return new JsonArray(models.Values.ToArray());
    }

    static async Task<JsonNode> Probe(ModelRoute route, CancellationToken caller)
    {
        var started = Stopwatch.GetTimestamp();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(timeout.Token, caller);
        var token = linked.Token;
        try
        {
            if (route.Model.Length == 0)
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, ModelUri(Addresses(JsonValue.Create(route.Endpoint)).Models));
                Headers(request, route.Key);
                request.Headers.Accept.ParseAdd("application/json");
                using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
                if (!response.IsSuccessStatusCode) throw UpstreamError(ErrorForStatus((int)response.StatusCode, catalog: true));
                var data = await UpstreamJson(response, CatalogBytes, token);
                var result = new JsonObject { ["kind"] = "catalog", ["models"] = Catalog(data, route.Key), ["configurationLimit"] = ModelLimit };
                if (Field(data, "has_more").IsBool() && data.B("has_more")) result["hasMore"] = true;
                return result;
            }
            var payload = (JsonObject)N(new { model = route.Model, messages = new[] { new { role = "user", content = "Reply with OK." } }, stream = false });
            using var upstream = await SendChat(route, payload, token, 32);
            if (!upstream.IsSuccessStatusCode) throw UpstreamError(ErrorForStatus((int)upstream.StatusCode));
            var value = await UpstreamJson(upstream, ProbeBytes, token);
            var choice = Entry(Field(value, "choices"));
            var content = StringField(Field(choice, "message"), "content");
            var produced = StringField(choice, "finish_reason") == "length" && Integer(Field(Field(value, "usage"), "completion_tokens")) > 0;
            if (Truthy(Field(value, "error")) || !produced && content.Trim().Length == 0)
                throw UpstreamError("模型端点未返回可用的测试回复。请检查所选模型是否支持 Chat Completions。");
            return N(new { kind = "generation", modelId = route.Model, elapsedMs = (long)Math.Round(Stopwatch.GetElapsedTime(started).TotalMilliseconds) });
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested && !caller.IsCancellationRequested)
        {
            throw UpstreamError("模型服务测试超时，请检查网络后重试。", 504);
        }
        catch (Exception e) when ((e is HttpRequestException or IOException) && !caller.IsCancellationRequested)
        {
            throw UpstreamError("无法连接模型端点，请检查网络及接口地址。");
        }
    }

    static bool ValidPart(JsonNode? part)
    {
        var type = StringField(part, "type");
        if (type is "text" or "input_text")
            return Field(part, "text").IsString() && StringField(part, "text").Length <= 100000;
        var image = Field(part, "image_url");
        var url = image.IsString() ? image.Str() : StringField(image, "url");
        return ImageParts.Contains(type) && url.StartsWith("data:image/", StringComparison.Ordinal);
    }
    static (JsonObject Payload, long? Output, bool Reasoning) GenerationPayload(ModelRoute route, JsonNode body)
    {
        var supplied = Field(body, "messages") as JsonArray;
        Require(supplied != null && supplied.Count <= 160, "本轮上下文格式无效或超过 160 条消息。");
        var messages = new JsonArray();
        var hasImages = false;
        foreach (var item in supplied!)
        {
            var role = StringField(item, "role");
            var content = Field(item, "content");
            Require(role is "system" or "user" or "assistant" &&
                (content.IsString() || role == "user" && content is JsonArray { Count: > 0 and <= 32 } parts && parts.All(ValidPart)),
                "本轮上下文格式无效或超过 160 条消息。");
            if (content is JsonArray segments && segments.Any(p => ImageParts.Contains(StringField(p, "type")))) hasImages = true;
            messages.Add(new JsonObject { ["role"] = role, ["content"] = content.Copy() });
        }
        var model = route.ModelConfig;
        var capabilities = Field(model, "capabilities");
        var inputs = InputMapping(Field(model, "inputTypes") ?? Field(capabilities, "input"));
        Require(!hasImages || inputs.Contains("image"),
            "该模型未声明图片输入。请在「模型设置 · 输入类型」勾选图片，或换用支持图片的模型。", 415);
        var payload = new JsonObject { ["model"] = route.Model, ["messages"] = messages, ["stream"] = true };
        var level = Has(body, "reasoningEffort") ? StringField(body, "reasoningEffort") : StringField(model, "defaultReasoning", "default");
        if (level != "default")
        {
            Require(EffectiveReasoning(model).Contains(level), "所选推理档位已不可用，请切回默认或重新选择。", 409);
            var mapping = Field(Field(capabilities, "reasoning"), level);
            var effort = StringField(mapping, "value", level == "off" ? "none" : level);
            switch (StringField(mapping, "parameter"))
            {
                case "reasoning.effort": payload["reasoning"] = N(new { effort }); break;
                case "thinking.type": payload["thinking"] = N(new { type = effort }); break;
                default: payload["reasoning_effort"] = effort; break;
            }
        }
        var context = Capacity(Field(model, "contextTokens")) ?? Capacity(Field(capabilities, "contextTokens"));
        var explicitOutput = Capacity(Field(model, "maxOutputTokens"));
        var upstreamOutput = Capacity(Field(capabilities, "maxOutputTokens"));
        long Estimate(string serialized) => Encoding.UTF8.GetByteCount(serialized) + 64 + 16 * messages.Count;
        string Serialize(long? limit)
        {
            if (limit == null) return WireJson(payload);
            var withLimit = (JsonObject)payload.DeepClone();
            withLimit["max_completion_tokens"] = limit.Value;
            return WireJson(withLimit);
        }
        var output = explicitOutput ?? upstreamOutput ?? (context.HasValue ? Math.Clamp(context.Value / 4, 1, 2048) : null);
        if (explicitOutput == null && upstreamOutput.HasValue && context.HasValue)
            output = Math.Clamp(context.Value - Estimate(Serialize(upstreamOutput)), 1, upstreamOutput.Value);
        var serialized = Serialize(output);
        Require(serialized.Length <= RequestCharacters, "本轮请求超过 HIVE 的 12 万序列化字符上限，请减少会话内容或缩小选区后重试。");
        if (context.HasValue)
        {
            var estimated = Estimate(serialized) + output!.Value;
            Require(estimated <= context.Value,
                $"本轮完整请求约需 {estimated} token（含 {output} 输出预留），超过该模型的 {context} token 上限。请缩小选区、减少参考资料或另开会话。", 413);
        }
        return (payload, output, level != "default");
    }

    static async Task Emit(HttpResponse response, string name, JsonNode data, CancellationToken token)
    {
        await response.WriteAsync($"event: {name}\ndata: {WireJson(data)}\n\n", token);
        await response.Body.FlushAsync(token);
    }
    static void CheckFinish(string reason)
    {
        if (reason == "length") throw UpstreamError("本轮已达到最大输出长度，请调整后重试。");
        if (reason.Length > 0 && reason != "stop") throw UpstreamError("生成未完整结束，请重试。");
    }
    static async Task RelayStream(HttpResponseMessage upstream, HttpResponse response, CancellationToken token)
    {
        await using var stream = await upstream.Content.ReadAsStreamAsync(token);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        var buffer = new char[4096];
        var line = new StringBuilder();
        var data = new StringBuilder();
        var received = false;
        var finished = false;
        var skipLf = false;

        async Task ParseEvent()
        {
            if (data.Length == 0) return;
            var frame = data.ToString();
            data.Clear();
            if (frame == "[DONE]")
            {
                finished = true;
                return;
            }
            JsonNode? value;
            try { value = JsonNode.Parse(frame); }
            catch (JsonException) { throw UpstreamError("模型端点返回了无法解析的流式响应。"); }
            if (value == null) throw UpstreamError("模型端点返回了无法解析的流式响应。");
            if (Truthy(Field(value, "error"))) throw UpstreamError("模型端点返回错误，请检查配置后重试。");
            var choice = Entry(Field(value, "choices"));
            var delta = StringField(Field(choice, "delta"), "content");
            if (delta.Length > 0)
            {
                received = true;
                await Emit(response, "chunk", JsonValue.Create(delta), token);
            }
            var reason = StringField(choice, "finish_reason");
            if (reason.Length > 0)
            {
                CheckFinish(reason);
                finished = true;
            }
        }
        async Task FinishLine()
        {
            if (line.Length == 0) { await ParseEvent(); return; }
            var value = line.ToString();
            line.Clear();
            if (!value.StartsWith("data:", StringComparison.Ordinal)) return;
            if (data.Length > 0) data.Append('\n');
            data.Append(value.AsSpan(5).Trim());
            if (data.Length > CatalogBytes) throw UpstreamError("模型端点返回的内容超出读取上限。");
        }

        int count;
        while ((count = await reader.ReadAsync(buffer, token)) > 0)
        {
            for (var i = 0; i < count; i++)
            {
                var character = buffer[i];
                if (skipLf)
                {
                    skipLf = false;
                    if (character == '\n') continue;
                }
                if (character is '\r' or '\n')
                {
                    skipLf = character == '\r';
                    await FinishLine();
                }
                else
                {
                    if (line.Length >= CatalogBytes) throw UpstreamError("模型端点返回的内容超出读取上限。");
                    line.Append(character);
                }
            }
        }
        if (line.Length > 0) await FinishLine();
        await ParseEvent();
        if (!received || !finished) throw UpstreamError("模型响应中断或未返回正文，未生成可采纳建议。");
    }

    public async Task Generate(HttpContext ctx, JsonNode body)
    {
        Require(body is JsonObject, "请求格式无效。");
        var route = Resolve(Field(body, "selection"), ctx.Request.Headers["x-hive-model-session"].FirstOrDefault());
        var (payload, output, reasoning) = GenerationPayload(route, body);
        using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(120));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted, limit.Token);
        var token = linked.Token;
        var response = ctx.Response;
        try
        {
            using var upstream = await SendChat(route, payload, token, output);
            if (!upstream.IsSuccessStatusCode)
                throw UpstreamError(ErrorForStatus((int)upstream.StatusCode) + (reasoning ? "可将推理强度调回默认后重试。" : ""));
            response.ContentType = "text/event-stream; charset=utf-8";
            response.Headers["X-Accel-Buffering"] = "no";
            ctx.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            await response.StartAsync(token);
            if (upstream.Content.Headers.ContentType?.MediaType?.Contains("text/event-stream", StringComparison.OrdinalIgnoreCase) == true)
                await RelayStream(upstream, response, token);
            else
            {
                var data = await UpstreamJson(upstream, CatalogBytes, token);
                var choice = Entry(Field(data, "choices"));
                var value = StringField(Field(choice, "message"), "content");
                if (Truthy(Field(data, "error")) || value.Length == 0) throw UpstreamError("端点未返回可用正文。");
                CheckFinish(StringField(choice, "finish_reason"));
                await Emit(response, "chunk", JsonValue.Create(value), token);
            }
            await Emit(response, "done", new JsonObject(), token);
        }
        catch (Exception e) when (e is ApiException or OperationCanceledException or HttpRequestException or IOException)
        {
            if (ctx.RequestAborted.IsCancellationRequested) return;
            var message = e switch
            {
                OperationCanceledException => "请求已停止或超时。",
                ApiException api => api.Message,
                _ when limit.IsCancellationRequested => "请求已停止或超时。",
                _ when response.HasStarted => "模型响应中断或未返回正文，未生成可采纳建议。",
                _ => "无法连接模型端点，请检查本机网络及端点地址。"
            };
            if (!response.HasStarted) throw UpstreamError(message);
            try { await Emit(response, "error", JsonValue.Create(message), ctx.RequestAborted); }
            catch (OperationCanceledException) when (ctx.RequestAborted.IsCancellationRequested) { }
            catch (IOException) when (ctx.RequestAborted.IsCancellationRequested) { }
        }
    }
}
