using System.Text.Json;

namespace VideoMerge.Avalonia.Services;

internal sealed class AppSettings
{
    public string? FfmpegPath { get; set; }
    public string LoopMode { get; set; } = "once";
    public int LoopCount { get; set; } = 2;
    public int LoopHours { get; set; }
    public int LoopMins { get; set; } = 1;
    public int LoopSecs { get; set; }
    public bool NoAudio { get; set; }
    public bool UseScriptSubs { get; set; }
    public double SubOffsetSec { get; set; }

    public static AppSettings Load()
    {
        try
        {
            if (!File.Exists(AppPaths.SettingsFile)) return new AppSettings();
            var json = File.ReadAllText(AppPaths.SettingsFile);
            return JsonSerializer.Deserialize<AppSettings>(json) ?? new AppSettings();
        }
        catch
        {
            return new AppSettings();
        }
    }

    public void Save()
    {
        try
        {
            var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(AppPaths.SettingsFile, json);
        }
        catch
        {
            /* ignore */
        }
    }
}
