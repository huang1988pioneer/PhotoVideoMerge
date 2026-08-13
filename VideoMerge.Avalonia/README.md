# VideoMerge 桌面版（Avalonia）

瀏覽器版的桌面對應：本機 FFmpeg 合併、片段首尾幀、每段可單獨播放。

## 下載

正式包見倉庫 [Releases](https://github.com/huang1988pioneer/PhotoVideoMerge/releases)：Windows x64、macOS Intel / Apple Silicon、Linux x64。zip 為 self-contained，不必安裝 .NET。

需要系統上的 `ffmpeg` / `ffprobe`。

## 從原始碼啟動

- 專案根目錄雙擊 `start-desktop.bat`
- 或 `dotnet run --project VideoMerge.Avalonia -c Release`

需要 .NET 8 SDK。

推送 `v*` 標籤會觸發 GitHub Actions，建置並上傳各平台 zip。
