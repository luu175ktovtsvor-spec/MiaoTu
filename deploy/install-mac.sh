#!/bin/sh
# Standalone official installer; release version and hashes come from the live feed.
set -eu
BASE='https://miaoimg.cn/desktop-downloads/updates'
TARGET=''
LAUNCH=1
VERIFY_ONLY=0
usage() {
  echo '用法：sh install-mac.sh [--verify-only] [--destination /绝对路径] [--no-launch]'
  echo '默认安装到 /Applications（无写权限时使用 ~/Applications），保留账号和项目。'
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify-only) VERIFY_ONLY=1 ;;
    --no-launch) LAUNCH=0 ;;
    --destination) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; TARGET=$1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done
fail() { echo "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail '此安装脚本仅适用于 macOS。'
case "$(uname -m)" in
  arm64) ARCH=arm64; CPU=arm64 ;;
  x86_64)
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then ARCH=arm64; CPU=arm64
    else ARCH=x64; CPU=x86_64; fi ;;
  *) fail '当前芯片架构不受支持。' ;;
esac
if [ -z "$TARGET" ]; then
  if [ -w /Applications ]; then TARGET=/Applications; else TARGET="$HOME/Applications"; fi
fi
case "$TARGET" in /*) ;; *) fail '安装目录必须是绝对路径。' ;; esac
TMP=$(mktemp -d "${TMPDIR:-/tmp}/miaoimg-install.XXXXXX")
MNT="$TMP/mnt"
STAGE=''
MOUNTED=0
REPLACED=0
cleanup() {
  code=$?
  trap - EXIT HUP INT TERM
  if [ "$code" -ne 0 ] && [ "$REPLACED" -eq 0 ] && [ -n "$STAGE" ] && { [ -e "$STAGE/previous.app" ] || [ -L "$STAGE/previous.app" ]; }; then
    if [ ! -e "$TARGET/妙图.app" ] && [ ! -L "$TARGET/妙图.app" ]; then
      mv "$STAGE/previous.app" "$TARGET/妙图.app" || true
    fi
    if [ -e "$STAGE/previous.app" ] || [ -L "$STAGE/previous.app" ]; then
      echo "原应用仍保留在：$STAGE/previous.app；恢复后再清理。" >&2
      STAGE=''
    fi
  fi
  if [ -n "$STAGE" ]; then rm -rf "$STAGE"; fi
  if [ "$MOUNTED" -eq 0 ] || hdiutil detach "$MNT" >/dev/null 2>&1; then rm -rf "$TMP"
  else echo "安装镜像尚未卸载，临时目录保留在：$TMP" >&2; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
curl -fsSL --retry 2 --connect-timeout 15 --max-time 60 "$BASE/latest-mac.yml" -o "$TMP/latest-mac.yml"
VERSION=$(awk '$1 == "version:" { print $2 }' "$TMP/latest-mac.yml" | tr -d "\"'\r")
printf '%s\n' "${VERSION}" | /usr/bin/grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail '无法确认正式版本，未修改现有应用。'
DMG="妙图-${VERSION}-${ARCH}.dmg"
META=$(awk -v target="$DMG" '
  /^[^[:space:]]/ { selected=0 }
  $1 == "-" && $2 == "url:" { name=$3; gsub(/["\047\r]/,"",name); selected=(name==target) }
  selected && $1 == "sha512:" { hash=$2 }
  selected && $1 == "size:" { size=$2 }
  END { print hash; print size }
' "$TMP/latest-mac.yml")
EXPECTED_HASH=$(printf '%s\n' "$META" | sed -n '1p')
EXPECTED_SIZE=$(printf '%s\n' "$META" | sed -n '2p')
[ "${#EXPECTED_HASH}" -eq 88 ] || fail '正式包缺少有效 SHA-512，未修改现有应用。'
case "$EXPECTED_SIZE" in ''|*[!0-9]*) fail '正式包大小无效，未修改现有应用。' ;; esac
APP="$TARGET/妙图.app"
if [ -e "$APP" ] || [ -L "$APP" ]; then
  [ ! -L "$APP" ] || fail '现有应用为符号链接，请先手动确认安装位置。'
  old_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)
  [ "$old_id" = cn.miaoimg.desktop ] || fail '目标目录存在无法识别的应用，未覆盖。'
  OLD=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")
  printf '%s\n' "${OLD}" | /usr/bin/grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail '现有版本号无法核对，未覆盖。'
  awk -v old="${OLD}" -v new="${VERSION}" 'BEGIN { split(old,a,".");split(new,b,".");for(i=1;i<=3;i++){if(a[i]+0>b[i]+0)exit 1;if(a[i]+0<b[i]+0)exit 0} }' || fail "现有版本 ${OLD} 高于正式版本 ${VERSION}，拒绝降级。"
fi
if [ "$VERIFY_ONLY" -eq 0 ] && pgrep -f "$APP/Contents/MacOS/妙图" >/dev/null 2>&1; then
  fail '请先保存作品并退出妙图，再运行安装脚本。'
fi
echo "正在下载并校验妙图 ${VERSION}（${ARCH}）…"
curl -fL --retry 2 --connect-timeout 15 --max-time 900 --progress-bar "$BASE/miaoimg-desktop-mac-${ARCH}-${VERSION}.dmg" -o "$TMP/miao.dmg"
ACTUAL_SIZE=$(wc -c < "$TMP/miao.dmg" | tr -d '[:space:]')
ACTUAL_HASH=$(openssl dgst -sha512 -binary "$TMP/miao.dmg" | openssl base64 -A)
[ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ] && [ "$ACTUAL_HASH" = "$EXPECTED_HASH" ] || fail '下载文件校验失败，未修改现有应用；请重新下载。'
mkdir -p "$MNT"
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$TMP/miao.dmg" >/dev/null
MOUNTED=1
SOURCE="$MNT/妙图.app"
[ -d "$SOURCE" ] || fail '安装镜像中缺少妙图应用。'
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$SOURCE/Contents/Info.plist")" = cn.miaoimg.desktop ] || fail '应用标识不匹配。'
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SOURCE/Contents/Info.plist")" = "${VERSION}" ] || fail '镜像内版本与正式更新源不一致。'
lipo -archs "$SOURCE/Contents/MacOS/妙图" | tr ' ' '\n' | /usr/bin/grep -qx "${CPU}" || fail '镜像内芯片架构不匹配。'
codesign --verify --deep --strict "$SOURCE" || fail '应用完整性检查失败，未安装。'
SIGNED=0
if awk -v version="$VERSION" 'BEGIN { split(version,a,"."); exit !(a[1]>3 || (a[1]==3 && (a[2]>2 || (a[2]==2 && a[3]>=1)))) }'; then
  SIGNED=1
  TEAM=$(codesign -dv --verbose=4 "$SOURCE" 2>&1 | awk -F= '$1 == "TeamIdentifier" { print $2 }')
  [ "$TEAM" = 92Q29PMV22 ] || fail '应用签名团队不匹配，未安装。'
  codesign --verify --strict "$TMP/miao.dmg" || fail '安装镜像签名检查失败。'
  xcrun stapler validate "$TMP/miao.dmg" >/dev/null || fail '安装镜像缺少有效 Apple 公证票据。'
  xcrun stapler validate "$SOURCE" >/dev/null || fail '应用缺少有效 Apple 公证票据。'
  spctl --assess --type open --context context:primary-signature "$TMP/miao.dmg" || fail '系统未接受安装镜像，未安装。'
  spctl --assess --type execute "$SOURCE" || fail '系统未接受应用，未安装。'
fi
if [ "$VERIFY_ONLY" -eq 1 ]; then
  if [ "$SIGNED" -eq 1 ]; then echo "已核对版本、芯片、SHA-512、签名团队、Apple 公证票据和系统评估：${VERSION}（${ARCH}）。尚未安装或验证首次打开。"
  else echo "已核对版本、芯片、文件大小、SHA-512 和应用完整性：${VERSION}（${ARCH}）。尚未安装或验证 Apple 公证。"; fi
  exit 0
fi
mkdir -p "$TARGET"
STAGE=$(mktemp -d "$TARGET/.miaoimg-install.XXXXXX")
ditto "$SOURCE" "$STAGE/new.app"
codesign --verify --deep --strict "$STAGE/new.app" || fail '应用复制后校验失败。'
if [ "$SIGNED" -eq 1 ]; then
  spctl --assess --type execute "$STAGE/new.app" || fail '系统未接受复制后的应用，未安装。'
else
  # Compatibility for historical unsigned packages only.
  xattr -dr com.apple.quarantine "$STAGE/new.app" || fail '无法处理此应用的下载隔离标记，请按官网系统设置说明打开。'
fi
if [ -e "$APP" ]; then mv "$APP" "$STAGE/previous.app"; fi
mv "$STAGE/new.app" "$APP"
REPLACED=1
echo "已安装妙图 ${VERSION}；账号与项目未改动。"
if [ "$LAUNCH" -eq 1 ]; then open "$APP" || fail '应用已安装，但启动失败；请在系统设置→隐私与安全性中查看提示。'; fi
