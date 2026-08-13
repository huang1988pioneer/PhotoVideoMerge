using Avalonia.Media.Imaging;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using VideoMerge.Avalonia.Services;

namespace VideoMerge.Avalonia.ViewModels;

public partial class ClipItemViewModel : ViewModelBase, IDisposable
{
    private readonly MainViewModel _owner;

    public ClipItemViewModel(MainViewModel owner, string path, bool isImage)
    {
        _owner = owner;
        Path = path;
        Name = System.IO.Path.GetFileName(path);
        IsImage = isImage;
        Status = isImage ? "正在讀取圖片…" : "正在擷取首尾幀…";
        KindTag = isImage ? "圖片" : "";
    }

    public string Path { get; }
    public string Name { get; }
    public bool IsImage { get; }
    public string KindTag { get; }

    [ObservableProperty] private int _order;
    [ObservableProperty] private string _status = "";
    [ObservableProperty] private bool _isError;
    [ObservableProperty] private bool _isReady;
    [ObservableProperty] private bool _isBusy;
    [ObservableProperty] private double _durationSec;
    [ObservableProperty] private long _sizeBytes;
    [ObservableProperty] private int _width;
    [ObservableProperty] private int _height;
    [ObservableProperty] private Bitmap? _firstFrame;
    [ObservableProperty] private Bitmap? _lastFrame;
    [ObservableProperty] private bool _canMoveUp;
    [ObservableProperty] private bool _canMoveDown;

    public bool ShowLastFrame => !IsImage;
    public bool CanPlay => !IsImage && File.Exists(Path);

    public string StatsText
    {
        get
        {
            var dur = IsImage
                ? (DurationSec > 0 ? FormatUtil.Duration(DurationSec) : $"靜態 {FormatUtil.DefaultStillSec:0}s")
                : FormatUtil.Duration(DurationSec);
            var size = FormatUtil.Bytes(SizeBytes);
            var dim = Width > 0 && Height > 0
                ? $"{Width}×{Height} · {FormatUtil.OrientationLabel(Width, Height)}"
                : "—";
            return $"{dur}  ·  {size}  ·  {dim}";
        }
    }

    public void MarkReady(double duration, long size, int w, int h, Bitmap? first, Bitmap? last)
    {
        DurationSec = duration;
        SizeBytes = size;
        Width = w;
        Height = h;
        var oldFirst = FirstFrame;
        var oldLast = LastFrame;
        FirstFrame = first;
        LastFrame = last;
        if (!ReferenceEquals(oldFirst, first)) oldFirst?.Dispose();
        if (!ReferenceEquals(oldLast, last)) oldLast?.Dispose();
        IsReady = true;
        IsError = false;
        Status = IsImage
            ? $"圖片就緒 · {FormatUtil.OrientationLabel(w, h)}"
            : $"首尾幀就緒 · 可播放 · {FormatUtil.OrientationLabel(w, h)}";
        OnPropertyChanged(nameof(StatsText));
        OnPropertyChanged(nameof(CanPlay));
    }

    public void MarkError(string message)
    {
        IsError = true;
        IsReady = false;
        Status = message;
    }

    [RelayCommand]
    private void Play() => _owner.PlayClip(this);

    [RelayCommand]
    private void MoveUp() => _owner.MoveClip(this, -1);

    [RelayCommand]
    private void MoveDown() => _owner.MoveClip(this, 1);

    [RelayCommand]
    private void Remove() => _owner.RemoveClip(this);

    public void Dispose()
    {
        FirstFrame?.Dispose();
        LastFrame?.Dispose();
        FirstFrame = null;
        LastFrame = null;
    }
}
