using System.Diagnostics;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Threading;
using LibVLCSharp.Shared;
using VideoMerge.Avalonia.Services;

namespace VideoMerge.Avalonia.Views;

public partial class PlayerWindow : Window
{
    private readonly string _path;
    private VlcPlayback? _vlc;
    private MediaPlayer? _player;
    private Media? _media;
    private bool _scrubbing;
    private readonly DispatcherTimer _timer;

    public PlayerWindow() : this("", "播放")
    {
    }

    public PlayerWindow(string path, string title)
    {
        _path = path;
        InitializeComponent();
        Title = "播放 · " + title;
        _timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(200) };
        _timer.Tick += (_, _) => RefreshClock();
        Opened += OnOpened;
        Closed += (_, _) => Cleanup();
    }

    private void OnOpened(object? sender, EventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_path) || !File.Exists(_path))
            return;

        _vlc = new VlcPlayback();
        if (!_vlc.TryCreate(out var error) || _vlc.Lib is null)
        {
            Fallback(error);
            return;
        }

        try
        {
            _player = new MediaPlayer(_vlc.Lib);
            VideoView.MediaPlayer = _player;
            _media = new Media(_vlc.Lib, _path, FromType.FromPath);
            _player.EndReached += (_, _) => Dispatcher.UIThread.Post(() =>
            {
                PlayPauseButton.Content = "播放";
            });
            _player.Play(_media);
            PlayPauseButton.Content = "暫停";
            _timer.Start();
        }
        catch (Exception ex)
        {
            Fallback(ex.Message);
        }
    }

    private void Fallback(string? reason)
    {
        FallbackHint.IsVisible = true;
        FallbackHint.Text = string.IsNullOrWhiteSpace(reason)
            ? "無法內嵌播放，已改用系統播放器"
            : $"無法內嵌播放（{reason}），已改用系統播放器";
        try
        {
            Process.Start(new ProcessStartInfo(_path) { UseShellExecute = true });
        }
        catch
        {
            FallbackHint.Text = "無法播放此檔案";
        }
    }

    private void OnPlayPause(object? sender, RoutedEventArgs e)
    {
        if (_player is null) return;
        if (_player.IsPlaying)
        {
            _player.Pause();
            PlayPauseButton.Content = "播放";
        }
        else
        {
            _player.Play();
            PlayPauseButton.Content = "暫停";
        }
    }

    private void OnSeekStart(object? sender, PointerPressedEventArgs e) => _scrubbing = true;

    private void OnSeekEnd(object? sender, PointerReleasedEventArgs e)
    {
        if (_player is not null && SeekSlider.Maximum > 0)
            _player.Time = (long)SeekSlider.Value;
        _scrubbing = false;
    }

    private void OnStop(object? sender, RoutedEventArgs e)
    {
        _player?.Stop();
        PlayPauseButton.Content = "播放";
        SeekSlider.Value = 0;
    }

    private void RefreshClock()
    {
        if (_player is null) return;
        var len = _player.Length;
        var t = _player.Time;
        if (len > 0 && !_scrubbing)
        {
            SeekSlider.Maximum = len;
            SeekSlider.Value = Math.Clamp(t, 0, len);
        }
        TimeLabel.Text = $"{Fmt(t)} / {Fmt(len > 0 ? len : 0)}";
    }

    private static string Fmt(long ms)
    {
        if (ms < 0) ms = 0;
        var ts = TimeSpan.FromMilliseconds(ms);
        return ts.TotalHours >= 1
            ? ts.ToString(@"h\:mm\:ss")
            : ts.ToString(@"m\:ss");
    }

    private void Cleanup()
    {
        _timer.Stop();
        try { _player?.Stop(); } catch { /* ignore */ }
        _player?.Dispose();
        _media?.Dispose();
        _vlc?.Dispose();
        _player = null;
        _media = null;
        _vlc = null;
    }
}
