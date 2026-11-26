using System.Diagnostics;
using System.Text.Json.Nodes;
using static Hive.J;

namespace Hive;

public sealed partial class Updates
{
    static bool Running(ProcessIdentity identity)
    {
        try
        {
            using var process = Process.GetProcessById(identity.Pid);
            return !process.HasExited && Identity(process) == identity;
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    static async Task<bool> WaitForExit(ProcessIdentity identity, TimeSpan duration)
    {
        var started = Stopwatch.GetTimestamp();
        while (Running(identity) && Stopwatch.GetElapsedTime(started) < duration) await Task.Delay(100);
        return !Running(identity);
    }

    static async Task MoveRetry(Action move)
    {
        for (var attempt = 0; ; attempt++)
        {
            try { move(); return; }
            catch (Exception error) when (attempt < 24 && error is IOException or UnauthorizedAccessException)
            {
                await Task.Delay(200);
            }
        }
    }

    static Process StartApp(string exe, string[] args, string token, bool restoring)
    {
        var start = new ProcessStartInfo(exe)
        {
            WorkingDirectory = Path.GetDirectoryName(exe)!,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        foreach (var key in new[] { "ELECTRON_RUN_AS_NODE", "HIVE_UPDATE_STARTUP", "HIVE_UPDATE_RESTORED", "HIVE_UPDATE_CLEANUP",
            "HIVE_UPDATE_APP_EXE", "HIVE_UPDATE_PARENT_PID", "HIVE_UPDATE_ELECTRON", "HIVE_UPDATE_PACKAGED",
            "HIVE_PIPE", "HIVE_DESKTOP_SHELL", "HIVE_PORT" }) start.Environment.Remove(key);
        start.Environment["HIVE_UPDATE_CLEANUP"] = token;
        if (restoring) start.Environment["HIVE_UPDATE_RESTORED"] = "1";
        else start.Environment["HIVE_UPDATE_STARTUP"] = token;
        return Process.Start(start) ?? throw new ApiException("无法重新启动 HIVE。");
    }

    static async Task<bool> IsReady(string staged, string token, BuildRecord expected)
    {
        try
        {
            var ready = await ReadJson(Path.Combine(staged, ReadyName));
            return ready.S("token") == token && ParseBuild(ready["build"], "更新启动记录无效。") == expected;
        }
        catch (FileNotFoundException) { return false; }
        catch (IOException) { return false; }
        catch (ApiException) { return false; }
    }

    static async Task StopApp(Process? app)
    {
        if (app == null || app.HasExited) return;
        try { app.Kill(entireProcessTree: true); }
        catch (InvalidOperationException) { return; }
        await app.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
    }

    static async Task UpdateError(string resources, string phase, Exception error, int? exitCode)
    {
        var code = error is ApiException ? "HIVE_UPDATE" : error.GetType().Name;
        try { await Write(Path.Combine(resources, "hive-update-last-error.json"), N(new { phase, code, exitCode })); }
        catch (Exception writeError) when (writeError is IOException or UnauthorizedAccessException or ApiException) { }
    }

    static async Task<bool> Apply(string staged)
    {
        staged = Path.GetFullPath(staged);
        Plain(staged);
        var plan = await ReadJson(Path.Combine(staged, PlanName));
        var token = plan.S("token");
        var exe = plan.S("executable");
        var arch = plan.S("arch");
        Require(ValidToken(token) && Path.IsPathFullyQualified(exe) && arch is "x64" or "arm64" or "ia32", "更新启动记录无效。");
        var resources = Path.Combine(Path.GetDirectoryName(exe)!, "resources");
        var worker = Path.Combine(staged, "worker", BackendExe);
        Require(string.Equals(staged, Path.Combine(resources, StagePrefix + token), StringComparison.OrdinalIgnoreCase) &&
            string.Equals(Environment.ProcessPath, worker, StringComparison.OrdinalIgnoreCase), "更新启动记录无效。");
        Plain(resources);
        Plain(exe);
        var parent = ReadIdentity(plan["parent"]);
        var owner = ReadIdentity(plan["owner"]);
        var before = ParseBuild(plan["before"], "更新启动记录无效。");
        var expected = ParseBuild(plan["next"], "更新启动记录无效。");
        var args = ReadArguments(plan);
        Require(Newer(before, expected), "更新启动记录无效。");

        var payload = Path.Combine(staged, "payload");
        var backup = Path.Combine(staged, "previous");
        var archive = Path.Combine(resources, ArchiveName);
        var backend = Path.Combine(resources, BackendName);
        var oldArchive = Path.Combine(backup, ArchiveName);
        var oldBackend = Path.Combine(backup, BackendName);
        var nextArchive = Path.Combine(payload, ArchiveName);
        var nextBackend = Path.Combine(payload, BackendName);
        var oldArchiveMoved = false;
        var oldBackendMoved = false;
        var nextArchiveMoved = false;
        var nextBackendMoved = false;
        var canClean = false;
        var phase = "waiting";
        Process? candidate = null;

        try
        {
            if (!await WaitForExit(parent, TimeSpan.FromSeconds(35)))
            {
                await UpdateError(resources, phase, new ApiException("HIVE 尚未退出。"), null);
                canClean = true;
                return false;
            }
            if (!await WaitForExit(owner, TimeSpan.FromSeconds(10)))
                throw new ApiException("原后端尚未停止。");

            phase = "verify";
            Require(await ReadPayloadBuild(resources, arch) == before && await ReadPayloadBuild(payload, arch) == expected,
                "应用的构建在更新期间发生变化，请重新检查。");
            phase = "backup";
            FileSystemIdentity.NewDirectory(backup);
            await MoveRetry(() => File.Move(archive, oldArchive));
            oldArchiveMoved = true;
            await MoveRetry(() => Directory.Move(backend, oldBackend));
            oldBackendMoved = true;

            phase = "replace";
            await MoveRetry(() => File.Move(nextArchive, archive));
            nextArchiveMoved = true;
            await MoveRetry(() => Directory.Move(nextBackend, backend));
            nextBackendMoved = true;

            phase = "restart";
            candidate = StartApp(exe, args, token, restoring: false);
            var launched = Stopwatch.GetTimestamp();
            while (Stopwatch.GetElapsedTime(launched) < TimeSpan.FromSeconds(45))
            {
                if (await IsReady(staged, token, expected))
                {
                    canClean = true;
                    return true;
                }
                if (candidate.HasExited) break;
                await Task.Delay(150);
            }
            throw new ApiException("更新后的 HIVE 未能启动。");
        }
        catch (Exception error)
        {
            await UpdateError(resources, phase, error, candidate is { HasExited: true } ? candidate.ExitCode : null);
            try
            {
                await StopApp(candidate);
                if (nextBackendMoved) await MoveRetry(() => Directory.Move(backend, nextBackend));
                if (nextArchiveMoved) await MoveRetry(() => File.Move(archive, nextArchive));
                if (oldBackendMoved) await MoveRetry(() => Directory.Move(oldBackend, backend));
                if (oldArchiveMoved) await MoveRetry(() => File.Move(oldArchive, archive));
                if (oldBackendMoved || oldArchiveMoved)
                    Require(await ReadPayloadBuild(resources, arch) == before, "恢复后的构建记录无效。");
                using var restored = StartApp(exe, args, token, restoring: true);
                canClean = true;
            }
            catch (Exception restoreError)
            {
                await UpdateError(resources, "restore", restoreError, null);
            }
            return false;
        }
        finally
        {
            candidate?.Dispose();
            if (canClean)
            {
                using var self = Process.GetCurrentProcess();
                try { await Write(Path.Combine(staged, CompleteName), Identity(self).AsJson()); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or ApiException) { }
            }
        }
    }
}
