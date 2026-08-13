using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace VideoMerge.Avalonia.Services;

internal sealed class FfmpegRunner
{
    private static readonly Regex TimeRegex = new(
        @"time=(\d+):(\d+):(\d+(?:\.\d+)?)",
        RegexOptions.Compiled);

    private readonly FfmpegLocator _locator;

    public FfmpegRunner(FfmpegLocator locator)
    {
        _locator = locator;
    }

    public Task RunFfmpegAsync(
        IEnumerable<string> args,
        IProgress<string>? log,
        CancellationToken ct,
        double? expectedSeconds = null,
        IProgress<double>? localProgress = null) =>
        RunAsync(_locator.FfmpegPath, args, log, ct, expectedSeconds, localProgress);

    public Task<string> RunFfprobeAsync(IEnumerable<string> args, CancellationToken ct) =>
        RunCaptureAsync(_locator.FfprobePath, args, ct);

    private async Task RunAsync(
        string? exe,
        IEnumerable<string> args,
        IProgress<string>? log,
        CancellationToken ct,
        double? expectedSeconds,
        IProgress<double>? localProgress)
    {
        EnsureReady(exe);
        var list = args.ToList();
        log?.Report("$ " + FormatCommand(exe!, list));

        using var proc = CreateProcess(exe!, list, redirectStdout: true);
        var errors = new StringBuilder();

        proc.ErrorDataReceived += (_, e) =>
        {
            if (string.IsNullOrEmpty(e.Data)) return;
            errors.AppendLine(e.Data);
            if (e.Data.Contains("time=", StringComparison.Ordinal))
            {
                var local = LocalProgress(e.Data, expectedSeconds);
                if (local is not null) localProgress?.Report(local.Value);
            }
            else if (ShouldLog(e.Data))
            {
                log?.Report(e.Data);
            }
        };

        proc.Start();
        proc.BeginErrorReadLine();
        using var stdout = proc.StandardOutput;
        _ = stdout.ReadToEndAsync(ct);

        await WaitForExitAsync(proc, ct);

        if (proc.ExitCode != 0)
        {
            var tail = Tail(errors.ToString(), 12);
            throw new InvalidOperationException(
                $"FFmpeg 結束代碼 {proc.ExitCode}。\n{tail}");
        }

        localProgress?.Report(1);
    }

    private static async Task<string> RunCaptureAsync(
        string? exe,
        IEnumerable<string> args,
        CancellationToken ct)
    {
        EnsureReady(exe);
        using var proc = CreateProcess(exe!, args.ToList(), redirectStdout: true);
        var stderr = new StringBuilder();
        proc.ErrorDataReceived += (_, e) =>
        {
            if (!string.IsNullOrEmpty(e.Data)) stderr.AppendLine(e.Data);
        };
        proc.Start();
        proc.BeginErrorReadLine();
        var stdout = await proc.StandardOutput.ReadToEndAsync(ct);
        await WaitForExitAsync(proc, ct);
        if (proc.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"ffprobe 失敗（{proc.ExitCode}）：{Tail(stderr.ToString(), 8)}");
        }
        return stdout;
    }

    private static void EnsureReady(string? exe)
    {
        if (string.IsNullOrWhiteSpace(exe) || !File.Exists(exe))
            throw new InvalidOperationException("尚未找到 FFmpeg / ffprobe。");
    }

    private static Process CreateProcess(string exe, List<string> args, bool redirectStdout)
    {
        var psi = new ProcessStartInfo
        {
            FileName = exe,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = redirectStdout,
            StandardErrorEncoding = Encoding.UTF8,
            StandardOutputEncoding = Encoding.UTF8,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        return new Process { StartInfo = psi, EnableRaisingEvents = true };
    }

    private static async Task WaitForExitAsync(Process proc, CancellationToken ct)
    {
        try
        {
            await proc.WaitForExitAsync(ct);
        }
        catch (OperationCanceledException)
        {
            try
            {
                if (!proc.HasExited) proc.Kill(entireProcessTree: true);
            }
            catch
            {
                /* ignore */
            }
            throw;
        }
    }

    private static double? LocalProgress(string line, double? expectedSeconds)
    {
        if (expectedSeconds is null or <= 0) return null;
        var m = TimeRegex.Match(line);
        if (!m.Success) return null;
        var h = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
        var min = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
        var sec = double.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture);
        var t = h * 3600 + min * 60 + sec;
        return Math.Clamp(t / expectedSeconds.Value, 0, 0.99);
    }

    private static bool ShouldLog(string line) =>
        line.Contains("error", StringComparison.OrdinalIgnoreCase) ||
        line.Contains("failed", StringComparison.OrdinalIgnoreCase) ||
        line.StartsWith("Input #", StringComparison.Ordinal) ||
        line.StartsWith("Output #", StringComparison.Ordinal);

    private static string FormatCommand(string exe, IReadOnlyList<string> args)
    {
        static string Q(string s) => s.Contains(' ') ? $"\"{s}\"" : s;
        return Q(exe) + " " + string.Join(' ', args.Select(Q));
    }

    private static string Tail(string text, int lines)
    {
        var arr = text.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        return string.Join('\n', arr.TakeLast(lines));
    }
}
