using System.Text;
using System.Text.Json.Nodes;
using System.Globalization;
using System.Collections.Concurrent;
using System.Text.Json;
using System.Security.Cryptography;
using static Hive.J;

namespace Hive;

public sealed class Files : IDisposable
{
    public const int MaxBytes = 2_000_000;
    public string Root { get; }
    public string State { get; }
    readonly FileTimes fileTimes;
    readonly SemaphoreSlim gate = new(1);
    readonly FileSystemWatcher watcher;
    sealed record ProbeResult(long Length, DateTime Modified, DateTime Creation, DateTime Checked, string Hash);
    readonly ConcurrentDictionary<string, ProbeResult> probes = new(StringComparer.Ordinal);
    volatile bool active;
    volatile bool sourceCheckout;
    readonly object publication = new();
    long dirty = 1, scanned;
    JsonArray? cached;
    string version = "";
    DateTime lastScan;
    public Files(string root, string state)
    {
        Root = root;
        State = state;
        fileTimes = new(state);
        watcher = new(root) { IncludeSubdirectories = true, NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size };
        watcher.Changed += (_, e) => OnChange(e.Name);
        watcher.Created += (_, e) => OnChange(e.Name);
        watcher.Deleted += (_, e) => OnChange(e.Name);
        watcher.Renamed += (_, e) => { OnChange(e.OldName); OnChange(e.Name); };
        watcher.Error += (_, _) => Invalidate();
    }
    public void Active(bool active)
    {
        lock (publication)
        {
            this.active = active;
            if (!active) cached = null;
            probes.Clear();
        }
        fileTimes.Active(active);
        try { watcher.EnableRaisingEvents = active; }
        catch (IOException) { }
        Invalidate();
    }
    public void Dispose() { watcher.Dispose(); gate.Dispose(); }
    public void Invalidate() => Interlocked.Increment(ref dirty);
    bool Ignored(string relative)
    {
        var lower = Posix(relative).ToLowerInvariant();
        if (lower.Split('/').Any(p => p.StartsWith('.') || p == "node_modules")) return true;
        return sourceCheckout && new[] { "delivery", "release", "dist", "performance/baselines" }.Any(p => lower == p || lower.StartsWith(p + "/", StringComparison.Ordinal));
    }
    void OnChange(string? relative)
    {
        if (relative == null || !Ignored(relative)) Invalidate();
    }
    public string Resolve(string relative, bool directory = false)
    {
        Require(!string.IsNullOrWhiteSpace(relative) && !Path.IsPathRooted(relative) && !relative.Split(['/', '\\']).Any(p => p.Length == 0 || p.StartsWith('.') || p.IndexOfAny(":*?\"<>|\0".ToCharArray()) >= 0), "文件名称无效。");
        Require(directory || relative.EndsWith(".md", StringComparison.OrdinalIgnoreCase), "原型只处理 .md 文件。");
        var target = Path.GetFullPath(Path.Combine(Root, relative));
        var local = Path.GetRelativePath(Root, target);
        Require(local is not "." and not ".." && !Path.IsPathRooted(local) && !local.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal), "文件必须位于工作空间内。");
        var current = Root; Plain(current);
        foreach (var part in local.Split(Path.DirectorySeparatorChar))
        {
            current = Path.Combine(current, part);
            if (Exists(current)) Require((File.GetAttributes(current) & FileAttributes.ReparsePoint) == 0, "原型不跟随符号链接或目录联接。");
        }
        return target;
    }
    public static async Task<JsonNode> ReadDocument(string relative, string target, string? known = null)
    {
        var raw = await ReadRaw(target);
        var hash = Hash(raw);
        if (known == hash) return N(new { path = relative, hash, unchanged = true });
        return N(new { path = relative, text = Normalize(raw), hash, eol = raw.Contains("\r\n") ? "CRLF" : "LF", bom = raw.StartsWith('\uFEFF') });
    }
    public Task<JsonNode> Read(string relative, string? known = null) => ReadDocument(relative, Resolve(relative), known);

    public async Task<JsonNode> Probe(string relative, string known)
    {
        var path = Resolve(relative);
        var info = new FileInfo(path);
        var length = info.Length;
        var modified = info.LastWriteTimeUtc;
        var creation = info.CreationTimeUtc;
        if (probes.TryGetValue(relative, out var prior) && prior.Hash == known && prior.Length == length &&
            prior.Modified == modified && prior.Creation == creation && DateTime.UtcNow - prior.Checked < TimeSpan.FromSeconds(30))
            return N(new { path = relative, hash = prior.Hash, unchanged = true });
        var stamp = Interlocked.Read(ref dirty);
        var result = await ReadDocument(relative, path, known);
        info.Refresh();
        if (Interlocked.Read(ref dirty) == stamp && info.Exists && info.Length == length && info.LastWriteTimeUtc == modified && info.CreationTimeUtc == creation)
        {
            lock (publication)
            {
                if (active && Interlocked.Read(ref dirty) == stamp)
                {
                    if (probes.Count >= 100) probes.Clear();
                    probes[relative] = new(length, modified, creation, DateTime.UtcNow, result.S("hash"));
                }
            }
        }
        return result;
    }

    static async Task<string> ReadRaw(string target)
    {
        await using var file = new FileStream(target, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 65536, FileOptions.Asynchronous);
        Require(file.Length <= MaxBytes, "原型支持 2 MB 以内的 Markdown 文件。");
        using var bytes = new MemoryStream((int)file.Length);
        var buffer = new byte[65536];
        while (await file.ReadAsync(buffer) is var length && length > 0)
        {
            Require(bytes.Length + length <= MaxBytes, "原型支持 2 MB 以内的 Markdown 文件。");
            bytes.Write(buffer, 0, length);
        }
        return Encoding.UTF8.GetString(bytes.GetBuffer(), 0, (int)bytes.Length);
    }
    static async Task<string?> ReadPresent(string path)
    {
        try { return await ReadRaw(path); }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
    }
    public async Task<T> Transaction<T>(Func<Task<T>> work)
    {
        await gate.WaitAsync();
        try { return await work(); }
        catch { fileTimes.Clear(); throw; }
        finally { probes.Clear(); Invalidate(); gate.Release(); }
    }
    public async Task<JsonNode> Save(JsonNode b)
    {
        var relative = b.S("path");
        var target = Resolve(relative);
        return await Transaction(() => SaveDocument(b, relative, target, fileTimes, () => Resolve(relative)));
    }
    internal static async Task<JsonNode> SaveDocument(JsonNode b, string relative, string target, FileTimes? records, Action checkPath)
    {
        Require(b["text"].IsString() && Encoding.UTF8.GetByteCount(b.S("text")) <= MaxBytes, "文件内容无效或超过 2 MB。");
        checkPath();
        var old = await ReadPresent(target);
        Require(old == null ? b["baseline"] == null : Hash(old) == b.S("baseline"), "磁盘文件已变化，已阻止覆盖。请另存，或重新打开后核对。", 409);
        var times = records == null ? null : await records.Read();
        var created = old != null && times != null ? Observe(times, relative, target) : (double?)null;
        var raw = (b.B("bom") ? "\uFEFF" : "") + (b.S("eol") == "CRLF" ? System.Text.RegularExpressions.Regex.Replace(b.S("text"), "\\r?\\n", "\r\n") : b.S("text"));
        var bytes = Encoding.UTF8.GetBytes(raw);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        var temp = Path.Combine(Path.GetDirectoryName(target)!, "." + Path.GetFileName(target) + "." + Id() + ".tmp");
        try
        {
            await using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                await stream.WriteAsync(bytes);
                stream.Flush(true);
            }
            checkPath();
            Require(await ReadPresent(target) == old, "保存期间磁盘文件发生变化，已阻止覆盖。", 409);
            if (old == null) FileSystemIdentity.Link(temp, target);
            else File.Move(temp, target, true);
        }
        finally { File.Delete(temp); }
        var result = N(new { path = relative, hash = Hash(bytes) });
        if (times != null && records != null)
        {
            try { Observe(times, relative, target, created); await records.Save(times); }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or ApiException)
            {
                records.Clear();
                result["warning"] = "正文已保存，但未能更新文件时间记录。";
            }
        }
        return result;
    }
    public Task<JsonNode> Rename(JsonNode b, Metadata metadata) => Transaction(async () =>
    {
        var from = b.S("from");
        var to = b.S("to");
        var source = Resolve(from);
        var dest = Resolve(to);
        var original = await ReadRaw(source);
        Require(Hash(original) == b.S("baseline"), "磁盘文件已变化，请重新打开后整理。", 409);
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        Resolve(from);
        Resolve(to);
        Require(await ReadRaw(source) == original, "磁盘文件已变化，请重新打开后整理。", 409);
        FileSystemIdentity.Link(source, dest);
        var deletedSource = false;
        try
        {
            Require(await ReadRaw(source) == original, "磁盘文件已变化，请重新打开后整理。", 409);
            File.Delete(source);
            deletedSource = true;
            await metadata.Remap(Posix(from), Posix(to));
        }
        catch
        {
            if (deletedSource) FileSystemIdentity.Link(dest, source);
            File.Delete(dest);
            throw;
        }
        return await Read(to);
    });

    public async Task<JsonNode> Snapshot(bool force = false)
    {
        await gate.WaitAsync();
        try
        {
            var previous = cached;
            if (!force && previous != null && scanned == Interlocked.Read(ref dirty) && DateTime.UtcNow - lastScan < TimeSpan.FromSeconds(60)) return N(new { entries = previous, treeVersion = version });
            var stamp = Interlocked.Read(ref dirty);
            var times = await fileTimes.Read();
            var timesChanged = false;
            var count = 0;
            long chars = 0;
            sourceCheckout = await SourceCheckout();
            var compare = CultureInfo.GetCultureInfo("zh-CN").CompareInfo;
            JsonArray Scan(string dir, string prefix)
            {
                var items = new List<JsonNode>();
                foreach (var p in Directory.EnumerateFileSystemEntries(dir))
                {
                    var name = Path.GetFileName(p); var relative = prefix + name;
                    if (Ignored(relative)) continue;
                    FileAttributes attrs; try { attrs = File.GetAttributes(p); } catch (FileNotFoundException) { continue; } catch (DirectoryNotFoundException) { continue; }
                    if ((attrs & FileAttributes.ReparsePoint) != 0) continue;
                    var directory = (attrs & FileAttributes.Directory) != 0; if (!directory && !Document(name)) continue;
                    JsonNode item;
                    try
                    {
                        var createdAt = Observe(times, relative, p, null, out var changed);
                        timesChanged |= changed;
                        item = N(new { name, path = relative, type = directory ? "folder" : "file", modifiedAt = FileSystemIdentity.UnixMilliseconds(File.GetLastWriteTimeUtc(p).Ticks - DateTime.UnixEpoch.Ticks), createdAt });
                    }
                    catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException) { continue; }
                    if (directory) { try { item["children"] = Scan(p, relative + "/"); } catch (DirectoryNotFoundException) { continue; } }
                    items.Add(item); count++; chars += relative.Length + name.Length;
                }
                items.Sort((a, b) =>
                {
                    if (a.S("type") != b.S("type")) return a.S("type") == "folder" ? -1 : 1;
                    var c = compare.Compare(a.S("name"), b.S("name"), CompareOptions.None);
                    return c == 0 ? string.CompareOrdinal(a.S("name"), b.S("name")) : c;
                });
                return new JsonArray(items.ToArray());
            }
            var entries = Scan(Root, "");
            if (timesChanged) await fileTimes.Save(times);
            using var fingerprint = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            void Walk(JsonArray items)
            {
                foreach (var item in items.OfType<JsonObject>())
                {
                    var tuple = Array([item["path"], item["type"], item["modifiedAt"], item["createdAt"]]);
                    fingerprint.AppendData(Encoding.UTF8.GetBytes(tuple.ToJsonString(Options) + "\n"));
                    if (item["children"] is JsonArray children) Walk(children);
                }
            }
            Walk(entries);
            version = Convert.ToHexStringLower(fingerprint.GetHashAndReset());
            lock (publication) cached = active && count <= 25000 && chars <= 4_000_000 ? entries : null;
            scanned = stamp;
            lastScan = DateTime.UtcNow;
            return N(new { entries, treeVersion = version });
        }
        catch { fileTimes.Clear(); Invalidate(); throw; }
        finally { gate.Release(); }
    }
    public async Task<JsonArray> Flat(bool fresh = true)
    {
        var result = new JsonArray();
        void Walk(JsonArray entries) { foreach (var item in entries) { if (item.S("type") == "file") result.Add(item.Copy()); else Walk(item.A("children")); } }
        Walk((await Snapshot(fresh)).A("entries")); return result;
    }
    async Task<bool> SourceCheckout()
    {
        var manifest = Path.Combine(Root, "package.json");
        try
        {
            if (!File.Exists(manifest) || (File.GetAttributes(manifest) & FileAttributes.ReparsePoint) != 0 ||
                new FileInfo(manifest).Length > 64000) return false;
            var value = JsonNode.Parse(await File.ReadAllBytesAsync(manifest));
            return value.S("name") == "hive-writing-prototype" && value.S("main") == "desktop/main.mjs" &&
                new[] { "server/files.mjs", "desktop/main.mjs" }.All(relative =>
                {
                    var target = Path.Combine(Root, relative);
                    return File.Exists(target) && (File.GetAttributes(target) & FileAttributes.ReparsePoint) == 0;
                });
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException) { return false; }
    }
    public static double Observe(JsonObject records, string relative, string target, double? created = null) =>
        Observe(records, relative, target, created, out _);
    static double Observe(JsonObject records, string relative, string target, double? created, out bool changed)
    {
        var (dev, ino, birth) = FileSystemIdentity.Stat(target);
        var previous = records[relative] as JsonObject;
        static double? Number(JsonNode? n) => n is JsonValue v && double.TryParse(v.ToJsonString(Options), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) && double.IsFinite(d) ? d : null;
        var priorBirth = Number(previous?["birthtimeMs"]);
        var matching = priorBirth is double recorded && Math.Abs(recorded - birth) < 0.0005 &&
            (ino == 0 || Number(previous?["ino"]) == (double)ino && Number(previous?["dev"]) == dev);
        if (created == null && matching && Number(previous?["createdAt"]) is double recordedCreated)
        {
            changed = false;
            return recordedCreated;
        }
        changed = true;
        var value = created ?? birth;
        records[relative] = N(new { dev, ino, birthtimeMs = birth, createdAt = value });
        return value;
    }
}
