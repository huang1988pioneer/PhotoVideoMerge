using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.Text;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using VideoMerge.Avalonia.Services;

namespace VideoMerge.Avalonia.ViewModels;

public partial class MainViewModel : ViewModelBase
{
    private readonly IUiServices _ui;
    private readonly AppSettings _settings;
    private readonly FfmpegLocator _locator = new();
    private readonly FfmpegRunner _runner;
    private readonly MediaInfoService _probe;
    private readonly ThumbnailService _thumbs;
    private readonly MergePipeline _merge;
    private CancellationTokenSource? _mergeCts;
    private readonly SemaphoreSlim _thumbGate = new(2, 2);

    public MainViewModel() : this(NullUi.Instance)
    {
    }

    public MainViewModel(IUiServices ui)
    {
        _ui = ui;
        _settings = AppSettings.Load();
        _runner = new FfmpegRunner(_locator);
        _probe = new MediaInfoService(_runner);
        _thumbs = new ThumbnailService(_runner);
        _merge = new MergePipeline(_runner);

        _locator.TryLocate(_settings.FfmpegPath);
        FfmpegStatus = _locator.StatusText;
        LoopOnce = _settings.LoopMode is "once" or null or "";
        LoopCountMode = _settings.LoopMode == "count";
        LoopDurationMode = _settings.LoopMode == "duration";
        LoopCount = Math.Clamp(_settings.LoopCount, 1, FormatUtil.MaxLoopCount);
        LoopHours = Math.Clamp(_settings.LoopHours, 0, 2);
        LoopMins = Math.Clamp(_settings.LoopMins, 0, 59);
        LoopSecs = Math.Clamp(_settings.LoopSecs, 0, 59);
        NoAudio = _settings.NoAudio;
        UseScriptSubs = _settings.UseScriptSubs;
        SubOffsetSec = _settings.SubOffsetSec;

        Clips.CollectionChanged += OnClipsChanged;
        RefreshEstimate();
    }

    public ObservableCollection<ClipItemViewModel> Clips { get; } = [];

    [ObservableProperty] private string _ffmpegStatus = "";
    [ObservableProperty] private bool _isBusy;
    [ObservableProperty] private bool _loopOnce = true;
    [ObservableProperty] private bool _loopCountMode;
    [ObservableProperty] private bool _loopDurationMode;
    [ObservableProperty] private int _loopCount = 2;
    [ObservableProperty] private int _loopHours;
    [ObservableProperty] private int _loopMins = 1;
    [ObservableProperty] private int _loopSecs;
    [ObservableProperty] private bool _noAudio;
    [ObservableProperty] private string? _audioPath;
    [ObservableProperty] private string _audioName = "未選擇音訊";
    [ObservableProperty] private bool _useScriptSubs;
    [ObservableProperty] private string _scriptText = "";
    [ObservableProperty] private double _subOffsetSec;
    [ObservableProperty] private string _estimateText = "選擇重複次數或目標時長可自動延長";
    [ObservableProperty] private string _clipsCountText = "尚未加入素材 · 影片可單獨播放";
    [ObservableProperty] private string _statusText = "就緒";
    [ObservableProperty] private double _progress;
    [ObservableProperty] private string _progressText = "0%";
    [ObservableProperty] private string _logText = "";
    [ObservableProperty] private string? _resultPath;
    [ObservableProperty] private bool _hasResult;
    [ObservableProperty] private bool _isDragOver;
    [ObservableProperty] private string _toastText = "";
    [ObservableProperty] private bool _toastVisible;

    public bool CanClear => Clips.Count > 0 && !IsBusy;
    public bool CanMerge => Clips.Count > 0 && Clips.All(c => c.IsReady) && !IsBusy && _locator.IsReady;
    public bool CanClearAudio => !string.IsNullOrEmpty(AudioPath) && !IsBusy;
    public bool HasScript => !string.IsNullOrWhiteSpace(ScriptText);
    public string MergeLabel => UseScriptSubs ? "產生預覽" : "合併為一個影片";

    public void AddFiles(IEnumerable<string> paths)
    {
        var added = 0;
        foreach (var path in paths.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!File.Exists(path) || !MediaKinds.IsMedia(path)) continue;
            if (Clips.Any(c => string.Equals(c.Path, path, StringComparison.OrdinalIgnoreCase)))
                continue;
            var clip = new ClipItemViewModel(this, path, MediaKinds.IsImage(path));
            Clips.Add(clip);
            added++;
            _ = InspectClipAsync(clip);
        }

        if (added > 0)
            Flash($"已加入 {added} 個素材");
    }

    public void PlayClip(ClipItemViewModel clip)
    {
        if (clip.IsImage)
        {
            Flash("圖片沒有可播放的影片");
            return;
        }
        if (!File.Exists(clip.Path))
        {
            Flash("找不到檔案", error: true);
            return;
        }
        _ui.PlayMedia(clip.Path, clip.Name);
    }

    public void MoveClip(ClipItemViewModel clip, int dir)
    {
        if (IsBusy) return;
        var i = Clips.IndexOf(clip);
        var j = i + dir;
        if (i < 0 || j < 0 || j >= Clips.Count) return;
        Clips.Move(i, j);
    }

    public void RemoveClip(ClipItemViewModel clip)
    {
        if (IsBusy) return;
        if (Clips.Remove(clip)) clip.Dispose();
    }

    [RelayCommand]
    private async Task AddMoreAsync()
    {
        var files = await _ui.OpenMediaFilesAsync();
        if (files.Count > 0) AddFiles(files);
    }

    [RelayCommand]
    private void ClearAll()
    {
        if (IsBusy) return;
        foreach (var c in Clips) c.Dispose();
        Clips.Clear();
        ClearAudio();
        ResultPath = null;
        HasResult = false;
        LogText = "";
        Progress = 0;
        ProgressText = "0%";
        StatusText = "就緒";
        Flash("已清除全部素材");
    }

    [RelayCommand]
    private async Task PickAudioAsync()
    {
        var path = await _ui.OpenAudioAsync();
        if (string.IsNullOrWhiteSpace(path)) return;
        AudioPath = path;
        AudioName = System.IO.Path.GetFileName(path);
        if (NoAudio)
        {
            NoAudio = false;
            Flash("已關閉「不要聲音」，以套用自訂音軌");
        }
        else Flash($"已選擇音軌：{AudioName}");
        RefreshEstimate();
    }

    [RelayCommand]
    private void ClearAudio()
    {
        AudioPath = null;
        AudioName = "未選擇音訊";
        RefreshEstimate();
    }

    [RelayCommand]
    private async Task LoadScriptAsync()
    {
        var path = await _ui.OpenTextAsync();
        if (string.IsNullOrWhiteSpace(path)) return;
        ScriptText = await File.ReadAllTextAsync(path);
        UseScriptSubs = true;
        Flash($"已載入稿件：{System.IO.Path.GetFileName(path)}");
    }

    [RelayCommand]
    private void ClearScript()
    {
        ScriptText = "";
        UseScriptSubs = false;
        Flash("已清除語音稿");
    }

    [RelayCommand]
    private async Task PickFfmpegAsync()
    {
        var path = await _ui.OpenFfmpegAsync();
        if (string.IsNullOrWhiteSpace(path)) return;
        if (_locator.UseExplicit(path))
        {
            _settings.FfmpegPath = _locator.FfmpegPath;
            _settings.Save();
            FfmpegStatus = _locator.StatusText;
            Flash("已指定 FFmpeg");
            OnPropertyChanged(nameof(CanMerge));
        }
        else
        {
            Flash("此路徑不是有效的 FFmpeg", error: true);
        }
    }

    [RelayCommand]
    private async Task MergeAsync()
    {
        if (!CanMerge) return;
        if (!_locator.IsReady)
        {
            Flash("請先安裝或指定 FFmpeg", error: true);
            return;
        }

        var suggested = $"merged-{DateTime.Now:yyyy-MM-dd-HH-mm-ss-fff}.mp4";
        var output = await _ui.SaveVideoAsync(suggested);
        if (string.IsNullOrWhiteSpace(output)) return;

        IsBusy = true;
        SetClipBusy(true);
        _mergeCts = new CancellationTokenSource();
        var log = new StringBuilder();
        Progress = 0;
        ProgressText = "0%";
        StatusText = "開始合併…";
        LogText = "";

        try
        {
            var loop = BuildLoopOptions();
            string? srt = null;
            if (UseScriptSubs)
            {
                StatusText = "產生字幕…";
                srt = SubtitleBuilder.BuildSrt(ScriptText, OutputDuration(loop), SubOffsetSec);
            }

            var req = new MergeRequest(
                Clips.Select(c => new MergeClip(c.Path, c.IsImage, ResolveClipDuration(c), c.Width, c.Height)).ToList(),
                NoAudio,
                AudioPath,
                srt,
                loop,
                output);

            var logProg = new Progress<string>(line =>
            {
                log.AppendLine(line);
                LogText = log.ToString();
            });
            var statusProg = new Progress<string>(s => StatusText = s);
            var prog = new Progress<double>(r =>
            {
                Progress = r;
                ProgressText = $"{Math.Round(r * 100)}%";
            });

            await _merge.MergeAsync(req, logProg, statusProg, prog, _mergeCts.Token);

            ResultPath = output;
            HasResult = true;
            StatusText = "合併完成";
            Progress = 1;
            ProgressText = "100%";
            _ui.ShowResult(output);
            Flash("合併完成，可預覽或另存", error: false);
        }
        catch (OperationCanceledException)
        {
            StatusText = "已取消";
            Flash("已取消合併");
        }
        catch (Exception ex)
        {
            StatusText = "合併失敗";
            log.AppendLine(ex.Message);
            LogText = log.ToString();
            Flash(ex.Message, error: true);
        }
        finally
        {
            IsBusy = false;
            SetClipBusy(false);
            _mergeCts?.Dispose();
            _mergeCts = null;
            PersistSettings();
        }
    }

    [RelayCommand]
    private void PlayResult()
    {
        if (!string.IsNullOrWhiteSpace(ResultPath) && File.Exists(ResultPath))
            _ui.PlayMedia(ResultPath, "合併結果");
    }

    [RelayCommand]
    private void OpenResultFolder()
    {
        if (string.IsNullOrWhiteSpace(ResultPath) || !File.Exists(ResultPath)) return;
        _ui.ShowResult(ResultPath);
    }

    partial void OnLoopOnceChanged(bool value)
    {
        if (value)
        {
            LoopCountMode = false;
            LoopDurationMode = false;
        }
        RefreshEstimate();
    }

    partial void OnLoopCountModeChanged(bool value)
    {
        if (value)
        {
            LoopOnce = false;
            LoopDurationMode = false;
        }
        RefreshEstimate();
    }

    partial void OnLoopDurationModeChanged(bool value)
    {
        if (value)
        {
            LoopOnce = false;
            LoopCountMode = false;
        }
        RefreshEstimate();
    }

    partial void OnLoopCountChanged(int value) => RefreshEstimate();
    partial void OnLoopHoursChanged(int value) => RefreshEstimate();
    partial void OnLoopMinsChanged(int value) => RefreshEstimate();
    partial void OnLoopSecsChanged(int value) => RefreshEstimate();
    partial void OnNoAudioChanged(bool value)
    {
        PersistSettings();
        RefreshEstimate();
    }
    partial void OnUseScriptSubsChanged(bool value)
    {
        OnPropertyChanged(nameof(MergeLabel));
        PersistSettings();
    }
    partial void OnScriptTextChanged(string value) => OnPropertyChanged(nameof(HasScript));
    partial void OnIsBusyChanged(bool value)
    {
        OnPropertyChanged(nameof(CanClear));
        OnPropertyChanged(nameof(CanMerge));
        OnPropertyChanged(nameof(CanClearAudio));
    }
    partial void OnAudioPathChanged(string? value) => OnPropertyChanged(nameof(CanClearAudio));

    private async Task InspectClipAsync(ClipItemViewModel clip)
    {
        await _thumbGate.WaitAsync();
        try
        {
            if (!_locator.IsReady && clip.IsImage)
            {
                var bmp = ThumbnailService.LoadScaled(clip.Path, 720);
                long size = 0;
                try { size = new FileInfo(clip.Path).Length; } catch { /* ignore */ }
                var w = bmp?.PixelSize.Width ?? 0;
                var h = bmp?.PixelSize.Height ?? 0;
                clip.MarkReady(0, size, w, h, bmp, bmp);
                RefreshEstimate();
                return;
            }

            if (!_locator.IsReady)
            {
                clip.MarkError("找不到 FFmpeg，無法擷取影格");
                return;
            }

            if (clip.IsImage)
            {
                var bmp = ThumbnailService.LoadScaled(clip.Path, 720);
                long size = 0;
                try { size = new FileInfo(clip.Path).Length; } catch { /* ignore */ }
                var w = bmp?.PixelSize.Width ?? 0;
                var h = bmp?.PixelSize.Height ?? 0;
                try
                {
                    var info = await _probe.ProbeAsync(clip.Path, CancellationToken.None);
                    if (info.Width > 0) w = info.Width;
                    if (info.Height > 0) h = info.Height;
                    if (info.SizeBytes > 0) size = info.SizeBytes;
                }
                catch
                {
                    /* still ok */
                }
                clip.MarkReady(0, size, w, h, bmp, bmp);
            }
            else
            {
                var info = await _probe.ProbeAsync(clip.Path, CancellationToken.None);
                var (first, last) = await _thumbs.ExtractAsync(clip.Path, false, info.DurationSec, CancellationToken.None);
                clip.MarkReady(info.DurationSec, info.SizeBytes, info.Width, info.Height, first, last);
            }
        }
        catch (Exception ex)
        {
            clip.MarkError(ex.Message);
        }
        finally
        {
            _thumbGate.Release();
            RefreshEstimate();
        }
    }

    private void OnClipsChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        Renumber();
        RefreshEstimate();
        OnPropertyChanged(nameof(CanClear));
        OnPropertyChanged(nameof(CanMerge));
    }

    private void Renumber()
    {
        for (var i = 0; i < Clips.Count; i++)
        {
            Clips[i].Order = i + 1;
            Clips[i].CanMoveUp = i > 0;
            Clips[i].CanMoveDown = i < Clips.Count - 1;
            Clips[i].IsBusy = IsBusy;
        }
    }

    private void SetClipBusy(bool busy)
    {
        foreach (var c in Clips) c.IsBusy = busy;
        OnPropertyChanged(nameof(CanClear));
        OnPropertyChanged(nameof(CanMerge));
    }

    private double BaseSequenceDuration()
    {
        if (Clips.Count == 0) return 0;
        var sum = 0d;
        foreach (var c in Clips)
            sum += ResolveClipDuration(c);
        return sum;
    }

    private double ResolveClipDuration(ClipItemViewModel c)
    {
        if (!c.IsImage)
            return c.DurationSec > 0 ? c.DurationSec : 10;
        if (c.DurationSec > 0) return c.DurationSec;
        return FormatUtil.DefaultStillSec;
    }

    private LoopOptions BuildLoopOptions()
    {
        var mode = LoopCountMode ? "count" : LoopDurationMode ? "duration" : "once";
        var target = LoopHours * 3600 + LoopMins * 60 + LoopSecs;
        return new LoopOptions(mode, Math.Max(1, LoopCount), target, BaseSequenceDuration());
    }

    private static double OutputDuration(LoopOptions loop) => loop.Mode switch
    {
        "count" => loop.BaseDurationSec * Math.Max(1, loop.Count),
        "duration" => Math.Max(0.1, loop.TargetSeconds),
        _ => loop.BaseDurationSec,
    };

    private void RefreshEstimate()
    {
        var ready = Clips.Count(c => c.IsReady);
        if (Clips.Count == 0)
            ClipsCountText = "尚未加入素材 · 影片可單獨播放";
        else
        {
            var img = Clips.Count(c => c.IsImage);
            var vid = Clips.Count - img;
            var parts = new List<string>
            {
                $"{Clips.Count} 段",
                $"約 {FormatUtil.Duration(BaseSequenceDuration())}",
                $"就緒 {ready}",
            };
            if (img > 0) parts.Add($"圖 {img}");
            if (vid > 0) parts.Add($"影 {vid}");
            ClipsCountText = string.Join(" · ", parts);
        }

        var baseDur = BaseSequenceDuration();
        var baseLabel = baseDur > 0 ? FormatUtil.Duration(baseDur) : "—";
        if (LoopCountMode)
        {
            var n = Math.Max(1, LoopCount);
            EstimateText = baseDur > 0
                ? $"基底 {baseLabel} × {n} 次 ≈ {FormatUtil.Duration(baseDur * n)}"
                : $"將重複整段序列 {n} 次";
        }
        else if (LoopDurationMode)
        {
            var target = LoopHours * 3600 + LoopMins * 60 + LoopSecs;
            if (target <= 0) EstimateText = "請設定目標時長（時 / 分 / 秒）";
            else if (baseDur > 0)
            {
                var loops = (int)Math.Ceiling(target / baseDur);
                EstimateText = $"基底 {baseLabel} → 循環約 {loops} 次，裁切至 {FormatUtil.Duration(target)}";
            }
            else EstimateText = $"目標時長 {FormatUtil.Duration(target)}";
        }
        else
        {
            EstimateText = baseDur > 0 ? $"輸出約 {baseLabel}" : "選擇重複次數或目標時長可自動延長";
        }

        OnPropertyChanged(nameof(CanMerge));
        PersistSettings();
    }

    private void PersistSettings()
    {
        _settings.FfmpegPath = _locator.FfmpegPath;
        _settings.LoopMode = LoopCountMode ? "count" : LoopDurationMode ? "duration" : "once";
        _settings.LoopCount = LoopCount;
        _settings.LoopHours = LoopHours;
        _settings.LoopMins = LoopMins;
        _settings.LoopSecs = LoopSecs;
        _settings.NoAudio = NoAudio;
        _settings.UseScriptSubs = UseScriptSubs;
        _settings.SubOffsetSec = SubOffsetSec;
        _settings.Save();
    }

    private void Flash(string message, bool error = false)
    {
        ToastText = message;
        ToastVisible = true;
        _ui.Notify(message, error);
        _ = HideToastLaterAsync();
    }

    private async Task HideToastLaterAsync()
    {
        await Task.Delay(3800);
        ToastVisible = false;
    }

    private sealed class NullUi : IUiServices
    {
        public static readonly NullUi Instance = new();
        public Task<IReadOnlyList<string>> OpenMediaFilesAsync() => Task.FromResult<IReadOnlyList<string>>([]);
        public Task<string?> OpenAudioAsync() => Task.FromResult<string?>(null);
        public Task<string?> OpenTextAsync() => Task.FromResult<string?>(null);
        public Task<string?> OpenFfmpegAsync() => Task.FromResult<string?>(null);
        public Task<string?> SaveVideoAsync(string suggestedName) => Task.FromResult<string?>(null);
        public void PlayMedia(string path, string title) { }
        public void ShowResult(string path) { }
        public void Notify(string message, bool error = false) { }
    }
}
