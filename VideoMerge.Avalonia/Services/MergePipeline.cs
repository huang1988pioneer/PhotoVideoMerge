using System.Globalization;

namespace VideoMerge.Avalonia.Services;

internal sealed record MergeClip(
    string Path,
    bool IsImage,
    double DurationSec,
    int Width,
    int Height);

internal sealed record LoopOptions(
    string Mode,
    int Count,
    double TargetSeconds,
    double BaseDurationSec);

internal sealed record MergeRequest(
    IReadOnlyList<MergeClip> Clips,
    bool NoAudio,
    string? AudioPath,
    string? SubtitleSrt,
    LoopOptions Loop,
    string OutputPath);

internal sealed class MergePipeline
{
    private readonly FfmpegRunner _runner;

    public MergePipeline(FfmpegRunner runner)
    {
        _runner = runner;
    }

    public async Task MergeAsync(
        MergeRequest req,
        IProgress<string>? log,
        IProgress<string>? status,
        IProgress<double>? progress,
        CancellationToken ct)
    {
        if (req.Clips.Count == 0)
            throw new InvalidOperationException("請至少選擇一段影片或圖片。");

        var work = Path.Combine(AppPaths.WorkDirectory, DateTime.Now.ToString("yyyyMMdd-HHmmss-fff"));
        Directory.CreateDirectory(work);

        var useCustomAudio = !req.NoAudio && !string.IsNullOrWhiteSpace(req.AudioPath) && File.Exists(req.AudioPath);
        var stripOriginal = req.NoAudio || useCustomAudio;
        var needsLoop = req.Loop.Mode is "count" or "duration";

        var seed = req.Clips.FirstOrDefault(c => c.Width > 0 && c.Height > 0);
        var (outW, outH, ori) = FormatUtil.ResolveOutputSize(seed?.Width ?? 0, seed?.Height ?? 0);
        log?.Report($"輸出畫幅：{FormatUtil.OrientationLabel(ori)} {outW}×{outH}");

        var durs = req.Clips.Select(c =>
            c.DurationSec > 0 ? c.DurationSec : c.IsImage ? FormatUtil.DefaultStillSec : 10).ToArray();
        var baseDur = req.Loop.BaseDurationSec > 0 ? req.Loop.BaseDurationSec : durs.Sum();
        var outDur = req.Loop.Mode switch
        {
            "count" => baseDur * Math.Max(1, req.Loop.Count),
            "duration" => Math.Max(0.1, req.Loop.TargetSeconds),
            _ => baseDur,
        };

        if (req.NoAudio) log?.Report("選項：不要聲音");
        if (useCustomAudio) log?.Report($"選項：自訂音軌 {Path.GetFileName(req.AudioPath)}");

        var stages = new List<(string Id, double Weight, string Label)>
        {
            ("prep", 2, "準備工作目錄…"),
        };
        for (var i = 0; i < req.Clips.Count; i++)
        {
            stages.Add((
                $"norm{i}",
                Math.Max(8, durs[i]),
                req.Clips[i].IsImage
                    ? $"圖片轉影片 {i + 1} / {req.Clips.Count}…"
                    : $"標準化第 {i + 1} / {req.Clips.Count} 段…"));
        }
        stages.Add(("concat", 4, req.Clips.Count == 1 ? "準備基底片段…" : "串接片段…"));
        if (needsLoop)
        {
            stages.Add(("loop", Math.Max(20, outDur * 1.2),
                req.Loop.Mode == "count"
                    ? $"循環延長：重複 {req.Loop.Count} 次…"
                    : $"循環延長並裁切至 {FormatUtil.Duration(outDur)}…"));
        }
        else stages.Add(("export", 3, "輸出中…"));
        if (useCustomAudio) stages.Add(("audio", Math.Max(5, outDur * 0.25), "套用自訂音軌…"));
        if (!string.IsNullOrWhiteSpace(req.SubtitleSrt)) stages.Add(("subs", 3, "嵌入字幕…"));
        stages.Add(("done", 1, "完成"));

        var tracker = new StageTracker(stages, progress, status);

        try
        {
            tracker.Start("prep");
            var normalized = new List<string>();
            tracker.Complete();

            for (var i = 0; i < req.Clips.Count; i++)
            {
                ct.ThrowIfCancellationRequested();
                tracker.Start($"norm{i}");
                var outFile = Path.Combine(work, $"norm{i}.mp4");
                await NormalizeAsync(
                    req.Clips[i], outFile, outW, outH, stripOriginal, durs[i], log,
                    new Progress<double>(tracker.Update), ct);
                normalized.Add(outFile);
                tracker.Complete();
            }

            tracker.Start("concat");
            var baseFile = Path.Combine(work, "base.mp4");
            await ConcatAsync(normalized, baseFile, log, baseDur, new Progress<double>(tracker.Update), ct);
            tracker.Complete();

            var videoOnly = useCustomAudio ? Path.Combine(work, "video_only.mp4") : req.OutputPath;
            if (needsLoop)
            {
                tracker.Start("loop");
                var loopOut = useCustomAudio ? videoOnly : req.OutputPath;
                await ApplyLoopAsync(baseFile, loopOut, req.Loop with { BaseDurationSec = baseDur }, stripOriginal,
                    outDur, log, new Progress<double>(tracker.Update), ct);
                tracker.Complete();
            }
            else
            {
                tracker.Start("export");
                await CopyAsync(baseFile, videoOnly, log, baseDur, new Progress<double>(tracker.Update), ct);
                tracker.Complete();
            }

            var current = videoOnly;
            if (useCustomAudio)
            {
                tracker.Start("audio");
                await MuxAudioAsync(videoOnly, req.AudioPath!, req.OutputPath, outDur, log, new Progress<double>(tracker.Update), ct);
                current = req.OutputPath;
                tracker.Complete();
            }

            if (!string.IsNullOrWhiteSpace(req.SubtitleSrt))
            {
                tracker.Start("subs");
                var srtPath = Path.Combine(work, "subs.srt");
                await File.WriteAllTextAsync(srtPath, req.SubtitleSrt.Trim().TrimStart('\uFEFF'), ct);
                var withSubs = Path.Combine(work, "with_subs.mp4");
                try
                {
                    await MuxSubsAsync(current, srtPath, withSubs, log, ct);
                    File.Copy(withSubs, req.OutputPath, overwrite: true);
                    log?.Report("字幕已嵌入 MP4（mov_text）");
                }
                catch (Exception ex)
                {
                    log?.Report($"嵌入字幕失敗（影片仍已輸出）：{ex.Message}");
                    if (!string.Equals(current, req.OutputPath, StringComparison.OrdinalIgnoreCase))
                        File.Copy(current, req.OutputPath, overwrite: true);
                }
                tracker.Complete();
            }
            else if (!string.Equals(current, req.OutputPath, StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(current, req.OutputPath, overwrite: true);
            }

            tracker.Start("done");
            tracker.Finish();
        }
        finally
        {
            try { Directory.Delete(work, recursive: true); }
            catch { /* keep temp on lock */ }
        }
    }

    private async Task NormalizeAsync(
        MergeClip clip,
        string output,
        int w,
        int h,
        bool noAudio,
        double durationSec,
        IProgress<string>? log,
        IProgress<double>? local,
        CancellationToken ct)
    {
        var vf =
            $"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos," +
            $"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p";

        if (clip.IsImage)
        {
            var t = Math.Max(0.1, durationSec);
            log?.Report($"靜態圖轉影片：{Path.GetFileName(clip.Path)} → {w}x{h} · {t:0.##}s");
            await _runner.RunFfmpegAsync(
                [
                    "-y", "-loop", "1", "-framerate", "30", "-i", clip.Path,
                    "-t", FormatUtil.Invariant(t),
                    "-vf", vf,
                    "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
                    "-crf", "16", "-pix_fmt", "yuv420p", "-an",
                    output,
                ],
                log, ct, t, local);
            return;
        }

        var args = new List<string>
        {
            "-y", "-i", clip.Path, "-vf", vf,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
        };
        if (noAudio)
        {
            args.Add("-an");
        }
        else
        {
            args.AddRange(["-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "192k", "-shortest"]);
        }
        args.Add(output);

        try
        {
            await _runner.RunFfmpegAsync(args, log, ct, durationSec, local);
        }
        catch (Exception ex) when (!noAudio)
        {
            log?.Report($"含音訊轉檔失敗，改為純影像：{ex.Message}");
            await _runner.RunFfmpegAsync(
                [
                    "-y", "-i", clip.Path, "-vf", vf,
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                    "-an", output,
                ],
                log, ct, durationSec, local);
        }
    }

    private async Task ConcatAsync(
        IReadOnlyList<string> files,
        string output,
        IProgress<string>? log,
        double expected,
        IProgress<double>? local,
        CancellationToken ct)
    {
        if (files.Count == 1)
        {
            await CopyAsync(files[0], output, log, expected, local, ct);
            return;
        }

        var listPath = output + ".txt";
        var body = string.Join('\n', files.Select(f =>
            "file '" + f.Replace("\\", "/", StringComparison.Ordinal).Replace("'", "'\\''", StringComparison.Ordinal) + "'"));
        await File.WriteAllTextAsync(listPath, body + "\n", ct);
        await _runner.RunFfmpegAsync(
            ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", output],
            log, ct, expected, local);
    }

    private Task CopyAsync(
        string input,
        string output,
        IProgress<string>? log,
        double expected,
        IProgress<double>? local,
        CancellationToken ct) =>
        _runner.RunFfmpegAsync(
            ["-y", "-i", input, "-c", "copy", "-movflags", "+faststart", output],
            log, ct, expected, local);

    private async Task ApplyLoopAsync(
        string input,
        string output,
        LoopOptions loop,
        bool noAudio,
        double outDur,
        IProgress<string>? log,
        IProgress<double>? local,
        CancellationToken ct)
    {
        if (loop.Mode == "count")
        {
            var count = loop.Count;
            if (count < 1) throw new InvalidOperationException("重複次數至少為 1");
            if (count > FormatUtil.MaxLoopCount)
                throw new InvalidOperationException($"重複次數上限為 {FormatUtil.MaxLoopCount}");
            if (count == 1)
            {
                await CopyAsync(input, output, log, loop.BaseDurationSec, local, ct);
                return;
            }

            await _runner.RunFfmpegAsync(
                [
                    "-y", "-stream_loop", (count - 1).ToString(CultureInfo.InvariantCulture),
                    "-i", input, "-c", "copy", "-movflags", "+faststart", output,
                ],
                log, ct, outDur, local);
            return;
        }

        if (loop.Mode == "duration")
        {
            var target = loop.TargetSeconds;
            if (target <= 0) throw new InvalidOperationException("請輸入有效的目標時長");
            if (target > FormatUtil.MaxDurationSec)
                throw new InvalidOperationException($"目標時長上限為 {FormatUtil.MaxDurationSec / 3600} 小時");

            var reencode = new List<string>
            {
                "-y", "-stream_loop", "-1", "-i", input,
                "-t", FormatUtil.Invariant(target),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
            };
            if (noAudio) reencode.Add("-an");
            else reencode.AddRange(["-c:a", "aac", "-b:a", "192k"]);
            reencode.AddRange(["-movflags", "+faststart", output]);
            await _runner.RunFfmpegAsync(reencode, log, ct, target, local);
            return;
        }

        await CopyAsync(input, output, log, loop.BaseDurationSec, local, ct);
    }

    private Task MuxAudioAsync(
        string video,
        string audio,
        string output,
        double expected,
        IProgress<string>? log,
        IProgress<double>? local,
        CancellationToken ct) =>
        _runner.RunFfmpegAsync(
            [
                "-y", "-i", video, "-stream_loop", "-1", "-i", audio,
                "-map", "0:v:0", "-map", "1:a:0",
                "-c:v", "copy", "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "192k",
                "-shortest", "-movflags", "+faststart", output,
            ],
            log, ct, expected, local);

    private Task MuxSubsAsync(
        string video,
        string srt,
        string output,
        IProgress<string>? log,
        CancellationToken ct) =>
        _runner.RunFfmpegAsync(
            [
                "-y", "-i", video, "-i", srt,
                "-map", "0", "-map", "1",
                "-c", "copy", "-c:s", "mov_text",
                "-metadata:s:s:0", "language=zho",
                "-movflags", "+faststart", output,
            ],
            log, ct);
}

internal sealed class StageTracker
{
    private readonly IReadOnlyList<(string Id, double Weight, string Label)> _stages;
    private readonly IProgress<double>? _progress;
    private readonly IProgress<string>? _status;
    private int _index;
    private double _last;

    public StageTracker(
        IReadOnlyList<(string Id, double Weight, string Label)> stages,
        IProgress<double>? progress,
        IProgress<string>? status)
    {
        _stages = stages;
        _progress = progress;
        _status = status;
    }

    public void Start(string id)
    {
        var i = _stages.ToList().FindIndex(s => s.Id == id);
        if (i >= 0) _index = i;
        Emit(0, _stages[_index].Label);
    }

    public void Update(double local) => Emit(local, null);

    public void Complete()
    {
        Emit(1, _stages[_index].Label);
        if (_index < _stages.Count - 1) _index++;
    }

    public void Finish()
    {
        _last = 1;
        _progress?.Report(1);
        _status?.Report("完成");
    }

    private void Emit(double local, string? label)
    {
        var total = Math.Max(1e-6, _stages.Sum(s => Math.Max(0.01, s.Weight)));
        var done = 0d;
        for (var i = 0; i < _index; i++) done += Math.Max(0.01, _stages[i].Weight);
        var cur = Math.Max(0.01, _stages[_index].Weight);
        var ratio = (done + cur * Math.Min(0.98, Math.Clamp(local, 0, 1))) / total;
        ratio = Math.Max(_last, Math.Min(0.99, ratio));
        _last = ratio;
        _progress?.Report(ratio);
        if (label is not null) _status?.Report(label);
    }
}
