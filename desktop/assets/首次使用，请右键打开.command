#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
source_app="$script_dir/妙图.app"
target_dir="/Applications"
target_app="$target_dir/妙图.app"

show_error() {
  /usr/bin/osascript -e "display dialog \"$1\" with title \"妙图安装\" buttons {\"好\"} default button \"好\" with icon caution" >/dev/null
}

if [[ ! -d "$source_app" ]]; then
  show_error "没有找到妙图应用，请确认已正确打开安装镜像。"
  exit 1
fi

if [[ ! -w "$target_dir" ]]; then
  target_dir="$HOME/Applications"
  target_app="$target_dir/妙图.app"
  mkdir -p "$target_dir"
fi

if /usr/bin/pgrep -f "$target_app/Contents/MacOS/妙图" >/dev/null 2>&1; then
  show_error "妙图正在运行。请先退出妙图，再重新打开此安装程序。"
  exit 1
fi

if [[ -e "$target_app" ]]; then
  trash_dir="$HOME/.Trash"
  backup_app="$trash_dir/妙图-旧版本-$(/bin/date +%Y%m%d-%H%M%S).app"
  mkdir -p "$trash_dir"
  /bin/mv "$target_app" "$backup_app"
fi

/usr/bin/ditto "$source_app" "$target_app"
/usr/bin/xattr -dr com.apple.quarantine "$target_app" 2>/dev/null || true
/usr/bin/open "$target_app"
exit 0
