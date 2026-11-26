using static Hive.J;

namespace Hive;

static class DesktopPaths
{
    public static string? FindTemplateSource(string project)
    {
        var exe = Environment.GetEnvironmentVariable("HIVE_DESKTOP_EXE");
        var portable = Environment.GetEnvironmentVariable("PORTABLE_EXECUTABLE_DIR");
        var packaged = Environment.GetEnvironmentVariable("HIVE_DESKTOP_PACKAGED") == "1";
        foreach (var anchor in new[] { portable, string.IsNullOrEmpty(exe) ? null : Path.GetDirectoryName(exe), packaged ? null : project })
        {
            if (string.IsNullOrEmpty(anchor)) continue;
            string? directory = Path.GetFullPath(anchor);
            for (var level = 0; directory != null && level < 5; level++, directory = Path.GetDirectoryName(directory))
            {
                var templates = Path.Combine(directory, "templates");
                if (Directory.Exists(templates) && (File.GetAttributes(templates) & FileAttributes.ReparsePoint) == 0) return templates;
            }
        }
        return null;
    }
}
