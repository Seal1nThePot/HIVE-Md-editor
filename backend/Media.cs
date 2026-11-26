using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Markdig;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using static Hive.J;

namespace Hive;

public sealed class Media(Repository repository)
{
    public const int MaxImageBytes = 12 * 1024 * 1024;
    const string ImportFolder = "导入的图片";
    static readonly CompareInfo Order = CultureInfo.GetCultureInfo("zh-CN").CompareInfo;
    static readonly MarkdownPipeline MarkdownSyntax = new MarkdownPipelineBuilder().UsePreciseSourceLocation().Build();

    public sealed record ImageData(string Extension, string Mime, byte[] Bytes);
    static ImageData ImageType(byte[] bytes)
    {
        Require(bytes.Length is > 0 and <= MaxImageBytes, "请选择 12 MB 以内的图片。");
        ReadOnlySpan<byte> span = bytes;
        if (span.StartsWith(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) return new(".png", "image/png", bytes);
        if (span.StartsWith(new byte[] { 255, 216, 255 })) return new(".jpg", "image/jpeg", bytes);
        if (span.StartsWith("GIF87a"u8) || span.StartsWith("GIF89a"u8)) return new(".gif", "image/gif", bytes);
        if (span.Length >= 12 && span.StartsWith("RIFF"u8) && span[8..12].SequenceEqual("WEBP"u8)) return new(".webp", "image/webp", bytes);
        throw new ApiException("支持 PNG、JPG、GIF 和 WebP 图片。");
    }
    public static string DecodeMarkdown(byte[] bytes)
    {
        Require(bytes.Length <= Files.MaxBytes, "Markdown 文件超过 2 MB。");
        try
        {
            var text = new UTF8Encoding(false, true).GetString(bytes);
            return text.StartsWith('\uFEFF') ? text[1..] : text;
        }
        catch (DecoderFallbackException) { throw new ApiException("Markdown 文件必须使用 UTF-8 编码。"); }
    }
    static (string Base, string Extension) SafeBase(string name, string fallback)
    {
        var leaf = Posix(name).TrimEnd('/').Split('/').Last();
        var ext = Path.GetExtension(leaf);
        if (ext == leaf) ext = "";
        var stem = Regex.Replace(leaf[..(leaf.Length - ext.Length)], "[<>:\"/\\\\|?*\\x00-\\x1f]", "").TrimStart('.').TrimEnd(' ', '.');
        if (stem.Length > 100) stem = stem[..100];
        if (stem.Length == 0 || Regex.IsMatch(stem, @"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)", RegexOptions.IgnoreCase)) stem = fallback;
        return (stem, ext.ToLowerInvariant());
    }
    async Task<string> Publish(string folder, string stem, string ext, byte[] bytes, string error)
    {
        var first = repository.Files.Resolve(Join(folder, stem + ext), true);
        var temp = Path.Combine(Path.GetDirectoryName(first)!, ".hive-import-" + Id() + ".tmp");
        try
        {
            await using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                await file.WriteAsync(bytes);
                file.Flush(true);
            }
            for (var index = 1; index <= 1000; index++)
            {
                var relative = Join(folder, stem + (index > 1 ? "-" + index : "") + ext);
                var dest = repository.Files.Resolve(relative, true);
                try { File.Move(temp, dest); return relative; }
                catch (IOException) when (Exists(dest)) { }
            }
            throw new ApiException(error, 409);
        }
        finally { File.Delete(temp); repository.Files.Invalidate(); }
    }
    public async Task<JsonNode> Import(string? name, string? parent, byte[] bytes)
    {
        Require(name?.Length is > 0 and <= 1000, "文件名称无效。");
        var (stem, ext) = SafeBase(name!, "导入文件");
        if (parent?.Length > 0)
        {
            var target = repository.Files.Resolve(parent, true);
            if (!Exists(target)) throw new DirectoryNotFoundException();
            Require(Directory.Exists(target), "目标必须是文件夹。");
        }
        var destination = parent ?? "";
        var kind = "markdown";
        if (ext == ".md") DecodeMarkdown(bytes);
        else if (ext is ".png" or ".jpg" or ".jpeg" or ".gif" or ".webp")
        {
            var image = ImageType(bytes);
            Require((ext == ".jpeg" ? ".jpg" : ext) == image.Extension, "图片扩展名与实际类型不符。");
            ext = image.Extension;
            destination = parent ?? ImportFolder;
            if (destination.Length > 0) Directory.CreateDirectory(repository.Files.Resolve(destination, true));
            kind = "image";
        }
        else throw new ApiException("仅支持 Markdown、PNG、JPG、GIF 和 WebP。");
        return N(new { path = await Publish(destination, stem, ext, bytes, "同名文件过多，请更换名称。"), kind });
    }
    public async Task<JsonNode> Insert(string document, string? name, byte[] bytes)
    {
        var image = ImageType(bytes);
        var doc = repository.Files.Resolve(document);
        await repository.Files.Read(document);
        Require(name != null && name.Length <= 1000, "图片名称无效。");
        var (stem, _) = SafeBase(name!, "图片");
        var relativeDoc = Posix(Path.GetRelativePath(repository.Root, doc));
        var folder = Join(Parent(relativeDoc), Path.GetFileNameWithoutExtension(doc) + "pic");
        Directory.CreateDirectory(repository.Files.Resolve(folder, true));
        var path = await Publish(folder, stem, image.Extension, bytes, "同名图片过多，请更换图片名称。");
        var reference = Posix(Path.GetRelativePath(Path.GetDirectoryName(doc)!, repository.Files.Resolve(path, true)));
        return N(new { path, reference });
    }
    public JsonNode List()
    {
        var dir = repository.Files.Resolve(ImportFolder, true);
        if (!Exists(dir)) return new JsonArray();
        var entries = new DirectoryInfo(dir).EnumerateFiles().Where(f => Image(f.Name) && (f.Attributes & FileAttributes.ReparsePoint) == 0);
        return N(entries.OrderBy(f => f.Name, Comparer<string>.Create((x, y) => Order.Compare(x, y))).Select(f => new { name = f.Name, path = Join(ImportFolder, f.Name) }));
    }
    static void ValidateImportedPath(string path) => Require(Regex.IsMatch(path, "^" + ImportFolder + @"/[^/\\]+$"), "图片路径无效。");
    public async Task<ImageData> ReadFile(string path, bool imported = false)
    {
        if (imported) ValidateImportedPath(path);
        else Require(Image(path), "图片格式不受支持。");
        var info = new FileInfo(repository.Files.Resolve(path, true));
        if (!Exists(info.FullName)) throw new FileNotFoundException();
        Require(!Directory.Exists(info.FullName) && info.Length <= MaxImageBytes, "图片无效或超过 12 MB。");
        return ImageType(await File.ReadAllBytesAsync(info.FullName));
    }
    static bool DecodePath(string raw, out string value)
    {
        value = "";
        if (Regex.IsMatch(raw, @"%(?![0-9A-Fa-f]{2})")) return false;
        try
        {
            value = Regex.Replace(raw, @"(?:%[0-9A-Fa-f]{2})+", m =>
            {
                var bytes = Enumerable.Range(0, m.Length / 3).Select(i => Convert.ToByte(m.Value.Substring(i * 3 + 1, 2), 16)).ToArray();
                return new UTF8Encoding(false, true).GetString(bytes);
            });
            return true;
        }
        catch (DecoderFallbackException) { return false; }
    }
    public async Task<ImageData> ReadReference(string document, string? reference)
    {
        var file = repository.Files.Resolve(document);
        await repository.Files.Read(document);
        Require(reference != null && reference.Length <= 3000, "图片路径无效。");
        var raw = Regex.Replace(reference!, "^<|>$", "");
        Require(DecodePath(raw, out var value), "图片路径编码无效。");
        Require(!Regex.IsMatch(value, @"^(?:[a-z][a-z\d+.-]*:|[\\/])", RegexOptions.IgnoreCase) && !value.Contains('\0'), "仅预览写作空间内的相对图片路径。");
        var target = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(file)!, Posix(value)));
        return await ReadFile(Posix(Path.GetRelativePath(repository.Root, target)));
    }
    string? ResolveDestination(string? url, string path)
    {
        if (string.IsNullOrEmpty(url) || Regex.IsMatch(url, @"^(?:[a-z][a-z\d+.-]*:|/|#)", RegexOptions.IgnoreCase)) return null;
        if (!DecodePath(url.Split('?', '#')[0], out var raw) || raw.Contains('\\') || raw.Contains('\0')) return null;
        try
        {
            var document = repository.Files.Resolve(path);
            return Posix(Path.GetRelativePath(repository.Root, Path.GetFullPath(Path.Combine(Path.GetDirectoryName(document)!, raw))));
        }
        catch (ArgumentException) { return null; }
    }
    public async Task<JsonNode> References(string imagePath)
    {
        ValidateImportedPath(imagePath);
        var image = repository.Files.Resolve(imagePath, true);
        if (!Exists(image)) throw new FileNotFoundException();
        Require(File.Exists(image), "图片不存在。");
        var matches = new List<(string Path, int[] Lines)>();
        var skipped = new List<string>();
        async Task Walk(string relative)
        {
            FileSystemInfo[] entries;
            try
            {
                var dir = relative.Length == 0 ? repository.Root : repository.Files.Resolve(relative, true);
                entries = new DirectoryInfo(dir).GetFileSystemInfos();
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or ApiException)
            {
                skipped.Add(relative.Length == 0 ? "仓库根目录" : relative);
                return;
            }
            foreach (var entry in entries)
            {
                if (entry.Name.StartsWith('.') || (entry.Attributes & FileAttributes.ReparsePoint) != 0) continue;
                var name = Join(relative, entry.Name);
                if (entry is DirectoryInfo) { await Walk(name); continue; }
                if (!name.EndsWith(".md", StringComparison.OrdinalIgnoreCase)) continue;
                try
                {
                    var text = (await repository.Files.Read(name)).S("text");
                    var lines = Markdown.Parse(text, MarkdownSyntax).Descendants<LinkInline>()
                        .Where(n => n.IsImage && string.Equals(ResolveDestination(n.Url, name), imagePath, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
                        .Select(n => n.Line + 1).ToArray();
                    if (lines.Length > 0) matches.Add((name, lines));
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException or ApiException) { skipped.Add(name); }
            }
        }
        await Walk("");
        return N(new { matches = matches.OrderBy(n => n.Path, Comparer<string>.Create((x, y) => Order.Compare(x, y))).Select(n => new { path = n.Path, lines = n.Lines }), skipped, scope = "saved-markdown" });
    }
}
