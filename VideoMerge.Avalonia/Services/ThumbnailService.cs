using Avalonia;
using Avalonia.Media.Imaging;

namespace VideoMerge.Avalonia.Services;

internal sealed class ThumbnailService
{
    private readonly FfmpegRunner _runner;

    public ThumbnailService(FfmpegRunner runner)
    {
        _runner = runner;
    }

    public async Task<(Bitmap? first, Bitmap? last)> ExtractAsync(
        string path,
        bool isImage,
        double durationSec,
        CancellationToken ct)
    {
        if (isImage)
        {
            var still = LoadScaled(path, 720);
            return (still, still);
        }

        var id = Guid.NewGuid().ToString("N")[..10];
        var firstPath = Path.Combine(AppPaths.ThumbDirectory, $"{id}-first.jpg");
        var lastPath = Path.Combine(AppPaths.ThumbDirectory, $"{id}-last.jpg");

        try
        {
            await _runner.RunFfmpegAsync(
                ["-y", "-ss", "0.01", "-i", path, "-frames:v", "1", "-q:v", "3", firstPath],
                null,
                ct,
                expectedSeconds: 1);

            var lastSeek = durationSec > 0.15
                ? Math.Max(0, durationSec - 0.08)
                : Math.Max(0, durationSec - 0.01);

            try
            {
                await _runner.RunFfmpegAsync(
                    ["-y", "-ss", lastSeek.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture),
                        "-i", path, "-frames:v", "1", "-q:v", "3", lastPath],
                    null,
                    ct,
                    expectedSeconds: 1);
            }
            catch
            {
                /* last frame optional */
            }

            var first = File.Exists(firstPath) ? LoadScaled(firstPath, 720) : null;
            var last = File.Exists(lastPath) ? LoadScaled(lastPath, 720) : first;
            return (first, last);
        }
        finally
        {
            TryDelete(firstPath);
            TryDelete(lastPath);
        }
    }

    public static Bitmap? LoadScaled(string path, int maxEdge)
    {
        try
        {
            using var fs = File.OpenRead(path);
            using var src = new Bitmap(fs);
            var w = src.PixelSize.Width;
            var h = src.PixelSize.Height;
            if (w <= 0 || h <= 0) return null;
            var longEdge = Math.Max(w, h);
            if (longEdge <= maxEdge)
            {
                fs.Position = 0;
                return new Bitmap(fs);
            }

            var scale = maxEdge / (double)longEdge;
            var tw = Math.Max(1, (int)Math.Round(w * scale));
            var th = Math.Max(1, (int)Math.Round(h * scale));
            return src.CreateScaledBitmap(new PixelSize(tw, th));
        }
        catch
        {
            return null;
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch
        {
            /* ignore */
        }
    }
}
