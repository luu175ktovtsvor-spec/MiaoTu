#!/bin/sh
# Published alongside the matching native release; never runs during deployment.
set -eu
VERSION=3.1.6
BASE="https://miaoimg.cn/desktop-downloads/updates"
case "$(uname -m)" in
  arm64) DMG="miaoimg-desktop-mac-arm64-${VERSION}.dmg" ;;
  *) DMG="miaoimg-desktop-mac-x64-${VERSION}.dmg" ;;
esac
if [ -w /Applications ]; then TARGET=/Applications; else TARGET="$HOME/Applications"; mkdir -p "$TARGET"; fi
if pgrep -f "$TARGET/妙图.app/Contents/MacOS/妙图" >/dev/null 2>&1; then
  echo "请先保存作品并退出妙图，再运行安装脚本。" >&2
  exit 1
fi
TMP="$(mktemp -d "${TMPDIR:-/tmp}/miaoimg-install.XXXXXX")"
MNT="$TMP/mnt"
STAGE=''
MOUNTED=0
cleanup() {
  code=$?
  trap - EXIT HUP INT TERM
  if [ "$code" -ne 0 ] && [ -n "$STAGE" ] && { [ -e "$STAGE/previous.app" ] || [ -L "$STAGE/previous.app" ]; }; then
    if [ ! -e "$TARGET/妙图.app" ] && [ ! -L "$TARGET/妙图.app" ]; then
      mv "$STAGE/previous.app" "$TARGET/妙图.app" || true
    fi
    if [ -e "$STAGE/previous.app" ] || [ -L "$STAGE/previous.app" ]; then
      echo "原应用仍保留在：$STAGE/previous.app；请勿删除，恢复后再清理。" >&2
      STAGE=''
    fi
  fi
  if [ -n "$STAGE" ]; then rm -rf "$STAGE"; fi
  if [ "$MOUNTED" -eq 0 ] || hdiutil detach "$MNT" >/dev/null 2>&1; then
    rm -rf "$TMP"
  else
    echo "安装镜像尚未卸载，临时目录保留在：$TMP" >&2
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
mkdir -p "$MNT"
echo "正在下载妙图 ${VERSION}（${DMG}）…"
curl -fL --progress-bar "$BASE/$DMG" -o "$TMP/miao.dmg"
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$TMP/miao.dmg" >/dev/null
MOUNTED=1
test -d "$MNT/妙图.app"
STAGE="$(mktemp -d "$TARGET/.miaoimg-install.XXXXXX")"
ditto "$MNT/妙图.app" "$STAGE/new.app"
xattr -cr "$STAGE/new.app" 2>/dev/null || true
if [ -e "$TARGET/妙图.app" ] || [ -L "$TARGET/妙图.app" ]; then
  mv "$TARGET/妙图.app" "$STAGE/previous.app"
fi
mv "$STAGE/new.app" "$TARGET/妙图.app"
echo "安装完成，正在启动妙图 $VERSION …"
open "$TARGET/妙图.app"
