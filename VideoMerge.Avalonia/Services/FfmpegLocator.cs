namespace VideoMerge.Avalonia.Services;

internal sealed class FfmpegLocator
{
    public string? FfmpegPath { get; private set; }
    public string? FfprobePath { get; private set; }
    public string? FfplayPath { get; private set; }

    public bool IsReady => !string.IsNullOrWhiteSpace(FfmpegPath) && File.Exists(FfmpegPath);

    public string StatusText =>
        IsReady
            ? $"FFmpeg：{FfmpegPath}"
            : "找不到 FFmpeg。請安裝後加入 PATH，或按「指定 FFmpeg」。";

    public bool TryLocate(string? preferred = null)
    {
        var candidates = new List<string>();
        if (!string.IsNullOrWhiteSpace(preferred))
            candidates.Add(preferred);

        foreach (var fromPath in FindOnPath("ffmpeg.exe", "ffmpeg"))
            candidates.Add(fromPath);

        candidates.AddRange(WellKnownWindowsLocations());

        foreach (var path in candidates.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!File.Exists(path)) continue;
            var dir = Path.GetDirectoryName(path);
            var probe = dir is null ? null : FirstExisting(
                Path.Combine(dir, "ffprobe.exe"),
                Path.Combine(dir, "ffprobe"));
            if (probe is null) continue;

            FfmpegPath = path;
            FfprobePath = probe;
            FfplayPath = dir is null ? null : FirstExisting(
                Path.Combine(dir, "ffplay.exe"),
                Path.Combine(dir, "ffplay"));
            return true;
        }

        FfmpegPath = null;
        FfprobePath = null;
        FfplayPath = null;
        return false;
    }

    public bool UseExplicit(string ffmpegPath)
    {
        if (string.IsNullOrWhiteSpace(ffmpegPath) || !File.Exists(ffmpegPath))
            return false;
        return TryLocate(ffmpegPath);
    }

    private static IEnumerable<string> FindOnPath(params string[] names)
    {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var name in names)
            {
                var full = Path.Combine(dir.Trim(), name);
                if (File.Exists(full)) yield return full;
            }
        }
    }

    private static IEnumerable<string> WellKnownWindowsLocations()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var extras = new[]
        {
            Path.Combine(local, @"Microsoft\WinGet\Packages"),
            @"C:\ffmpeg\bin",
            @"C:\Program Files\ffmpeg\bin",
            @"C:\Program Files\Gyan\FFmpeg\bin",
        };

        foreach (var root in extras)
        {
            if (!Directory.Exists(root)) continue;
            string[] hits;
            try
            {
                hits = Directory.GetFiles(root, "ffmpeg.exe", SearchOption.AllDirectories);
            }
            catch
            {
                continue;
            }

            foreach (var hit in hits.Take(8))
                yield return hit;
        }
    }

    private static string? FirstExisting(params string[] paths) =>
        paths.FirstOrDefault(File.Exists);
}
