#!/usr/bin/env bash
# 把上游画布源码刷新到 本地资料/参考源码/Toonflow-app（仅供本地开发对照）。
# 用法：bash scripts/sync-toonflow-upstream.sh [--check]
#   --check  只报告上游是否有新提交，不改任何文件
set -Eeuo pipefail

UPSTREAM_URL=${UPSTREAM_URL:-https://github.com/HBAI-Ltd/Toonflow-app.git}
ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
VENDOR_DIR="$ROOT_DIR/本地资料/参考源码/Toonflow-app"
# A reference snapshot must remain ignored even on a fresh checkout.
if ! git -C "$ROOT_DIR" check-ignore -q 本地资料/参考源码/Toonflow-app/.upstream-commit; then
  echo "参考目录未被 Git 排除，请先修复 .gitignore。" >&2
  exit 1
fi
mkdir -p "$(dirname -- "$VENDOR_DIR")"
MARKER=".upstream-commit"
TMP_DIR=${TMPDIR:-/tmp}/toonflow-upstream-$$

current=""
[ -f "$VENDOR_DIR/$MARKER" ] && current=$(cut -d' ' -f1 < "$VENDOR_DIR/$MARKER")

echo "拉取上游 $UPSTREAM_URL …"
rm -rf "$TMP_DIR"
git clone --depth 1 --quiet "$UPSTREAM_URL" "$TMP_DIR"
latest=$(git -C "$TMP_DIR" rev-parse HEAD)
when=$(git -C "$TMP_DIR" log -1 --format=%cI)
subject=$(git -C "$TMP_DIR" log -1 --format=%s)

echo "上游最新: $latest ($when)"
echo "本地快照: ${current:-（未记录）}"
if [ "$current" = "$latest" ]; then
  echo "已是最新，无需更新。"
  rm -rf "$TMP_DIR"
  exit 0
fi
if [ "${1:-}" = "--check" ]; then
  echo "有新提交：$subject"
  echo "（加 --check 之外的参数即执行更新）"
  rm -rf "$TMP_DIR"
  exit 0
fi

# 记录旧文件清单，用于更新后给出"新增/删除/改动"摘要
old_list=$(mktemp)
if [ -d "$VENDOR_DIR" ]; then
  (cd "$VENDOR_DIR" && find . -type f -not -name "$MARKER" | sort) > "$old_list"
fi

rm -rf "$VENDOR_DIR"
cp -R "$TMP_DIR" "$VENDOR_DIR"
rm -rf "$VENDOR_DIR/.git"
printf '%s (%s)\n' "$latest" "$when" > "$VENDOR_DIR/$MARKER"

new_list=$(mktemp)
(cd "$VENDOR_DIR" && find . -type f -not -name "$MARKER" | sort) > "$new_list"
echo "--- 与本地旧快照相比 ---"
echo "  新增 $(comm -13 "$old_list" "$new_list" | wc -l | tr -d ' ') 个文件"
echo "  删除 $(comm -23 "$old_list" "$new_list" | wc -l | tr -d ' ') 个文件"
rm -f "$old_list" "$new_list"
rm -rf "$TMP_DIR"
echo "已更新到 $latest。参考源码只保存在本地；按实际功能需要移植，不提交本地资料目录。"
