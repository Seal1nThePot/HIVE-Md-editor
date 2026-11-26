using System.Text.Json.Nodes;
using static Hive.J;

namespace Hive;

sealed class FileTimes(string state)
{
    const int MaxCacheBytes = 16 * 1024 * 1024;
    string Target => Path.Combine(state, "file-times.json");
    readonly object publication = new();
    sealed record Signature(uint Device, ulong Index, double Creation, long Length, long Modified);
    sealed record Record(Signature Signature, JsonObject Data);
    Record? current;
    bool active;

    public void Active(bool value)
    {
        lock (publication)
        {
            active = value;
            current = null;
        }
    }
    public void Clear()
    {
        lock (publication) current = null;
    }
    static Signature? Inspect(string path)
    {
        if (!Exists(path)) return null;
        var info = new FileInfo(path);
        Require((info.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0, "创建时间状态文件不可用。", 500);
        var native = FileSystemIdentity.Stat(path);
        return new(native.Device, native.Index, native.Birth, info.Length, info.LastWriteTimeUtc.Ticks);
    }
    void Cache(Signature? signature, JsonObject values)
    {
        lock (publication)
        {
            current = active && signature is { Length: <= MaxCacheBytes } ? new(signature, values) : null;
        }
    }
    public async Task<JsonObject> Read()
    {
        try
        {
            var target = Target;
            var before = Inspect(target);
            lock (publication)
            {
                if (current is { } record && record.Signature == before) return record.Data;
                current = null;
            }
            if (before == null) return new JsonObject();
            var data = await ReadObject(target, "创建时间状态");
            Require(Inspect(target) == before, "创建时间状态文件在读取期间变化，请重试。", 500);
            Cache(before, data);
            return data;
        }
        catch
        {
            Clear();
            throw;
        }
    }
    public async Task Save(JsonObject values)
    {
        try
        {
            var target = Target;
            Inspect(target);
            await Write(target, values);
            Cache(Inspect(target), values);
        }
        catch
        {
            Clear();
            throw;
        }
    }
}
