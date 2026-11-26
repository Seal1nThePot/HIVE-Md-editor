using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using static Hive.J;

namespace Hive;

public sealed class ShellBridge(bool managed, bool desktop)
{
    public bool Desktop { get; } = desktop;
    readonly bool managed = managed;
    readonly object output = new();
    readonly ConcurrentDictionary<string, (string Type, TaskCompletionSource<bool> Reply)> nativeCalls = new();
    readonly ConcurrentDictionary<string, Task> requests = new();
    static ApiException Failure() => new("无法打开系统资源管理器，请重试。", 503);

    public void Emit(JsonNode message)
    {
        lock (output) Console.WriteLine(message.ToJsonString(Options));
    }
    public Task OpenDirectory(string path) => Call("open-directory", path);
    public Task Reveal(string path) => Call("reveal-file", path);
    public async Task Call(string operation, string path)
    {
        if (!Desktop)
        {
            Require(OperatingSystem.IsWindows(), "仅 Windows 支持打开系统资源管理器。", 503);
            try
            {
                var start = new ProcessStartInfo("explorer.exe") { UseShellExecute = false, CreateNoWindow = true };
                if (operation == "reveal-file") start.ArgumentList.Add("/select," + path);
                else start.ArgumentList.Add(path);
                using var handle = Process.Start(start);
                if (handle == null) throw Failure();
                return;
            }
            catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception) { throw Failure(); }
        }
        var id = Id();
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        nativeCalls[id] = (operation == "reveal-file" ? "hive-reveal-result" : "hive-open-directory-result", completion);
        try
        {
            Emit(N(new { type = "hive-" + operation, id, path }));
            if (!await completion.Task.WaitAsync(TimeSpan.FromSeconds(5))) throw Failure();
        }
        catch (TimeoutException) { throw Failure(); }
        finally { nativeCalls.TryRemove(id, out _); }
    }
    public async Task ReadInput(Action shutdown, Func<string, JsonNode, Task<JsonNode>> request)
    {
        if (!managed) return;
        using var input = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        try
        {
            while (await input.ReadLineAsync() is { } line)
            {
                if (line.Length > 14_000_000) continue;
                JsonNode? node;
                try { node = JsonNode.Parse(line); }
                catch (JsonException) { continue; }
                var type = node.S("type");
                if (type == "hive-shutdown") return;
                var id = node.S("id");
                if (nativeCalls.TryGetValue(id, out var call) && type == call.Type)
                    call.Reply.TrySetResult(node.B("ok"));
                if (Desktop && type == "hive-native-request" && Guid.TryParseExact(id, "D", out _) &&
                    node is JsonObject json && requests.Count < 256)
                {
                    var body = json["body"] ?? new JsonObject();
                    var task = Reply(id, node.S("method"), body, request);
                    requests[id] = task;
                    _ = task.ContinueWith(t => requests.TryRemove(id, out _), TaskScheduler.Default);
                }
            }
        }
        catch (IOException) { }
        finally
        {
            foreach (var call in nativeCalls.Values) call.Reply.TrySetResult(false);
            shutdown();
        }
    }
    async Task Reply(string id, string method, JsonNode body, Func<string, JsonNode, Task<JsonNode>> request)
    {
        JsonNode reply;
        try { reply = N(new { type = "hive-native-result", id, ok = true, result = await request(method, body) }); }
        catch (Exception e) { reply = N(new { type = "hive-native-result", id, ok = false, message = e.Message }); }
        try { Emit(reply); }
        catch (IOException) { }
    }
    public Task Drain() => Task.WhenAll(requests.Values);
}
