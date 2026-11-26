using System.Buffers.Binary;
using System.Globalization;
using System.IO.Compression;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Hive.J;

namespace Hive;

public sealed partial class Updates
{
    const string AppId = "local.hive.writing";
    const string Product = "HIVE markdown editor";
    const string PackageName = "hive-writing-prototype";
    const string PackageEntry = "desktop/main.mjs";
    const string ArchiveName = "app.asar";
    const string BackendName = "backend";
    const string BackendExe = "Hive.Backend.exe";
    const string ManifestName = "update.hive.json";
    const string BundleName = "hive-update.zip";
    const string BuildPath = "dist/build-info.json";
    const string FormatMessage = "请选择 HIVE 生成的有效更新清单。";
    const string FullPackage = "这个更新包未包含配套的 C# 后端，请使用完整的 Windows 程序包。";
    const int JsonLimit = 64 * 1024;
    const long MaxSize = 1024L * 1024 * 1024;
    const int EntryLimit = 10000;
    static readonly Regex VersionPattern = new(@"\A(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-r(\d{1,9}))?\z", RegexOptions.CultureInvariant);
    static readonly Regex BuildNumberPattern = new(@"\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z", RegexOptions.CultureInvariant);
    static readonly Regex DigestPattern = new(@"\A[a-f0-9]{64}\z", RegexOptions.CultureInvariant);
    static readonly string[] BuildChannels = ["development", "local", "alpha", "beta", "stable"];

    sealed record BuildRecord(string Version, string BuildNumber, string BuildTime, string Channel)
    {
        public JsonNode AsJson() => N(new { appName = Product, version = Version, buildNumber = BuildNumber, buildTime = BuildTime, channel = Channel });
    }
    sealed record Manifest(BuildRecord Build, long Bytes, string Digest)
    {
        public JsonNode AsJson(string electron, string arch) => N(new
        {
            format = 2, appId = AppId, platform = "win32", arch, electron, bytes = Bytes, sha256 = Digest, build = Build.AsJson()
        });
    }

    static JsonObject ObjectOrFail(JsonNode? node, string message) => node as JsonObject ?? throw new ApiException(message);
    static JsonObject ParseObject(ReadOnlySpan<byte> data, string message)
    {
        if (data.StartsWith(new byte[] { 0xef, 0xbb, 0xbf })) data = data[3..];
        try { return ObjectOrFail(JsonNode.Parse(data), message); }
        catch (JsonException) { throw new ApiException(message); }
    }
    static FileStream OpenPlain(string path)
    {
        if (!File.Exists(path)) throw new FileNotFoundException();
        Plain(path);
        return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous);
    }
    static async Task<JsonObject> ReadJson(string path, string message = FormatMessage)
    {
        await using var source = OpenPlain(path);
        Require(source.Length is > 0 and <= JsonLimit, message);
        var bytes = new byte[(int)source.Length];
        await source.ReadExactlyAsync(bytes);
        return ParseObject(bytes, message);
    }
    static BuildRecord ParseBuild(JsonNode? node, string message, string? version = null)
    {
        var build = ObjectOrFail(node, message);
        var value = new BuildRecord(build.S("version"), build.S("buildNumber"), build.S("buildTime"), build.S("channel"));
        Require(build.S("appName") == Product && VersionPattern.IsMatch(value.Version) && (version == null || value.Version == version)
            && BuildNumberPattern.IsMatch(value.BuildNumber) && BuildChannels.Contains(value.Channel)
            && DateTimeOffset.TryParseExact(value.BuildTime, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal, out _), message);
        return value;
    }
    static bool Newer(BuildRecord old, BuildRecord next)
    {
        if (old.Version == next.Version)
            return next.BuildNumber != old.BuildNumber && string.CompareOrdinal(next.BuildTime, old.BuildTime) > 0;
        static int[] Parts(string version) => VersionPattern.Match(version).Groups.Cast<Group>().Skip(1)
            .Select(group => group.Success ? int.Parse(group.Value, CultureInfo.InvariantCulture) : int.MaxValue).ToArray();
        var from = Parts(old.Version);
        var to = Parts(next.Version);
        for (var i = 0; i < from.Length; i++)
            if (from[i] != to[i]) return to[i] > from[i];
        return false;
    }

    static Manifest ParseManifest(JsonObject json, string electron, string arch)
    {
        if (json.I("format") == 1 && json.S("appId") == AppId) throw new ApiException(FullPackage);
        var bytes = json["bytes"] is JsonValue v && v.TryGetValue<long>(out var count) ? count : 0;
        var digest = json.S("sha256");
        Require(json.I("format") == 2 && json.S("appId") == AppId && bytes is > 0 and <= MaxSize && DigestPattern.IsMatch(digest), FormatMessage);
        Require(json.S("electron") == electron && json.S("platform") == "win32" && json.S("arch") == arch,
            "这个更新包需要不同的 Windows 运行时或架构，请使用对应的完整程序包。");
        return new(ParseBuild(json["build"], "更新包的构建记录无效。"), bytes, digest);
    }

    sealed class AsarReader : IDisposable
    {
        const string Invalid = "更新包的 ASAR 文件无效。";
        readonly FileStream stream;
        readonly JsonObject header;
        readonly long start;

        public AsarReader(string file)
        {
            stream = OpenPlain(file);
            try
            {
                Require(stream.Length is > 16 and <= MaxSize, Invalid);
                Span<byte> sizes = stackalloc byte[8];
                stream.ReadExactly(sizes);
                var headerSize = BinaryPrimitives.ReadInt32LittleEndian(sizes[4..]);
                Require(BinaryPrimitives.ReadInt32LittleEndian(sizes) == 4 && headerSize is >= 8 and <= 32 * 1024 * 1024 && headerSize <= stream.Length - 8, Invalid);
                var data = new byte[headerSize];
                stream.ReadExactly(data);
                var payloadSize = BinaryPrimitives.ReadInt32LittleEndian(data);
                var jsonSize = BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(4));
                Require(payloadSize == data.Length - 4 && jsonSize > 0 && jsonSize <= payloadSize - 4, Invalid);
                header = ParseObject(data.AsSpan(8, jsonSize), Invalid);
                start = stream.Position;
            }
            catch
            {
                stream.Dispose();
                throw;
            }
        }

        JsonObject Find(string path)
        {
            var entry = header;
            foreach (var part in path.Split('/'))
            {
                var entries = ObjectOrFail(entry["files"], Invalid);
                entry = ObjectOrFail(entries[part], Invalid);
                Require(!entry.B("unpacked") && entry["link"] == null, Invalid);
            }
            return entry;
        }

        public JsonObject Json(string path)
        {
            var entry = Find(path);
            var size = entry.I("size");
            Require(size is > 0 and <= JsonLimit && long.TryParse(entry.S("offset"), NumberStyles.None, CultureInfo.InvariantCulture, out _), Invalid);
            var offset = long.Parse(entry.S("offset"), CultureInfo.InvariantCulture);
            Require(offset >= 0 && offset <= stream.Length - start - size, Invalid);
            stream.Position = start + offset;
            var data = new byte[size];
            stream.ReadExactly(data);
            return ParseObject(data, Invalid);
        }
        public void Dispose() => stream.Dispose();
    }

    static BuildRecord ReadArchiveBuild(string file)
    {
        using var archive = new AsarReader(file);
        var package = archive.Json("package.json");
        Require(package.S("name") == PackageName && package.S("main") == PackageEntry, "更新包的应用标识或构建记录不匹配。");
        return ParseBuild(archive.Json(BuildPath), "更新包的应用标识或构建记录不匹配。", package.S("version"));
    }

    static string PeArchitecture(string path)
    {
        using var file = OpenPlain(path);
        using var pe = new PEReader(file);
        return pe.PEHeaders.CoffHeader.Machine switch
        {
            Machine.Amd64 => "x64",
            Machine.Arm64 => "arm64",
            Machine.I386 => "ia32",
            _ => throw new ApiException("这个更新包需要不同的 Windows 运行时或架构，请使用对应的完整程序包。")
        };
    }

    static async Task<BuildRecord> ReadPayloadBuild(string resources, string arch)
    {
        Plain(resources);
        Require(!Exists(Path.Combine(resources, ArchiveName + ".unpacked")), "这个程序包包含 ASAR 外的应用文件，需要发布完整程序包。");
        var archive = ReadArchiveBuild(Path.Combine(resources, ArchiveName));
        var backend = Path.Combine(resources, BackendName);
        Require(Directory.Exists(backend), FullPackage);
        Plain(backend);
        var backendApp = Path.Combine(backend, "app");
        var executable = Path.Combine(backend, BackendExe);
        Require(File.Exists(executable) && Directory.Exists(backendApp), FullPackage);
        Plain(backendApp);
        foreach (var relative in new[] { "dist/index.html", "desktop/docking-colors.json", "desktop/editor-colors.json", "shared/icons.json" })
        {
            var file = Path.Combine(backendApp, relative);
            Require(File.Exists(file), FullPackage);
            Plain(Path.GetDirectoryName(file)!);
            Plain(file);
        }
        Require(PeArchitecture(executable) == arch, "这个更新包需要不同的 Windows 运行时或架构，请使用对应的完整程序包。");
        var build = ParseBuild(await ReadJson(Path.Combine(backendApp, BuildPath), FullPackage), FullPackage);
        Require(archive == build, "更新包中的前端与 C# 后端构建记录不一致。");
        return archive;
    }

    static IEnumerable<(string Full, string Relative)> PlainFiles(string directory)
    {
        Plain(directory);
        var pending = new Stack<string>();
        pending.Push(directory);
        while (pending.TryPop(out var current))
            foreach (var path in Directory.EnumerateFileSystemEntries(current))
            {
                Plain(path);
                if (Directory.Exists(path)) pending.Push(path);
                else yield return (path, Posix(Path.GetRelativePath(directory, path)));
            }
    }

    static bool ValidPart(string part)
    {
        if (part.Length == 0 || part is "." or ".." || part.EndsWith('.') || part.EndsWith(' ') ||
            part.IndexOfAny(['\\', ':', '*', '?', '"', '<', '>', '|', '\0']) >= 0 || part.Any(char.IsControl)) return false;
        return !Regex.IsMatch(part, @"\A(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|\z)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }

    static async Task CopySized(Stream input, Stream output, long expected, string error, CancellationToken cancel = default, Action<long>? progress = null)
    {
        var buffer = new byte[65536];
        long received = 0;
        int count;
        while ((count = await input.ReadAsync(buffer, cancel)) > 0)
        {
            received += count;
            Require(received <= expected, error);
            await output.WriteAsync(buffer.AsMemory(0, count), cancel);
            progress?.Invoke(received);
        }
        Require(received == expected, error);
        await output.FlushAsync(cancel);
    }

    static FileStream NewFile(string path) => new(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.Asynchronous);

    static async Task<string> FileDigest(string file, CancellationToken cancel = default)
    {
        await using var stream = OpenPlain(file);
        return Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, cancel));
    }

    static async Task Extract(string zip, string directory, Manifest manifest, string arch, CancellationToken cancel)
    {
        const string broken = "更新文件校验失败，请重新取得更新包。";
        await using var input = OpenPlain(zip);
        Require(input.Length == manifest.Bytes, "更新文件缺失或大小不符，请重新取得完整的更新包。");
        Require(Convert.ToHexStringLower(await SHA256.HashDataAsync(input, cancel)) == manifest.Digest, broken);
        input.Position = 0;
        using var bundle = new ZipArchive(input, ZipArchiveMode.Read);
        var entries = bundle.Entries;
        Require(entries.Count is > 1 and <= EntryLimit, broken);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var folders = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        foreach (var entry in entries)
        {
            var name = entry.FullName;
            var parts = name.Split('/');
            var unixType = (entry.ExternalAttributes >> 16) & 0xf000;
            Require((name == ArchiveName || parts.Length > 1 && parts[0] == BackendName) && name.Length <= 1024 &&
                parts.All(ValidPart) && unixType is 0 or 0x8000 &&
                (entry.ExternalAttributes & (int)(FileAttributes.ReparsePoint | FileAttributes.Directory)) == 0 && seen.Add(name), broken);
            total = checked(total + entry.Length);
            Require(total <= MaxSize && entry.Length >= 0, broken);
            for (var i = 1; i < parts.Length; i++) folders.Add(string.Join('/', parts.Take(i)));
        }
        Require(!seen.Overlaps(folders) && seen.Contains(ArchiveName) && seen.Contains(BackendName + "/" + BackendExe), FullPackage);
        FileSystemIdentity.NewDirectory(directory);
        foreach (var entry in entries)
        {
            var target = Path.Combine(directory, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            await using var output = NewFile(target);
            await using var body = entry.Open();
            await CopySized(body, output, entry.Length, broken, cancel);
            output.Flush(true);
        }
        Require(await ReadPayloadBuild(directory, arch) == manifest.Build, "下载的更新包与清单的构建记录不匹配。");
    }

    static async Task<Manifest> WriteBundle(string resources, string destination, BuildRecord build)
    {
        await using (var stream = NewFile(destination))
        using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            long total = 0;
            int count = 0;
            var files = PlainFiles(Path.Combine(resources, BackendName)).Select(x => (x.Full, Relative: BackendName + "/" + x.Relative));
            foreach (var (path, name) in files.Prepend((Path.Combine(resources, ArchiveName), ArchiveName)))
            {
                await using var input = OpenPlain(path);
                total = checked(total + input.Length);
                Require(++count <= EntryLimit && total <= MaxSize && name.Split('/').All(ValidPart), "程序包超过更新包限制，请使用完整程序包。");
                var entry = zip.CreateEntry(name, CompressionLevel.Fastest);
                await using var output = entry.Open();
                await CopySized(input, output, input.Length, "程序文件在打包期间已变化。");
            }
        }
        var bytes = new FileInfo(destination).Length;
        Require(bytes is > 0 and <= MaxSize, "程序包超过更新包限制，请使用完整程序包。");
        return new(build, bytes, await FileDigest(destination));
    }

    static async Task Pack(string install, string destination, string electron)
    {
        Require(OperatingSystem.IsWindows() && Regex.IsMatch(electron, @"\A\d{1,9}\.\d{1,9}\.\d{1,9}\z"), "Windows 更新包运行时无效。");
        install = Path.GetFullPath(install);
        destination = Path.GetFullPath(destination);
        Plain(install);
        var arch = PeArchitecture(Path.Combine(install, Product + ".exe"));
        var resources = Path.Combine(install, "resources");
        var build = await ReadPayloadBuild(resources, arch);
        Directory.CreateDirectory(destination);
        Plain(destination);
        var latest = Path.Combine(destination, "latest");
        var mutex = Path.Combine(destination, ".publish-lock");
        FileSystemIdentity.NewDirectory(mutex);
        var staged = Path.Combine(destination, ".publish-" + Id());
        var previous = Path.Combine(destination, ".previous-" + Id());
        var priorMoved = false;
        var published = false;
        try
        {
            if (Exists(latest))
            {
                Plain(latest);
                Require(Directory.Exists(latest), "latest 目录包含其他内容，请检查发布目录。");
                var files = Directory.EnumerateFileSystemEntries(latest).Select(Path.GetFileName).ToHashSet(StringComparer.Ordinal);
                Require(files.SetEquals([ArchiveName, ManifestName]) || files.SetEquals([BundleName, ManifestName]),
                    "latest 目录包含其他内容，请检查发布目录。");
                foreach (var file in files) Plain(Path.Combine(latest, file!));
                var priorBuild = files.Contains(ArchiveName) ? ReadArchiveBuild(Path.Combine(latest, ArchiveName))
                    : ParseBuild((await ReadJson(Path.Combine(latest, ManifestName)))["build"], "已有发布包的构建记录无效。");
                Require(Newer(priorBuild, build), "发布目录已有相同或较新的构建。");
            }
            FileSystemIdentity.NewDirectory(staged);
            var next = await WriteBundle(resources, Path.Combine(staged, BundleName), build);
            await Write(Path.Combine(staged, ManifestName), next.AsJson(electron, arch));
            if (Directory.Exists(latest))
            {
                Directory.Move(latest, previous);
                priorMoved = true;
            }
            Directory.Move(staged, latest);
            published = true;
            Console.WriteLine($"{build.Version} {build.BuildNumber} {latest}");
        }
        catch
        {
            if (priorMoved && !published) Directory.Move(previous, latest);
            throw;
        }
        finally
        {
            CleanTree(staged);
            if (published && priorMoved) CleanTree(previous);
            Directory.Delete(mutex);
        }
    }
}
