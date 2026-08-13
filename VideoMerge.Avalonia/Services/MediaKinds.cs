namespace VideoMerge.Avalonia.Services;

internal static class MediaKinds
{
    public static readonly string[] VideoExtensions =
    [
        ".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".wmv", ".mpeg", ".mpg"
    ];

    public static readonly string[] ImageExtensions =
    [
        ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"
    ];

    public static readonly string[] AudioExtensions =
    [
        ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".wma"
    ];

    public static bool IsVideo(string path) =>
        VideoExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

    public static bool IsImage(string path) =>
        ImageExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

    public static bool IsAudio(string path) =>
        AudioExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

    public static bool IsMedia(string path) => IsVideo(path) || IsImage(path);
}
