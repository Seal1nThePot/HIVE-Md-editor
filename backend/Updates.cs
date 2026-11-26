using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using static Hive.J;

namespace Hive;

public sealed partial class Updates
{
    const string ClosingMessage = "HIVE 尚未完成保存退出。请处理当前提示后重试更新。";
    const string ReadWriteMessage = "无法读取或写入更新文件，请检查更新包和程序目录权限。";
    const string StagePrefix = ".hive-update-";
    const string PlanName = "plan.json";
    const string ReadyName = "ready.json";
    const string CompleteName = "complete";
    readonly string appData;
    readonly string electron;
    readonly string arch;
    readonly string? executable;
    readonly string? resources;
    readonly ShellBridge shell;
    readonly HttpClient network;
    readonly SemaphoreSlim gate = new(1);
    readonly CancellationTokenSource stopping = new();
    volatile JsonNode progress = N(new { phase = "idle" });
    Pending? pending;

    sealed record Pending(string Token, string Directory, BuildRecord Before, Release? Internet = null, Manifest? Manifest = null, bool Extracted = false);
    sealed record ProcessIdentity(int Pid, long Started)
    {
        public JsonNode AsJson() => N(new { pid = Pid, started = Started });
    }

    public Updates(string appData, ShellBridge shell) : this(appData, shell, UpdateNetwork) { }

    internal Updates(string appData, ShellBridge shell, HttpClient network)
    {
        this.appData = appData;
        this.shell = shell;
        this.network = network;
        electron = Environment.GetEnvironmentVariable("HIVE_UPDATE_ELECTRON") ?? "";
        arch = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "x64",
            Architecture.Arm64 => "arm64",
            Architecture.X86 => "ia32",
            _ => ""
        };
        var path = Environment.GetEnvironmentVariable("HIVE_UPDATE_APP_EXE");
        if (shell.Desktop && OperatingSystem.IsWindows() && Environment.GetEnvironmentVariable("HIVE_UPDATE_PACKAGED") == "1" &&
            string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PORTABLE_EXECUTABLE_FILE")) &&
            path != null && Path.IsPathFullyQualified(path) && arch.Length > 0 && electron.Length > 0)
        {
            executable = Path.GetFullPath(path);
            resources = Path.Combine(Path.GetDirectoryName(executable)!, "resources");
        }
    }

    static JsonNode Status(string status) => N(new { status });
    static JsonNode Failure(string message) => N(new { status = "error", message });
    static JsonNode Prompt(Pending value) => N(new
    {
        status = "confirm",
        token = value.Token,
        online = value.Internet != null,
        build = value.Manifest!.Build.AsJson()
    });
    string SourceFile => Path.Combine(appData, "update-source.json");
    string Stage(string token) => Path.Combine(resources!, StagePrefix + token);
    static bool ValidToken(string token) => Guid.TryParseExact(token, "D", out var guid) && guid.ToString("D") == token;

    void SetProgress(JsonNode value)
    {
        progress = value;
        try { shell.Emit(N(new { type = "hive-update-progress", progress = value })); }
        catch (IOException) { }
    }

    async Task<bool> Online()
    {
        try { return (await ReadJson(SourceFile)).S("source") == "internet"; }
        catch (FileNotFoundException) { return false; }
        catch (ApiException) { return false; }
    }

    async Task<string?> ReleaseDirectory()
    {
        try
        {
            var config = await ReadJson(Path.Combine(resources!, "hive-update-source.json"), "本地更新源配置无效。");
            var root = config.S("directory");
            Require(Path.IsPathFullyQualified(root) && !root.Contains('\0'), "本地更新源配置无效。");
            return Path.Combine(Path.GetFullPath(root), "latest");
        }
        catch (FileNotFoundException) { return null; }
    }

    async Task<JsonNode> Mode()
    {
        if (resources == null) return JsonValue.Create("unsupported");
        if (await Online()) return JsonValue.Create("internet");
        try { return JsonValue.Create(await ReleaseDirectory() != null ? "directory" : "picker"); }
        catch (Exception e) when (e is ApiException or IOException or UnauthorizedAccessException)
        {
            return JsonValue.Create("directory");
        }
    }

    async Task<JsonNode> SetSource(JsonNode body)
    {
        Require(resources != null && pending == null && body.S("source") is "local" or "internet", "无法切换更新来源。");
        await Write(SourceFile, N(new { source = body.S("source") }));
        return await Mode();
    }

    static void CleanTree(string directory)
    {
        try
        {
            if (!Directory.Exists(directory)) return;
            Plain(directory);
            foreach (var path in Directory.EnumerateFileSystemEntries(directory))
            {
                var attributes = File.GetAttributes(path);
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    if ((attributes & FileAttributes.ReparsePoint) != 0) Directory.Delete(path);
                    else CleanTree(path);
                }
                else File.Delete(path);
            }
            Directory.Delete(directory);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ApiException) { }
    }

    Pending DemandPending(JsonNode body)
    {
        var requested = pending;
        Require(requested != null && requested.Token == body.S("token"), "这次更新已取消或过期，请重新检查更新。");
        return requested!;
    }

    void ClearPending()
    {
        var prior = pending;
        pending = null;
        if (prior != null) CleanTree(prior.Directory);
    }

    JsonNode Finish(string status, string? error = null)
    {
        ClearPending();
        if (error == null)
        {
            SetProgress(N(new { phase = "idle" }));
            return Status(status);
        }
        SetProgress(N(new { phase = "error", message = error }));
        return Failure(error);
    }

    async Task<JsonNode> Begin()
    {
        if (resources == null) return Failure("应用内更新适用于 Windows 目录版。");
        if (pending != null || progress.S("phase") == "restarting") return Failure("已有更新正在处理。");
        SetProgress(N(new { phase = "checking" }));
        var online = await Online();
        var releaseDir = online ? null : await ReleaseDirectory();
        var current = await ReadPayloadBuild(resources, arch);
        var token = Id();
        pending = new(token, Stage(token), current);
        if (online)
        {
            var release = await LatestRelease(network, electron, arch, stopping.Token);
            if (release == null) return Finish("empty");
            if (!Newer(current, release.Manifest.Build)) return Finish("current");
            pending = pending with { Internet = release, Manifest = release.Manifest };
            return Prompt(pending);
        }
        if (releaseDir == null) return N(new { status = "picker", token });
        if (!File.Exists(Path.Combine(releaseDir, ManifestName))) return Finish("empty");
        return await Choose(pending, Path.Combine(releaseDir, ManifestName));
    }

    async Task<JsonNode> Choose(Pending update, string manifestPath)
    {
        Require(update.Manifest == null && update.Internet == null, "这次更新已确认，请重新检查更新。");
        Require(Path.IsPathFullyQualified(manifestPath) && !manifestPath.Contains('\0'), FormatMessage);
        manifestPath = Path.GetFullPath(manifestPath);
        var directory = Path.GetDirectoryName(manifestPath)!;
        Plain(directory);
        var manifest = ParseManifest(await ReadJson(manifestPath), electron, arch);
        if (!Newer(update.Before, manifest.Build)) return Finish("current");
        var bundle = Path.Combine(directory, BundleName);
        Require(File.Exists(bundle), "更新文件缺失或大小不符，请重新取得完整的更新包。");
        FileSystemIdentity.NewDirectory(update.Directory);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
        timeout.CancelAfter(TimeSpan.FromMinutes(10));
        await Extract(bundle, Path.Combine(update.Directory, "payload"), manifest, arch, timeout.Token);
        pending = update with { Manifest = manifest, Extracted = true };
        return Prompt(pending);
    }

    async Task<JsonNode> Prepare(Pending update)
    {
        Require(update.Manifest != null, "这次更新尚未确认，请重新检查更新。");
        if (!update.Extracted)
        {
            Require(update.Internet != null, "这次更新尚未下载，请重新检查更新。");
            FileSystemIdentity.NewDirectory(update.Directory);
            var zip = Path.Combine(update.Directory, BundleName);
            await DownloadBundle(update.Internet!, zip);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
            timeout.CancelAfter(TimeSpan.FromMinutes(10));
            await Extract(zip, Path.Combine(update.Directory, "payload"), update.Manifest!, arch, timeout.Token);
            File.Delete(zip);
        }

        var worker = Path.Combine(update.Directory, "worker");
        FileSystemIdentity.NewDirectory(worker);
        var installed = Path.Combine(resources!, BackendName);
        foreach (var (path, relative) in PlainFiles(installed))
        {
            if (relative == "app" || relative.StartsWith("app/", StringComparison.Ordinal)) continue;
            stopping.Token.ThrowIfCancellationRequested();
            var target = Path.Combine(worker, relative.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(path, target, overwrite: false);
        }
        Require(File.Exists(Path.Combine(worker, BackendExe)), FullPackage);
        pending = update with { Extracted = true };
        return Status("ready");
    }

    static ProcessIdentity Identity(Process process) => new(process.Id, process.StartTime.ToUniversalTime().Ticks);
    static ProcessIdentity ReadIdentity(JsonNode? value)
    {
        var node = ObjectOrFail(value, "更新进程身份无效。");
        var pid = node.I("pid");
        var start = node["started"] is JsonValue scalar && scalar.TryGetValue<long>(out var time) ? time : 0;
        Require(pid > 0 && start > 0, "更新进程身份无效。");
        return new(pid, start);
    }

    async Task<JsonNode> Launch(Pending update, JsonNode body)
    {
        var worker = Path.Combine(update.Directory, "worker", BackendExe);
        Require(update.Extracted && update.Manifest != null && File.Exists(worker), "更新未完成校验，请重新检查更新。");
        Require(int.TryParse(Environment.GetEnvironmentVariable("HIVE_UPDATE_PARENT_PID"), out var parentPid) && parentPid > 0, ClosingMessage);
        using var parent = Process.GetProcessById(parentPid);
        using var owner = Process.GetCurrentProcess();
        Require(string.Equals(parent.MainModule?.FileName, executable, StringComparison.OrdinalIgnoreCase), ClosingMessage);
        var args = ReadArguments(body);
        var plan = N(new
        {
            executable,
            token = update.Token,
            arch,
            parent = Identity(parent).AsJson(),
            owner = Identity(owner).AsJson(),
            before = update.Before.AsJson(),
            next = update.Manifest!.Build.AsJson(),
            args
        });
        await Write(Path.Combine(update.Directory, PlanName), plan);
        var start = new ProcessStartInfo(worker)
        {
            WorkingDirectory = update.Directory,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        start.ArgumentList.Add("--apply-update");
        start.ArgumentList.Add(update.Directory);
        using var process = Process.Start(start) ?? throw new ApiException("无法启动更新程序。");
        _ = CleanupWhenFinished(update.Directory);
        pending = null;
        var next = (JsonObject)progress.DeepClone();
        next["phase"] = "restarting";
        SetProgress(next);
        return Status("restarting");
    }

    static string[] ReadArguments(JsonNode body)
    {
        var args = body.A("args");
        Require(body["args"] is JsonArray && args.Count <= 100 && args.All(value => value.IsString() && value.Str().Length <= 8192 && !value.Str().Contains('\0')),
            "重启参数无效。");
        return args.Select(value => value.Str()).ToArray();
    }

    async Task<JsonNode> MarkReady()
    {
        if (resources == null) return Status("idle");
        var token = Environment.GetEnvironmentVariable("HIVE_UPDATE_STARTUP") ?? "";
        var cleanup = Environment.GetEnvironmentVariable("HIVE_UPDATE_CLEANUP") ?? token;
        if (ValidToken(token))
        {
            var stage = Stage(token);
            if (Directory.Exists(stage))
            {
                Plain(stage);
                var plan = await ReadJson(Path.Combine(stage, PlanName));
                Require(plan.S("token") == token && plan.S("executable") == executable, "更新启动记录无效。");
                var expected = ParseBuild(plan["next"], "更新启动记录无效。");
                var current = await ReadPayloadBuild(resources, arch);
                Require(expected == current, "已启动的版本与更新包不匹配。");
                await Write(Path.Combine(stage, ReadyName), N(new { token, build = current.AsJson() }));
            }
        }
        if (ValidToken(cleanup)) _ = CleanupWhenFinished(Stage(cleanup));
        return Status("ready");
    }

    static async Task CleanupWhenFinished(string directory)
    {
        ProcessIdentity? worker = null;
        for (var attempts = 0; attempts < 360 && Directory.Exists(directory); attempts++)
        {
            if (worker == null && File.Exists(Path.Combine(directory, CompleteName)))
            {
                try { worker = ReadIdentity(await ReadJson(Path.Combine(directory, CompleteName))); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or ApiException) { }
            }
            if (worker != null && !Running(worker))
            {
                CleanTree(directory);
                if (!Directory.Exists(directory)) return;
            }
            await Task.Delay(250);
        }
    }

    public async Task<JsonNode> Handle(string method, JsonNode body)
    {
        if (method == "update-progress") return progress.DeepClone();
        if (method == "update-available") return await Mode();
        if (method == "update-ready") return await MarkReady();
        if (!await gate.WaitAsync(0))
        {
            if (method == "update-source") throw new ApiException("无法切换更新来源。");
            return Failure("已有更新正在处理。");
        }
        try
        {
            if (method == "update-source") return await SetSource(body);
            return method switch
            {
                "update-begin" => await Begin(),
                "update-choice" => await Choose(DemandPending(body), body.S("path")),
                "update-stage" => await Prepare(DemandPending(body)),
                "update-launch" => await Launch(DemandPending(body), body),
                "update-cancel" when pending?.Token == body.S("token") =>
                    body.B("saveFailed") ? Finish("error", ClosingMessage) : Finish("cancelled"),
                "update-cancel" => Status("cancelled"),
                _ => Failure("更新操作无效。")
            };
        }
        catch (Exception e) when (method != "update-source" && (method == "update-begin" || pending?.Token == body.S("token")))
        {
            return Finish("error", e is ApiException ? e.Message : ReadWriteMessage);
        }
        finally { gate.Release(); }
    }

    public void Stop() => stopping.Cancel();

    public async Task Drain()
    {
        await gate.WaitAsync();
        try { ClearPending(); }
        finally { gate.Release(); }
    }

    public static async Task<int?> TryRunCli(string[] args)
    {
        if (args.Length == 0 || args[0] is not ("--pack-update" or "--apply-update")) return null;
        try
        {
            if (args[0] == "--apply-update")
            {
                Require(args.Length == 2, "更新应用参数无效。");
                return await Apply(args[1]) ? 0 : 1;
            }
            Require(args.Length == 4, "用法：--pack-update <Windows 目录版> <发布目录> <Electron 版本>");
            await Pack(args[1], args[2], args[3]);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error is ApiException ? error.Message : ReadWriteMessage);
            return 1;
        }
    }
}
