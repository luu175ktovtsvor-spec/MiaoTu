#!/usr/bin/env bash
set -Eeuo pipefail
# 发布桌面版更新源：已安装的妙图读取 latest.yml（Windows）和 latest-mac.yml（macOS），
# 安装包和官网的正式下载文件名都带版本号；旧的固定别名只用于兼容已有链接。
# 顺序：本地核对 sha512 → 上传到 .staging → 服务器再核对一次 → 安装包落位并更新版本文件名
# → 持共享锁复验并将 latest*.yml 最后落位 → 从公网回读版本。两个平台元数据逐项替换。
VERSION=${1:?用法：DEPLOY_CONFIRM=I-am-the-release-manager bash deploy/publish-desktop-updates.sh <版本号>}
REMOTE_HOST=${REMOTE_HOST:-root}
REMOTE_DIR=${REMOTE_DIR:-/opt/miaoimg/desktop-downloads/updates}
PUBLIC_BASE=${PUBLIC_BASE:-https://miaoimg.cn/desktop-downloads/updates}
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
RELEASE_DIR=$(CDPATH='' cd -- "${MIAO_DESKTOP_RELEASE_DIR:-$SCRIPT_DIR/../desktop/release}" && pwd)
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本号不合法：$VERSION" >&2; exit 2; }
if [ "${DEPLOY_CONFIRM:-}" != "I-am-the-release-manager" ]; then
  echo "拒绝发布：更新源会推给所有已安装的用户，只有发布负责人带口令执行。" >&2
  exit 2
fi

cd "$RELEASE_DIR"
installers=("妙图-$VERSION-arm64.dmg" "妙图-$VERSION-arm64.zip" "妙图-$VERSION-x64.dmg" "妙图-$VERSION-x64.zip" "妙图-$VERSION-Windows-x64.exe")
uploads=("${installers[@]}")
for file in "${installers[@]}"; do
  [ -s "$file" ] || { echo "缺少安装包：$file" >&2; exit 2; }
  [ -s "$file.blockmap" ] && uploads+=("$file.blockmap")
done
sh -n "$SCRIPT_DIR/install-mac.sh"
cp "$SCRIPT_DIR/install-mac.sh" install-mac.sh
uploads+=(install-mac.sh latest-mac.yml latest.yml)

# 元数据里的每个文件都必须存在、版本一致、sha512 与实际字节一致；不一致宁可不发。
VERIFY=$SCRIPT_DIR/verify-update-metadata.py
python3 "$VERIFY" "$VERSION" latest-mac.yml latest.yml

RUN_ID=${MIAO_DESKTOP_RELEASE_RUN_ID:-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')}
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$ ]] || { echo '发布 run id 不合法。' >&2; exit 2; }
staging="$REMOTE_DIR/.staging-$VERSION-$RUN_ID"
echo "本轮发布 run id：${RUN_ID}；续传时设置 MIAO_DESKTOP_RELEASE_RUN_ID=${RUN_ID}"
# 默认每轮隔离；显式沿用 run id 可续传。每轮锁使同一 run 的上传和激活不能同时改 staging。
# 需要绕道时用 RSYNC_RSH 指定 ssh 参数（例如经本机代理）。
printf -v setup_command 'umask 077; mkdir -p %q' "$staging"
ssh "$REMOTE_HOST" "$setup_command"
printf -v rsync_command 'flock -n %q rsync' "$staging/.publish.lock"
rsync -a --partial --checksum --progress --rsync-path="$rsync_command" "${uploads[@]}" "$VERIFY" "$REMOTE_HOST:$staging/"

printf -v activate_command 'bash -s -- %q %q %q' "$staging" "$REMOTE_DIR" "$VERSION"
for file in "${uploads[@]}"; do
  printf -v quoted_file ' %q' "$file"
  activate_command+=$quoted_file
done
ssh "$REMOTE_HOST" "$activate_command" <<'REMOTE'
set -Eeuo pipefail
staging=$1; remote_dir=$2; version=$3; shift 3
uploads=("$@")
# Match the lock order used by API/site publishing. Never replace or remove these shared lock files.
exec 7>"$staging/.publish.lock"
flock -n 7 || { echo '同一 run 正在上传或激活，请稍后续传。' >&2; exit 1; }
exec 8>>/opt/miaoimg/.production-release.lock
flock -x 8
exec 9>>/run/lock/miaoimg-deploy.lock
flock -x 9
cd "$staging"
python3 verify-update-metadata.py "$version" latest-mac.yml latest.yml
# Compare both currently published platforms under the same locks, before changing any public files.
python3 - "$version" "$remote_dir/latest-mac.yml" "$remote_dir/latest.yml" <<'PY'
import os, re, sys
def parsed(value):
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value):
        sys.exit('正式版本号无法核对，拒绝切换更新源。')
    return tuple(map(int, value.split('.')))
requested = parsed(sys.argv[1])
for filename in sys.argv[2:]:
    if not os.path.lexists(filename):
        continue
    with open(filename, encoding='utf-8') as handle:
        match = re.search(r'^version: (.+)$', handle.read(), re.M)
    if not match:
        sys.exit('正式更新源缺少版本号，拒绝切换。')
    current = match.group(1).strip().strip("'\"")
    if parsed(current) > requested:
        sys.exit(f'正式版本 {current} 高于待发布版本 {sys.argv[1]}，拒绝回退。')
PY
# Existing versioned package bytes are immutable, including blockmaps.
for file in "${uploads[@]}"; do
  case "$file" in latest*.yml|install-mac.sh) continue ;; esac
  if [ -e "$remote_dir/$file" ]; then
    cmp -s "$file" "$remote_dir/$file" || { echo "拒绝覆盖已发布文件：$file" >&2; exit 1; }
  fi
done
for file in "${uploads[@]}"; do
  case "$file" in latest*.yml) ;; *) mv -f "$file" "$remote_dir/" ;; esac
done
cd "$remote_dir"
ln -f "妙图-$version-arm64.dmg" "miaoimg-desktop-mac-arm64-$version.dmg"
ln -f "妙图-$version-x64.dmg" "miaoimg-desktop-mac-x64-$version.dmg"
ln -f "妙图-$version-Windows-x64.exe" "miaoimg-desktop-windows-$version.exe"
# Stable names only support existing download links; archives retain the version.
ln -f "妙图-$version-arm64.dmg" miaoimg-desktop-mac-arm64.dmg
ln -f "妙图-$version-x64.dmg" miaoimg-desktop-mac-x64.dmg
ln -f "妙图-$version-Windows-x64.exe" miaoimg-desktop-windows.exe
mv -f "$staging/latest-mac.yml" latest-mac.yml
mv -f "$staging/latest.yml" latest.yml
rm "$staging/verify-update-metadata.py" "$staging/.publish.lock"
rmdir "$staging"
REMOTE

for meta in latest-mac.yml latest.yml; do
  published=$(curl -fsS --max-time 30 "$PUBLIC_BASE/$meta?ts=$(date +%s)" | sed -n 's/^version: //p' | tr -d "'\"")
  [ "$published" = "$VERSION" ] || { echo "公网 $meta 仍是 $published" >&2; exit 1; }
done
for alias in \
  "miaoimg-desktop-mac-arm64-$VERSION.dmg" \
  "miaoimg-desktop-mac-x64-$VERSION.dmg" \
  "miaoimg-desktop-windows-$VERSION.exe" \
  miaoimg-desktop-mac-arm64.dmg \
  miaoimg-desktop-mac-x64.dmg \
  miaoimg-desktop-windows.exe; do
  curl -fsSI --max-time 30 "$PUBLIC_BASE/$alias" > /dev/null || { echo "公网 $alias 无法下载" >&2; exit 1; }
done
echo "更新源已发布：$VERSION"
