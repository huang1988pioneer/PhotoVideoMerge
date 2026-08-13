#!/usr/bin/env bash
# Package a published folder into a platform zip.
# Usage: package.sh <rid> <asset-name> <publish-dir> <out-dir> [version]
set -euo pipefail

RID="${1:?rid}"
ASSET="${2:?asset}"
SRC="${3:?publish dir}"
OUT="${4:?out dir}"
VERSION="${5:-1.0.0}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="VideoMerge-${VERSION}-${ASSET}"
WORK="$(mktemp -d)"
DEST="$WORK/$NAME"

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$DEST" "$OUT"

if [[ "$RID" == osx-* ]]; then
  APP="$DEST/VideoMerge.app"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp -R "$SRC/." "$APP/Contents/MacOS/"
  cp "$ROOT/VideoMerge.Avalonia/packaging/Info.plist" "$APP/Contents/Info.plist"
  chmod +x "$APP/Contents/MacOS/VideoMerge.Avalonia" || true
else
  cp -R "$SRC/." "$DEST/"
  if [[ "$RID" == linux-* ]]; then
    chmod +x "$DEST/VideoMerge.Avalonia" || true
    cat > "$DEST/VideoMerge.sh" <<'EOF'
#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/VideoMerge.Avalonia" "$@"
EOF
    chmod +x "$DEST/VideoMerge.sh"
  fi
fi

cp "$ROOT/VideoMerge.Avalonia/packaging/README.txt" "$DEST/README.txt"

if command -v python3 >/dev/null 2>&1; then
  PY=python3
else
  PY=python
fi
"$PY" - <<PY
import shutil
shutil.make_archive(r"$OUT/$NAME", "zip", r"$WORK", "$NAME")
print("Wrote $OUT/$NAME.zip")
PY
