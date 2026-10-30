#!/usr/bin/env bash
# Start an isolated acceptance container from a production-data copy.
# Production data is never mounted into the container: SQLite is backed up into
# a temporary directory, and media is hard-linked there and mounted read-only.
set -Eeuo pipefail

# Docker-era entry for the retired US MiaoImg host. The mainland service runs
# natively (deploy/native/README.md); never fall back to an implicit host.
if [[ -z ${REMOTE_HOST:-} ]]; then
  echo '旧 Docker 候选入口：妙图已迁往大陆原生服务，请按 deploy/native/README.md 操作；确需使用时显式设置 REMOTE_HOST。' >&2
  exit 2
fi
IMAGE_REF=${IMAGE_REF:-}
ACC_NAME=${ACC_NAME:-}
WEB_PORT=${ACC_WEB_PORT:-4383}
IMAGE_PORT=${ACC_IMAGE_PORT:-4385}
API_PORT=${ACC_API_PORT:-4386}
ADMIN_PORT=${ACC_ADMIN_PORT:-4384}
MODE=start

usage() {
  cat <<'USAGE'
用法：
  deploy/acceptance-container.sh [--image miaoimg:<tag>] [--name miaoimg-acc-<时间戳>]
  deploy/acceptance-container.sh --down [miaoimg-acc-<时间戳>]

启动默认使用服务器上当前 miaoimg 容器的镜像；发布前验收新镜像时请显式给 --image。
WEB/API/ADMIN 端口只绑定生产机 127.0.0.1；成功后用输出的 ssh -L 命令在本地浏览器打开。
USAGE
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --image) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; IMAGE_REF=$1 ;;
    --name) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; ACC_NAME=$1 ;;
    --down) MODE=down; shift; if [ "$#" -gt 0 ] && [[ "$1" != -* ]]; then ACC_NAME=$1; shift; fi; continue ;;
    --host) shift; [ "$#" -gt 0 ] || { usage >&2; exit 2; }; REMOTE_HOST=$1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
case "$REMOTE_HOST" in *[!A-Za-z0-9_.@:-]*) echo "REMOTE_HOST 含有不安全字符" >&2; exit 2 ;; esac
case "$IMAGE_REF" in *[!A-Za-z0-9_./:@-]*) echo "镜像引用含有不安全字符" >&2; exit 2 ;; esac
if [ -n "$ACC_NAME" ]; then
  case "$ACC_NAME" in *[!A-Za-z0-9_.-]*) echo "容器名含有不安全字符" >&2; exit 2 ;; esac
fi
for port in "$WEB_PORT" "$IMAGE_PORT" "$API_PORT" "$ADMIN_PORT"; do
  case "$port" in ''|*[!0-9]*) echo "端口必须是数字：$port" >&2; exit 2 ;; esac
done

if [ "$MODE" = down ]; then
  ssh -o BatchMode=yes -- "$REMOTE_HOST" bash -s -- "$ACC_NAME" <<'REMOTE'
set -Eeuo pipefail
name=${1:-}
root_base=/opt/miaoimg/acceptance
remove_one() {
  local target=$1 root="$root_base/$1"
  if docker inspect "$target" >/dev/null 2>&1; then
    docker rm -f "$target" >/dev/null
    echo "已删除容器：$target"
  fi
  if [ -e "$root" ]; then
    rm -rf -- "$root"
    echo "已删除临时目录：$root"
  fi
  if docker inspect "$target" >/dev/null 2>&1 || [ -e "$root" ]; then
    echo "清理断言失败：$target 或 $root 仍存在" >&2
    return 1
  fi
  if [ -d "$root_base" ]; then
    rmdir "$root_base" 2>/dev/null || true
  fi
  echo "清理断言通过：$target 与 $root 均不存在"
}
if [ -n "$name" ]; then
  case "$name" in miaoimg-acc-*) remove_one "$name" ;; *) echo "只允许清理 miaoimg-acc-*" >&2; exit 2 ;; esac
else
  found=0
  names=$(docker ps -a --format '{{.Names}}')
  while IFS= read -r target; do
    case "$target" in miaoimg-acc-*) found=1; remove_one "$target" ;; esac
  done <<< "$names"
  for root in "$root_base"/miaoimg-acc-*; do
    [ -e "$root" ] || continue
    target=${root##*/}
    found=1
    remove_one "$target"
  done
  if [ -d "$root_base" ]; then
    rmdir "$root_base" 2>/dev/null || true
  fi
  [ "$found" -eq 1 ] || echo "没有发现待清理的 miaoimg-acc-* 容器或目录"
fi
REMOTE
  exit $?
fi

if [ -z "$ACC_NAME" ]; then ACC_NAME="miaoimg-acc-$(date -u +%Y%m%dT%H%M%SZ)"; fi
case "$ACC_NAME" in miaoimg-acc-*) ;; *) echo "容器名必须以 miaoimg-acc- 开头" >&2; exit 2 ;; esac

IMAGE_ARGUMENT=${IMAGE_REF:-__AUTO__}
ssh -o BatchMode=yes -- "$REMOTE_HOST" bash -s -- "$IMAGE_ARGUMENT" "$ACC_NAME" "$WEB_PORT" "$IMAGE_PORT" "$API_PORT" "$ADMIN_PORT" "$REMOTE_HOST" <<'REMOTE'
set -Eeuo pipefail
image=${1:-}
name=$2
web_port=$3
image_port=$4
api_port=$5
admin_port=$6
remote_host=$7
root_base=/opt/miaoimg/acceptance
root="$root_base/$name"
production_db=/opt/miaoimg/.oip/runtime-data/management.sqlite
production_media=/opt/miaoimg/media

if [ "$image" = __AUTO__ ]; then
  image=$(docker inspect miaoimg --format '{{.Config.Image}}')
fi
docker image inspect "$image" >/dev/null
if docker inspect "$name" >/dev/null 2>&1 || [ -e "$root" ]; then
  echo "验收实例已存在，先运行：deploy/acceptance-container.sh --down $name" >&2
  exit 2
fi
[ -r "$production_db" ] || { echo "生产库不可读：$production_db" >&2; exit 1; }
[ -d "$production_media" ] || { echo "生产媒体目录不可读：$production_media" >&2; exit 1; }

mkdir -p "$root/data" "$root/media"
chmod 700 "$root" "$root/data" "$root/media"
# SQLite online backup: the source remains the live production database and the
# destination is a separate file. No production file is mounted below.
sqlite3 "$production_db" ".backup '$root/data/management.sqlite'"
chown -R 1000:1000 "$root/data"
# Hard links save space, but share production inodes. The read-only bind mount
# below is mandatory: never write through these links.
cp -al "$production_media"/. "$root/media"/
chown 1000:1000 "$root/media"

production_counts=$(python3 - "$production_db" <<'PY'
import sqlite3, sys
path = sys.argv[1]
con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
def count(table):
    try: return con.execute(f"select count(*) from {table}").fetchone()[0]
    except sqlite3.Error: return None
print(f"users={count('users')} generations={count('generations')} workspace_files={count('workspace_files')}")
con.close()
PY
)
copy_counts=$(python3 - "$root/data/management.sqlite" <<'PY'
import sqlite3, sys
path = sys.argv[1]
con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
def count(table):
    try: return con.execute(f"select count(*) from {table}").fetchone()[0]
    except sqlite3.Error: return None
print(f"users={count('users')} generations={count('generations')} workspace_files={count('workspace_files')}")
con.close()
PY
)
media_files=$(python3 - "$root/media" <<'PY'
import os, sys
n = 0
for current, _, names in os.walk(sys.argv[1]): n += len(names)
print(n)
PY
)

# Capture the live public catalog before starting the candidate. This is a
# read-only comparison target for the later request; it is removed with the
# acceptance directory and never becomes a container mount.
curl -fsS --max-time 10 http://127.0.0.1:4176/api/catalog -o "$root/production-catalog.json"

echo "=== acceptance instance ==="
echo "容器名             : $name"
echo "镜像               : $image"
echo "数据库副本         : $root/data/management.sqlite（源：$production_db；SQLite .backup）"
echo "生产库只读计数     : $production_counts"
echo "副本只读计数       : $copy_counts"
echo "媒体硬链接副本     : $root/media（$media_files 个文件；同 inode，容器内只读）"
echo "宿主机端口         : 127.0.0.1:$web_port / $image_port / $api_port / $admin_port"

failed_cleanup() {
  code=$?
  if [ "$code" -ne 0 ]; then
    echo "验收启动失败，清理临时容器和目录：$name" >&2
    docker rm -f "$name" >/dev/null 2>&1 || true
    rm -rf -- "$root"
  fi
  return "$code"
}
trap failed_cleanup EXIT

docker run --detach \
  --name "$name" \
  --restart no \
  --user 1000:1000 \
  --workdir /app \
  --publish "127.0.0.1:$web_port:4173" \
  --publish "127.0.0.1:$image_port:4175" \
  --publish "127.0.0.1:$api_port:4176" \
  --publish "127.0.0.1:$admin_port:4184" \
  --mount "type=bind,src=$root/data,dst=/app/data" \
  --mount "type=bind,src=$root/media,dst=/app/media,readonly" \
  --mount "type=bind,src=/opt/miaoimg/db,dst=/app/db,readonly" \
  --mount "type=bind,src=/opt/miaoimg/images,dst=/app/images,readonly" \
  --mount "type=bind,src=/opt/miaoimg/previews,dst=/app/previews,readonly" \
  --env NODE_ENV=production \
  --env ENABLE_MODEL_CALLS=false \
  --env OIP_WEB_HOST=0.0.0.0 \
  --env OIP_WEB_PORT=4173 \
  --env OIP_IMAGE_API_HOST=0.0.0.0 \
  --env OIP_IMAGE_API_PORT=4175 \
  --env OIP_API_HOST=0.0.0.0 \
  --env OIP_API_PORT=4176 \
  --env OIP_ADMIN_HOST=0.0.0.0 \
  --env OIP_ADMIN_LOCAL_ONLY=false \
  --env OIP_ADMIN_PORT=4184 \
  --env OIP_DATA_DIR=/app/data \
  --env OIP_MANAGEMENT_DB=/app/data/management.sqlite \
  --env OIP_MEDIA_ROOT=/app/media \
  --env OIP_DB_PATH=/app/data/prompts.db \
  --env OIP_DB_ARCHIVE_PATH=/app/db/prompts.db.gz \
  --env OIP_STARTUP_TIMEOUT=120 \
  --entrypoint npm \
  "$image" --prefix web run preview >/dev/null

ready=0
attempt=1
while [ "$attempt" -le 90 ]; do
  web_code=000
  image_code=000
  api_code=000
  if web_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$web_port/"); then :; else web_code=000; fi
  if image_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$image_port/health"); then :; else image_code=000; fi
  if api_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$api_port/health"); then :; else api_code=000; fi
  if [ "$web_code" = 200 ] && [ "$image_code" = 200 ] && [ "$api_code" = 200 ]; then ready=1; break; fi
  sleep 2
  attempt=$((attempt + 1))
done
[ "$ready" -eq 1 ] || { echo "验收容器未就绪；请在服务器上只读查看 docker logs $name" >&2; exit 1; }

health=$(docker inspect "$name" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
health_attempt=1
while [ "$health" = starting ] && [ "$health_attempt" -le 30 ]; do
  sleep 2
  health=$(docker inspect "$name" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
  health_attempt=$((health_attempt + 1))
done
media_rw=$(docker inspect "$name" --format '{{range .Mounts}}{{if eq .Destination "/app/media"}}{{.RW}}{{end}}{{end}}')
echo "=== readiness ==="
echo "首页 HTTP         : $web_code"
echo "图片 API /health  : $image_code"
echo "档案 API /health  : $api_code"
echo "容器 HEALTHCHECK  : $health"
[ "$health" != unhealthy ] || { echo "验收容器 HEALTHCHECK 为 unhealthy" >&2; exit 1; }
echo "媒体挂载 RW       : $media_rw（必须是 false）"
[ "$media_rw" = false ] || { echo "媒体不是只读挂载，拒绝继续" >&2; exit 1; }

catalog_path="$root/catalog.json"
curl -fsS --max-time 10 "http://127.0.0.1:$api_port/api/catalog" -o "$catalog_path"
python3 - "$catalog_path" "$root/production-catalog.json" "$production_counts" <<'PY'
import json, sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
production = json.load(open(sys.argv[2], encoding="utf-8"))
stats = payload.get("stats", {})
production_stats = production.get("stats", {})
keys = ["prompts", "images", "videos"]
served = {key: stats.get(key, 0) for key in keys}
live = {key: production_stats.get(key, 0) for key in keys}
print("=== real-data read-only request ===")
print("GET /api/catalog      : 200")
print("live production stats : %s" % live)
print("acceptance stats      : %s" % served)
print("stats_match           : %s" % (served == live))
print("说明                 : 验收请求与启动前生产只读请求对照；未调用生图、未修改生产库或媒体。")
print("production management : %s" % sys.argv[3])
PY

echo "=== access ==="
echo "浏览器地址           : http://127.0.0.1:$web_port/"
echo "SSH 隧道             : ssh -N -L $web_port:127.0.0.1:$web_port $remote_host"
echo "清理命令             : deploy/acceptance-container.sh --down $name"
echo "清理范围             : 容器 $name + 临时目录 $root；生产容器、生产库、生产媒体不动"
trap - EXIT
REMOTE
