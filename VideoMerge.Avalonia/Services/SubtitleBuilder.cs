using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace VideoMerge.Avalonia.Services;

internal sealed record SubChunk(double Start, double End, string Text);

internal static class SubtitleBuilder
{
    public static string BuildSrt(string scriptText, double durationSec, double offsetSec = 0)
    {
        var chunks = ParseOrDistribute(scriptText, durationSec);
        if (Math.Abs(offsetSec) >= 0.001)
        {
            chunks = chunks.Select(c => new SubChunk(
                Math.Max(0, c.Start + offsetSec),
                Math.Max(0.2, c.End + offsetSec),
                c.Text)).ToList();
        }

        return ToSrt(chunks);
    }

    public static List<SubChunk> ParseOrDistribute(string scriptText, double durationSec)
    {
        var timed = ParseTimed(scriptText);
        if (timed is { Count: > 0 }) return timed;
        return Distribute(scriptText, durationSec);
    }

    public static string ToSrt(IReadOnlyList<SubChunk> chunks)
    {
        var sb = new StringBuilder();
        var i = 1;
        foreach (var c in chunks)
        {
            var text = c.Text.Trim();
            if (text.Length == 0) continue;
            var start = c.Start;
            var end = c.End <= start ? start + 1.5 : c.End;
            sb.Append(i).Append('\n');
            sb.Append(FormatUtil.SrtTimestamp(start))
                .Append(" --> ")
                .Append(FormatUtil.SrtTimestamp(end))
                .Append('\n');
            sb.Append(text).Append("\n\n");
            i++;
        }
        return sb.ToString();
    }

    private static List<SubChunk>? ParseTimed(string raw)
    {
        var text = (raw ?? "").Replace("\uFEFF", "").Replace("\r\n", "\n").Trim();
        if (text.Length == 0) return null;
        var chunks = new List<SubChunk>();

        if (Regex.IsMatch(text, @"\d{1,2}:\d{2}.*-->") || text.StartsWith("WEBVTT", StringComparison.OrdinalIgnoreCase))
        {
            var body = Regex.Replace(text, @"^WEBVTT[^\n]*\n+", "", RegexOptions.IgnoreCase);
            foreach (var block in Regex.Split(body, @"\n\s*\n"))
            {
                var lines = block.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0).ToList();
                var timeLine = lines.FirstOrDefault(l => l.Contains("-->", StringComparison.Ordinal));
                if (timeLine is null) continue;
                var parts = timeLine.Split("-->", 2, StringSplitOptions.TrimEntries);
                if (parts.Length < 2) continue;
                var start = ParseTs(parts[0].Split(' ')[0]);
                var end = ParseTs(parts[1].Split(' ')[0]);
                var cue = string.Join('\n', lines.Where(l => l != timeLine && !Regex.IsMatch(l, @"^\d+$"))).Trim();
                if (cue.Length > 0 && !double.IsNaN(start) && !double.IsNaN(end) && end > start)
                    chunks.Add(new SubChunk(start, end, cue));
            }
            return chunks.Count > 0 ? chunks : null;
        }

        var bracket = new Regex(
            @"^\[?\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?|\d+(?:\.\d+)?)\s*[-–—~]\s*(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?|\d+(?:\.\d+)?)\s*\]?\s*(.+)$");
        foreach (var line in text.Split('\n'))
        {
            var m = bracket.Match(line.Trim());
            if (!m.Success) continue;
            var start = ParseTs(m.Groups[1].Value);
            var end = ParseTs(m.Groups[2].Value);
            var cue = m.Groups[3].Value.Trim();
            if (cue.Length > 0 && !double.IsNaN(start) && !double.IsNaN(end) && end > start)
                chunks.Add(new SubChunk(start, end, cue));
        }
        return chunks.Count > 0 ? chunks : null;
    }

    private static List<SubChunk> Distribute(string scriptText, double durationSec)
    {
        var lines = SplitLines(scriptText);
        if (lines.Count == 0)
            throw new InvalidOperationException("語音稿是空的，請貼上或上傳文字稿。");
        var dur = durationSec;
        if (double.IsNaN(dur) || dur <= 0.5)
            throw new InvalidOperationException("無法取得時長，請先加入影片或音軌再上字幕。");

        const double charsPerSec = 3.2;
        const double minCue = 0.85;
        const double maxCue = 7.5;
        const double gap = 0.06;
        const double leadIn = 0.12;
        const double leadOut = 0.15;

        var ideals = lines.Select(l =>
        {
            var ideal = ScriptWeight(l) / charsPerSec;
            return Math.Min(maxCue, Math.Max(minCue, ideal));
        }).ToArray();

        var gapsTotal = Math.Max(0, lines.Count - 1) * gap;
        var lead = leadIn + leadOut;
        var usable = Math.Max(dur - 0.02, lines.Count * minCue * 0.4);
        var sumIdeal = ideals.Sum() + gapsTotal + lead;
        if (sumIdeal > 1e-6)
        {
            var scale = (usable - gapsTotal - lead) / (sumIdeal - gapsTotal - lead);
            if (!double.IsNaN(scale) && scale > 0)
            {
                for (var i = 0; i < ideals.Length; i++)
                    ideals[i] = Math.Min(maxCue, Math.Max(minCue * 0.7, ideals[i] * scale));
            }
        }

        var chunks = new List<SubChunk>();
        var t = leadIn;
        for (var i = 0; i < lines.Count; i++)
        {
            var len = ideals[i];
            if (i == lines.Count - 1)
                len = Math.Max(t + minCue, dur - leadOut) - t;
            var end = Math.Min(dur, t + len);
            if (end <= t) end = Math.Min(dur, t + 0.5);
            chunks.Add(new SubChunk(t, end, lines[i]));
            t = end + (i < lines.Count - 1 ? gap : 0);
        }
        if (chunks.Count > 0)
            chunks[^1] = chunks[^1] with { End = dur };
        return chunks;
    }

    private static List<string> SplitLines(string raw)
    {
        var text = (raw ?? "").Replace("\r\n", "\n").Trim();
        if (text.Length == 0) return [];
        var parts = Regex.Split(text, @"(?<=[。！？!?；;])\s*|\n+")
            .Select(s => s.Trim())
            .Where(s => s.Length > 0)
            .ToList();
        return parts.Count > 0 ? parts : [text];
    }

    private static double ScriptWeight(string line)
    {
        var n = 0d;
        foreach (var ch in line)
        {
            if (char.IsWhiteSpace(ch)) continue;
            n += ch > 0x2E80 ? 1.0 : 0.45;
        }
        return Math.Max(1, n);
    }

    private static double ParseTs(string str)
    {
        var t = str.Trim().Replace(',', '.');
        var m = Regex.Match(t, @"^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$");
        if (m.Success)
        {
            var h = m.Groups[1].Success ? int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) : 0;
            var min = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
            var s = int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture);
            var frac = m.Groups[4].Success
                ? double.Parse("0." + m.Groups[4].Value.PadRight(3, '0')[..3], CultureInfo.InvariantCulture)
                : 0;
            return h * 3600 + min * 60 + s + frac;
        }
        if (double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out var sec))
            return sec;
        return double.NaN;
    }
}
