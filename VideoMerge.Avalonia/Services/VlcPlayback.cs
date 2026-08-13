using LibVLCSharp.Shared;

namespace VideoMerge.Avalonia.Services;

internal sealed class VlcPlayback : IDisposable
{
    private static readonly object Gate = new();
    private static bool _coreReady;
    private static string? _coreError;

    public LibVLC? Lib { get; private set; }

    public static bool TryEnsureCore(out string? error)
    {
        lock (Gate)
        {
            if (_coreReady)
            {
                error = _coreError;
                return _coreError is null;
            }

            try
            {
                Core.Initialize();
                _coreReady = true;
                _coreError = null;
                error = null;
                return true;
            }
            catch (Exception ex)
            {
                _coreReady = true;
                _coreError = ex.Message;
                error = _coreError;
                return false;
            }
        }
    }

    public bool TryCreate(out string? error)
    {
        if (!TryEnsureCore(out error)) return false;
        try
        {
            Lib = new LibVLC("--no-video-title-show", "--quiet");
            error = null;
            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    public void Dispose()
    {
        Lib?.Dispose();
        Lib = null;
    }
}
