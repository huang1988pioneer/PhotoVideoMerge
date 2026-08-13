namespace VideoMerge.Avalonia.Services;

internal static class AppPaths
{
    public static string AppDataDirectory
    {
        get
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VideoMerge");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    public static string SettingsFile => Path.Combine(AppDataDirectory, "settings.json");

    public static string ThumbDirectory
    {
        get
        {
            var dir = Path.Combine(AppDataDirectory, "thumbs");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    public static string WorkDirectory
    {
        get
        {
            var dir = Path.Combine(Path.GetTempPath(), "VideoMerge");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }
}
