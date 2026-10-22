#!/usr/bin/env bash
# 每天给用户媒体目录做一次硬链接快照，并保留最近 N 份。
#
# 为什么用硬链接而不是真复制：工作区媒体的每次写入都是「写到临时文件 → 原子改名」，
# 多项目迁移也是「复制到新路径 → 校验 → 再删旧路径」，都不原地修改已有文件的内容。
# 所以硬链接快照能完整保留快照时刻的每个文件，而额外占用的空间只等于「这之后新增或改过的字节」。
#
# 为什么要做：部署脚本只备份数据库（账号、余额、订单、生成记录、以及媒体索引），
# 媒体字节从来没有任何备份——数据库恢复出来的是「索引 + 当时的磁盘字节」，媒体丢了就真丢了。
#
# 用法：deploy/snapshot-media.sh
# 环境变量：OIP_MEDIA_ROOT（默认 /opt/miaoimg/media）
#           OIP_MEDIA_SNAPSHOT_DIR（默认 /opt/miaoimg/backups/media）
#           OIP_MEDIA_SNAPSHOT_KEEP（默认 7，保留最近几份）
set -Eeuo pipefail

media_root=${OIP_MEDIA_ROOT:-/opt/miaoimg/media}
backup_root=${OIP_MEDIA_SNAPSHOT_DIR:-/opt/miaoimg/backups/media}
data_root=${OIP_DATA_DIR:-/opt/miaoimg/.oip/runtime-data}
ops_status_dir=${OIP_OPS_STATUS_DIR:-$data_root/ops-status}
ops_status_path="$ops_status_dir/media-snapshot.json"
keep=${OIP_MEDIA_SNAPSHOT_KEEP:-7}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$backup_root/$stamp"

write_status() {
  local status=$1 reason=${2:-}
  mkdir -p "$ops_status_dir"
  STATUS_VALUE="$status" STATUS_REASON="$reason" STATUS_MEDIA_ROOT="$media_root" STATUS_SNAPSHOT_ROOT="$backup_root" STATUS_PATH="$ops_status_path" python3 - <<'PY'
import json, os
from datetime import datetime, timezone
from pathlib import Path
path = Path(os.environ['STATUS_PATH'])
value = {
    'status': os.environ['STATUS_VALUE'], 'mediaRoot': os.environ['STATUS_MEDIA_ROOT'],
    'snapshotRoot': os.environ['STATUS_SNAPSHOT_ROOT'], 'updatedAt': datetime.now(timezone.utc).isoformat(),
    'finishedAt': datetime.now(timezone.utc).isoformat() if os.environ['STATUS_VALUE'] != 'running' else None,
    'failureReason': os.environ.get('STATUS_REASON') or None,
    'command': 'systemctl start miaoimg-media-snapshot.service',
}
tmp = path.with_name(path.name + f'.{os.getpid()}.tmp')
tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
os.replace(tmp, path)
PY
}

write_status running
trap 'write_status failed "快照任务失败：${BASH_COMMAND}"' ERR

if [ ! -d "$media_root" ]; then
  echo "媒体目录不存在：$media_root" >&2
  exit 1
fi
case $keep in ''|*[!0-9]*) echo "OIP_MEDIA_SNAPSHOT_KEEP 必须是正整数，收到：$keep" >&2; exit 1 ;; esac
[ "$keep" -ge 1 ] || { echo "至少要保留 1 份快照" >&2; exit 1; }

mkdir -p "$backup_root"
chmod 700 "$backup_root"
avail_before=$(df -Pk "$backup_root" | tail -1 | awk '{print $4}')

if [ -e "$target" ]; then
  echo "这一秒的快照已存在，跳过：$target"
else
  # -a 保留权限与时间戳，-l 硬链接。目标目录不存在时 cp 会自己建。
  cp -al "$media_root" "$target"
  echo "快照完成：$target"
fi

files=$(find "$target" -type f | wc -l)
logical=$(find "$target" -type f -printf '%s\n' 2>/dev/null | awk '{sum+=$1} END {printf "%.1f", sum/1048576}') || logical="?"
avail_now=$(df -Pk "$backup_root" | tail -1 | awk '{print $4}')
used_kb=$(( avail_before - avail_now ))
[ "$used_kb" -lt 0 ] && used_kb=0
echo "  快照内文件数：${files}，逻辑大小：${logical:-?} MiB"
echo "  本次新增占用：$(( used_kb / 1024 )) MiB（硬链接只对「这之后新增或改过的字节」占空间；\"du\" 会把共享的块重复计，所以这里看的是可用空间变化）"

# 只保留最近 $keep 份（目录名是 UTC 时间戳，字典序即时间序）。
# 用 find+sed+sort 而不是 mapfile：mac 自带的 bash 3.2 没有 mapfile，脚本要在两种机器上都能跑。
snapshots=$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d | sed 's#.*/##' | sort -r)
count=$([ -n "$snapshots" ] && printf '%s\n' "$snapshots" | wc -l | tr -d ' ' || echo 0)
if [ "$count" -gt "$keep" ]; then
  printf '%s\n' "$snapshots" | tail -n +$((keep + 1)) | while IFS= read -r old; do
    [ -n "$old" ] || continue
    rm -rf "${backup_root:?}/$old"
    echo "  清理旧快照：$old"
  done
fi

echo "  当前快照份数（含本次）：${count}，保留上限：$keep"
df -h "$backup_root" | tail -1 | awk '{print "  剩余空间：" $4}'

disk_line=$(df -Pk "$backup_root" | tail -1)
disk_total_kb=$(awk '{print $2}' <<<"$disk_line")
disk_used_kb=$(awk '{print $3}' <<<"$disk_line")
disk_free_kb=$(awk '{print $4}' <<<"$disk_line")
media_bytes=$(find "$media_root" -type f -printf '%s\n' 2>/dev/null | awk '{sum+=$1} END {printf "%.0f", sum+0}')
media_files=$(find "$media_root" -type f 2>/dev/null | wc -l | tr -d ' ')
snapshots_json=$(BACKUP_ROOT="$backup_root" python3 - <<'PY'
import json, os
from pathlib import Path
root = Path(os.environ['BACKUP_ROOT'])
items = []
for path in sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name, reverse=True)[:30]:
    try: updated = __import__('datetime').datetime.fromtimestamp(path.stat().st_mtime, __import__('datetime').timezone.utc).isoformat()
    except OSError: updated = None
    items.append({'name': path.name, 'updatedAt': updated})
print(json.dumps(items, ensure_ascii=False))
PY
)
STATUS_PATH="$ops_status_path" STATUS_MEDIA_ROOT="$media_root" STATUS_SNAPSHOT_ROOT="$backup_root" STATUS_MEDIA_BYTES="$media_bytes" STATUS_MEDIA_FILES="$media_files" STATUS_DISK_TOTAL_KB="$disk_total_kb" STATUS_DISK_USED_KB="$disk_used_kb" STATUS_DISK_FREE_KB="$disk_free_kb" STATUS_SNAPSHOTS="$snapshots_json" python3 - <<'PY'
import json, os
from datetime import datetime, timezone
from pathlib import Path
path = Path(os.environ['STATUS_PATH'])
total = int(os.environ.get('STATUS_DISK_TOTAL_KB') or 0) * 1024
used = int(os.environ.get('STATUS_DISK_USED_KB') or 0) * 1024
free = int(os.environ.get('STATUS_DISK_FREE_KB') or 0) * 1024
value = {
    'status': 'success', 'mediaRoot': os.environ['STATUS_MEDIA_ROOT'], 'snapshotRoot': os.environ['STATUS_SNAPSHOT_ROOT'],
    'mediaBytes': int(float(os.environ.get('STATUS_MEDIA_BYTES') or 0)), 'mediaFiles': int(os.environ.get('STATUS_MEDIA_FILES') or 0),
    'disk': {'totalBytes': total, 'usedBytes': used, 'freeBytes': free, 'usagePercent': round(used / total * 1000) / 10 if total else None},
    'snapshots': json.loads(os.environ.get('STATUS_SNAPSHOTS') or '[]'), 'latestAt': None,
    'updatedAt': datetime.now(timezone.utc).isoformat(), 'finishedAt': datetime.now(timezone.utc).isoformat(),
    'command': 'systemctl start miaoimg-media-snapshot.service',
}
if value['snapshots']:
    latest = value['snapshots'][0]['name']
    try:
        from datetime import datetime
        value['latestAt'] = datetime.strptime(latest, '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc).isoformat()
    except ValueError:
        value['latestAt'] = value['snapshots'][0].get('updatedAt') or latest
tmp = path.with_name(path.name + f'.{os.getpid()}.tmp')
tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
os.replace(tmp, path)
PY
