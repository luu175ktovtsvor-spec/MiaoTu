#!/usr/bin/env bash
set -Eeuo pipefail
# 发布桌面版更新源：已安装的妙图读取 latest.yml（Windows）和 latest-mac.yml（macOS），
# 官网下载按钮和 install-mac.sh 使用固定文件名 miaoimg-desktop-*。
# 顺序：本地核对 sha512 → 上传到 .staging → 服务器再核对一次 → 安装包落位并更新固定文件名
# → latest*.yml 最后落位 → 从公网回读版本。中途中断时线上仍指向旧版本。
VERSION=${1:?用法：DEPLOY_CONFIRM=I-am-the-release-manager bash deploy/publish-desktop-updates.sh <版本号>}
REMOTE_HOST=${REMOTE_HOST:-root}
REMOTE_DIR=${REMOTE_DIR:-/opt/miaoimg/desktop-downloads/updates}
PUBLIC_BASE=${PUBLIC_BASE:-https://miaoimg.cn/desktop-downloads/updates}
RELEASE_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/../desktop/release" && pwd)
case "$VERSION" in *[!0-9.]*|'') echo "版本号不合法：$VERSION" >&2; exit 2 ;; esac
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
uploads+=(latest-mac.yml latest.yml)

# 元数据里的每个文件都必须存在、版本一致、sha512 与实际字节一致；不一致宁可不发。
VERIFY=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/verify-update-metadata.py
python3 "$VERIFY" "$VERSION" latest-mac.yml latest.yml

staging="$REMOTE_DIR/.staging-$VERSION"
ssh "$REMOTE_HOST" "rm -rf '$staging' && mkdir -p '$staging'"
rsync -a --progress "${uploads[@]}" "$REMOTE_HOST:$staging/"
ssh "$REMOTE_HOST" "cd '$staging' && python3 - '$VERSION' latest-mac.yml latest.yml" < "$VERIFY"

ssh "$REMOTE_HOST" "set -e; cd '$staging'
for file in ${uploads[*]}; do case \"\$file\" in latest*.yml) ;; *) mv -f \"\$file\" '$REMOTE_DIR/' ;; esac; done
cd '$REMOTE_DIR'
ln -f '妙图-$VERSION-arm64.dmg' miaoimg-desktop-mac-arm64.dmg
ln -f '妙图-$VERSION-x64.dmg' miaoimg-desktop-mac-x64.dmg
ln -f '妙图-$VERSION-Windows-x64.exe' miaoimg-desktop-windows.exe
mv -f '$staging/latest-mac.yml' latest-mac.yml
mv -f '$staging/latest.yml' latest.yml
rmdir '$staging'"

for meta in latest-mac.yml latest.yml; do
  published=$(curl -fsS --max-time 30 "$PUBLIC_BASE/$meta?ts=$(date +%s)" | sed -n 's/^version: //p' | tr -d "'\"")
  [ "$published" = "$VERSION" ] || { echo "公网 $meta 仍是 $published" >&2; exit 1; }
done
for alias in miaoimg-desktop-mac-arm64.dmg miaoimg-desktop-mac-x64.dmg miaoimg-desktop-windows.exe; do
  curl -fsSI --max-time 30 "$PUBLIC_BASE/$alias" > /dev/null || { echo "公网 $alias 无法下载" >&2; exit 1; }
done
echo "更新源已发布：$VERSION"
