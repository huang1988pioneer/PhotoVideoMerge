using System.Globalization;
using System.Text.Json;

namespace VideoMerge.Avalonia.Services;

internal sealed record MediaInfo(
    double DurationSec,
    int Width,
    int Height,
    long SizeBytes,
    bool HasVideo,
    bool HasAudio);

internal sealed class MediaInfoService
{
    private readonly FfmpegRunner _runner;

    public MediaInfoService(FfmpegRunner runner)
    {
        _runner = runner;
    }

    public async Task<MediaInfo> ProbeAsync(string path, CancellationToken ct)
    {
        var json = await _runner.RunFfprobeAsync(
            [
                "-v", "quiet",
                "-print_format", "json",
                "-show_format",
                "-show_streams",
                path,
            ],
            ct);

        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
        var root = doc.RootElement;

        double duration = 0;
        long size = 0;
        if (root.TryGetProperty("format", out var format))
        {
            duration = ReadDouble(format, "duration");
            size = (long)ReadDouble(format, "size");
        }

        var width = 0;
        var height = 0;
        var hasVideo = false;
        var hasAudio = false;
        if (root.TryGetProperty("streams", out var streams) && streams.ValueKind == JsonValueKind.Array)
        {
            foreach (var s in streams.EnumerateArray())
            {
                var type = s.TryGetProperty("codec_type", out var t) ? t.GetString() : null;
                if (type == "video" && !hasVideo)
                {
                    hasVideo = true;
                    width = ReadInt(s, "width");
                    height = ReadInt(s, "height");
                    if (duration <= 0) duration = ReadDouble(s, "duration");
                }
                else if (type == "audio")
                {
                    hasAudio = true;
                    if (duration <= 0) duration = ReadDouble(s, "duration");
                }
            }
        }

        if (size <= 0)
        {
            try { size = new FileInfo(path).Length; }
            catch { /* ignore */ }
        }

        return new MediaInfo(duration, width, height, size, hasVideo, hasAudio);
    }

    private static double ReadDouble(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var p)) return 0;
        return p.ValueKind switch
        {
            JsonValueKind.Number => p.GetDouble(),
            JsonValueKind.String when double.TryParse(
                p.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var v) => v,
            _ => 0,
        };
    }

    private static int ReadInt(JsonElement el, string name)
    {
        if (!el.TryGetProperty(name, out var p)) return 0;
        return p.ValueKind switch
        {
            JsonValueKind.Number => p.GetInt32(),
            JsonValueKind.String when int.TryParse(p.GetString(), out var v) => v,
            _ => 0,
        };
    }
}
