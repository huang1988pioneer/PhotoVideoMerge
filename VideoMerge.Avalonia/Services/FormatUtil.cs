using System.Globalization;

namespace VideoMerge.Avalonia.Services;

internal static class FormatUtil
{
    public const double DefaultStillSec = 5;
    public const int MaxOutputLongEdge = 4096;
    public const int MaxLoopCount = 999;
    public const int MaxDurationSec = 2 * 60 * 60;

    public static string Duration(double seconds)
    {
        if (double.IsNaN(seconds) || seconds < 0) return "—";
        var s = (int)Math.Floor(seconds);
        var h = s / 3600;
        var m = s % 3600 / 60;
        var r = s % 60;
        return h > 0 ? $"{h}:{m:00}:{r:00}" : $"{m}:{r:00}";
    }

    public static string Bytes(long bytes)
    {
        if (bytes < 0) return "—";
        if (bytes < 1024) return $"{bytes} B";
        if (bytes < 1024 * 1024) return $"{bytes / 1024.0:0.0} KB";
        return $"{bytes / (1024.0 * 1024.0):0.0} MB";
    }

    public static (int Width, int Height, string Orientation) ResolveOutputSize(int srcW, int srcH)
    {
        if (srcW <= 0 || srcH <= 0) return (1920, 1080, "landscape");
        double outW = srcW;
        double outH = srcH;
        var longEdge = Math.Max(outW, outH);
        if (longEdge > MaxOutputLongEdge)
        {
            var scale = MaxOutputLongEdge / longEdge;
            outW *= scale;
            outH *= scale;
        }

        var w = Math.Max(2, (int)Math.Round(outW) & ~1);
        var h = Math.Max(2, (int)Math.Round(outH) & ~1);
        var ori = h > w ? "portrait" : w > h ? "landscape" : "square";
        return (w, h, ori);
    }

    public static string OrientationLabel(int w, int h) =>
        h > w ? "直式" : w > h ? "橫式" : "方形";

    public static string OrientationLabel(string? key) => key switch
    {
        "portrait" => "直式",
        "landscape" => "橫式",
        "square" => "方形",
        _ => "",
    };

    public static string SrtTimestamp(double sec)
    {
        if (double.IsNaN(sec) || sec < 0) sec = 0;
        var totalMs = (int)Math.Round(sec * 1000);
        var ms = totalMs % 1000;
        var totalSec = totalMs / 1000;
        var s = totalSec % 60;
        var totalMin = totalSec / 60;
        var m = totalMin % 60;
        var h = totalMin / 60;
        return $"{h:00}:{m:00}:{s:00},{ms:000}";
    }

    public static string Invariant(double v) => v.ToString("0.###", CultureInfo.InvariantCulture);
}
