using System.Diagnostics;
using System.Net;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static Hive.J;

namespace Hive;

public sealed partial class Updates
{
    const string Repository = "Seal1nThePot/HIVE-Md-editor";
    static readonly Uri ReleaseApi = new($"https://api.github.com/repos/{Repository}/releases/latest");
    static readonly HashSet<string> ApiHost = new(StringComparer.Ordinal) { "api.github.com" };
    static readonly HashSet<string> DownloadHosts = new(StringComparer.Ordinal) {
        "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"
    };
    static readonly HttpClient UpdateNetwork = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false, UseCookies = false, AutomaticDecompression = DecompressionMethods.All
    }) { Timeout = Timeout.InfiniteTimeSpan };

    sealed record Release(Manifest Manifest, Uri Bundle);

    static async Task<HttpResponseMessage> RequestGithub(HttpClient client, Uri address, HashSet<string> hosts, string accept, CancellationToken cancel)
    {
        for (var hop = 0; hop <= 4; hop++)
        {
            Require(address.IsAbsoluteUri && address.Scheme == "https" && address.UserInfo.Length == 0 &&
                address.IsDefaultPort && hosts.Contains(address.IdnHost), "更新链接不属于可信的 GitHub 发布源。");
            using var request = new HttpRequestMessage(HttpMethod.Get, address);
            request.Headers.UserAgent.ParseAdd("HIVE-Desktop-Update");
            request.Headers.Accept.ParseAdd(accept);
            HttpResponseMessage result;
            try { result = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancel); }
            catch (Exception error) when (error is HttpRequestException or OperationCanceledException)
            {
                throw new ApiException("无法连接 GitHub 更新源，请检查网络后重试。");
            }
            if ((int)result.StatusCode is not (301 or 302 or 303 or 307 or 308)) return result;
            var location = result.Headers.Location;
            result.Dispose();
            if (location == null) break;
            address = new Uri(address, location);
        }
        throw new ApiException("GitHub 更新链接重定向失败。");
    }

    static Task<HttpResponseMessage> Download(HttpClient client, Uri uri, CancellationToken cancel) =>
        RequestGithub(client, uri, DownloadHosts, "application/octet-stream", cancel);

    static async Task<JsonObject> GithubJson(HttpResponseMessage response, int limit, CancellationToken cancel)
    {
        Require(response.IsSuccessStatusCode, $"无法读取 GitHub 更新信息（HTTP {(int)response.StatusCode}）。");
        Require(response.Content.Headers.ContentLength is not long length || length <= limit, "GitHub 更新信息超过允许大小。");
        await using var stream = await response.Content.ReadAsStreamAsync(cancel);
        using var data = new MemoryStream();
        var buffer = new byte[8192];
        int read;
        while ((read = await stream.ReadAsync(buffer, cancel)) > 0)
        {
            Require(data.Length + read <= limit, "GitHub 更新信息超过允许大小。");
            data.Write(buffer, 0, read);
        }
        return ParseObject(data.GetBuffer().AsSpan(0, (int)data.Length), "GitHub 更新信息格式无效。");
    }

    static async Task<Release?> LatestRelease(HttpClient client, string electron, string arch, CancellationToken stopping)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        var token = timeout.Token;
        try
        {
            using var response = await RequestGithub(client, ReleaseApi, ApiHost, "application/vnd.github+json", token);
            if (response.StatusCode == HttpStatusCode.NotFound) return null;
            var release = await GithubJson(response, 512 * 1024, token);
            var tag = release.S("tag_name");
            Require(Regex.IsMatch(tag, @"\Av?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\z") &&
                !release.B("draft") && !release.B("prerelease"), "GitHub 稳定版发布记录无效。");
            Require(release["assets"] is JsonArray, "GitHub 发布附件信息无效。");
            JsonNode? Asset(string name) => release.A("assets").FirstOrDefault(asset => asset is JsonObject && asset.S("name") == name && asset.S("state") == "uploaded");
            if (Asset(ManifestName) == null) return null;
            var archiveAsset = Asset(BundleName);
            if (archiveAsset == null && Asset(ArchiveName) == null) return null;
            var baseUri = new Uri($"https://github.com/{Repository}/releases/download/{Uri.EscapeDataString(tag)}/");
            using var manifestResponse = await Download(client, new Uri(baseUri, ManifestName), token);
            var manifest = ParseManifest(await GithubJson(manifestResponse, JsonLimit, token), electron, arch);
            Require(archiveAsset?["size"] is JsonValue value && value.TryGetValue<long>(out var size) && size == manifest.Bytes &&
                manifest.Build.Version == tag.TrimStart('v').Split(['-', '+'], 2)[0] && manifest.Build.Channel == "stable",
                "GitHub 更新清单与发布附件不匹配。");
            return new(manifest, new Uri(baseUri, BundleName));
        }
        catch (Exception error) when (error is IOException or HttpRequestException or OperationCanceledException)
        {
            throw new ApiException("无法读取 GitHub 更新信息，请检查网络后重试。");
        }
    }

    async Task DownloadBundle(Release release, string destination)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
        timeout.CancelAfter(TimeSpan.FromMinutes(10));
        var token = timeout.Token;
        var bytes = release.Manifest.Bytes;
        var last = Stopwatch.GetTimestamp();
        SetProgress(N(new { phase = "downloading", receivedBytes = 0, totalBytes = bytes }));
        try
        {
            using var result = await Download(network, release.Bundle, token);
            Require(result.IsSuccessStatusCode, $"无法下载 GitHub 更新包（HTTP {(int)result.StatusCode}）。");
            Require(result.Content.Headers.ContentLength is not long available || available == bytes, "下载的更新包大小与清单不符。");
            await using var source = await result.Content.ReadAsStreamAsync(token);
            await using var output = NewFile(destination);
            await CopySized(source, output, bytes, "下载的更新包大小与清单不符，请重试。", token, received =>
            {
                if (received == bytes || Stopwatch.GetElapsedTime(last) < TimeSpan.FromMilliseconds(100)) return;
                last = Stopwatch.GetTimestamp();
                SetProgress(N(new { phase = "downloading", receivedBytes = received, totalBytes = bytes }));
            });
            output.Flush(true);
            SetProgress(N(new { phase = "downloaded", receivedBytes = bytes, totalBytes = bytes }));
        }
        catch (Exception error) when (error is IOException or HttpRequestException or OperationCanceledException)
        {
            throw new ApiException("无法完整下载 GitHub 更新包，请检查网络后重试。");
        }
    }
}
