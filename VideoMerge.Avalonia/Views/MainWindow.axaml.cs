using System.Diagnostics;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Platform.Storage;
using VideoMerge.Avalonia.Services;
using VideoMerge.Avalonia.ViewModels;

namespace VideoMerge.Avalonia.Views;

public partial class MainWindow : Window, IUiServices
{
    public MainWindow()
    {
        InitializeComponent();
        AddHandler(DragDrop.DragOverEvent, OnDragOver);
        AddHandler(DragDrop.DropEvent, OnDrop);
    }

    private void OnDropZonePressed(object? sender, PointerPressedEventArgs e)
    {
        if (DataContext is MainViewModel vm && vm.AddMoreCommand.CanExecute(null))
            vm.AddMoreCommand.Execute(null);
    }

    private void OnDragOver(object? sender, DragEventArgs e)
    {
        e.DragEffects = e.Data.Contains(DataFormats.Files)
            ? DragDropEffects.Copy
            : DragDropEffects.None;
    }

    private void OnDrop(object? sender, DragEventArgs e)
    {
        if (DataContext is not MainViewModel vm) return;
        if (!e.Data.Contains(DataFormats.Files)) return;
        var files = e.Data.GetFiles();
        if (files is null) return;
        var paths = files
            .Select(f => f.TryGetLocalPath())
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Cast<string>()
            .ToList();
        if (paths.Count > 0) vm.AddFiles(paths);
    }

    public async Task<IReadOnlyList<string>> OpenMediaFilesAsync()
    {
        var files = await StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "選擇影片或圖片",
            AllowMultiple = true,
            FileTypeFilter =
            [
                new FilePickerFileType("影片與圖片")
                {
                    Patterns =
                    [
                        "*.mp4", "*.webm", "*.mov", "*.mkv", "*.avi", "*.m4v",
                        "*.jpg", "*.jpeg", "*.png", "*.gif", "*.webp", "*.bmp"
                    ]
                },
                new FilePickerFileType("影片")
                {
                    Patterns = ["*.mp4", "*.webm", "*.mov", "*.mkv", "*.avi", "*.m4v"]
                },
                new FilePickerFileType("圖片")
                {
                    Patterns = ["*.jpg", "*.jpeg", "*.png", "*.gif", "*.webp", "*.bmp"]
                },
            ],
        });
        return LocalPaths(files);
    }

    public async Task<string?> OpenAudioAsync()
    {
        var files = await StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "選擇音訊",
            AllowMultiple = false,
            FileTypeFilter =
            [
                new FilePickerFileType("音訊")
                {
                    Patterns = ["*.mp3", "*.wav", "*.m4a", "*.aac", "*.ogg", "*.flac"]
                }
            ],
        });
        return LocalPaths(files).FirstOrDefault();
    }

    public async Task<string?> OpenTextAsync()
    {
        var files = await StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "選擇稿件",
            AllowMultiple = false,
            FileTypeFilter =
            [
                new FilePickerFileType("文字 / 字幕")
                {
                    Patterns = ["*.txt", "*.srt", "*.vtt"]
                }
            ],
        });
        return LocalPaths(files).FirstOrDefault();
    }

    public async Task<string?> OpenFfmpegAsync()
    {
        var files = await StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "指定 ffmpeg.exe",
            AllowMultiple = false,
            FileTypeFilter =
            [
                new FilePickerFileType("FFmpeg") { Patterns = ["ffmpeg.exe", "ffmpeg"] }
            ],
        });
        return LocalPaths(files).FirstOrDefault();
    }

    public async Task<string?> SaveVideoAsync(string suggestedName)
    {
        var file = await StorageProvider.SaveFilePickerAsync(new FilePickerSaveOptions
        {
            Title = "儲存合併影片",
            SuggestedFileName = suggestedName,
            DefaultExtension = "mp4",
            FileTypeChoices =
            [
                new FilePickerFileType("MP4 影片") { Patterns = ["*.mp4"] }
            ],
        });
        return file?.TryGetLocalPath();
    }

    public void PlayMedia(string path, string title)
    {
        var player = new PlayerWindow(path, title);
        player.Show(this);
    }

    public void ShowResult(string path)
    {
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"")
            {
                UseShellExecute = true,
            });
        }
        catch
        {
            /* ignore */
        }
    }

    public void Notify(string message, bool error = false)
    {
        Title = error ? $"VideoMerge · {message}" : "VideoMerge · 桌面版";
    }

    private static List<string> LocalPaths(IReadOnlyList<IStorageFile> files) =>
        files.Select(f => f.TryGetLocalPath())
            .Where(p => !string.IsNullOrWhiteSpace(p))
            .Cast<string>()
            .ToList();
}
