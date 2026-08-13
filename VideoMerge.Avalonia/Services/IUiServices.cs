namespace VideoMerge.Avalonia.Services;

public interface IUiServices
{
    Task<IReadOnlyList<string>> OpenMediaFilesAsync();
    Task<string?> OpenAudioAsync();
    Task<string?> OpenTextAsync();
    Task<string?> OpenFfmpegAsync();
    Task<string?> SaveVideoAsync(string suggestedName);
    void PlayMedia(string path, string title);
    void ShowResult(string path);
    void Notify(string message, bool error = false);
}
