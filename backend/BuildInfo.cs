using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using static Hive.J;

namespace Hive;

public sealed partial class Updates
{
    public static async Task<JsonNode> DesktopBuildInfo(string project, string dist, bool development)
    {
        var package = await ReadObject(Path.Combine(project, "package.json"), "应用包");
        var version = package.S("version", typeof(Updates).Assembly.GetName().Version?.ToString(3) ?? "unavailable");
        if (development)
        {
            var now = DateTime.UtcNow;
            return N(new
            {
                appName = Product,
                version,
                buildNumber = now.ToString("yyyyMMddHHmmssfff", CultureInfo.InvariantCulture) + "-" + Id()[..8],
                buildTime = now.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
                channel = "development"
            });
        }
        try
        {
            var info = await ReadJson(Path.Combine(dist, "build-info.json"), "构建记录不可用。");
            return ParseBuild(info, "构建记录不可用。", version).AsJson();
        }
        catch (Exception e) when (e is IOException or ApiException or UnauthorizedAccessException or JsonException)
        {
            return N(new { appName = Product, version, buildNumber = "unavailable", buildTime = "unavailable", channel = "unavailable" });
        }
    }
}
