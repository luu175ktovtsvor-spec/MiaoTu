#!/usr/bin/env bash
set -Eeuo pipefail

# 发布到生产：默认在服务器上原生构建（源码 rsync 过去 → 服务器 docker build），
# 本地模拟 amd64 构建只作为兜底（DEPLOY_BUILD=local）。构建与运行方式见 AGENTS.md。

ROOT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
REMOTE_HOST=${REMOTE_HOST:-root}
REMOTE_CONTAINER=${REMOTE_CONTAINER:-miaoimg}
IMAGE_REF=${IMAGE_REF:-miaoimg:$(date +%Y%m%d-%H%M%S)}
BUILD_MODE=${DEPLOY_BUILD:-remote}

cd "$ROOT_DIR"
SOURCE_REVISION=$(git rev-parse HEAD)
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "源码包含未提交修改，请先提交后发布。" >&2
  exit 2
fi
REMOTE_BUILD_DIR=${REMOTE_BUILD_DIR:-/opt/miaoimg-builds/${SOURCE_REVISION:0:12}-$(date +%Y%m%d-%H%M%S)-$$}
case "$REMOTE_CONTAINER" in ''|-*|*[!A-Za-z0-9_.-]*) echo "容器名称不安全" >&2; exit 2 ;; esac
case "$REMOTE_BUILD_DIR" in *[!A-Za-z0-9_./-]*) echo "构建目录不安全" >&2; exit 2 ;; esac
case "$REMOTE_BUILD_DIR" in /opt/miaoimg-builds/*) case "${REMOTE_BUILD_DIR#/opt/miaoimg-builds/}" in ''|.|..|*/*) exit 2 ;; esac ;; *) echo "请使用 /opt/miaoimg-builds 下的独立构建目录" >&2; exit 2 ;; esac
case "$IMAGE_REF" in ''|-*|*[!A-Za-z0-9_./:@-]*) echo "镜像名称不安全" >&2; exit 2 ;; esac
case "$BUILD_MODE" in local|remote) ;; *) echo "DEPLOY_BUILD 必须是 local 或 remote" >&2; exit 2 ;; esac

# ── 发布护栏（2026-10-07 加）──────────────────────────────────────────────
# 背景：当天有代理会话自己跑这个脚本、还带 DEPLOY_SKIP_PREFLIGHT=1 跳过自检，
# 两次把未审的镜像发到生产，并顺带把上一版「已审」镜像清掉了（回滚点消失）。
# 发布只能由发布负责人做，所以这里要求一个显式的口令；代理人/子会话不要设置它。
if [ "${DEPLOY_CONFIRM:-}" != "I-am-the-release-manager" ]; then
  cat >&2 <<'DENY'
拒绝发布：这是生产发布脚本，只有发布负责人手动执行。

如果你是代理会话/子任务，请停下——你的改动应当留在工作树里等审查，
发布由负责人统一做（发布的输入必须是干净提交的快照，且一次只能有一个发布者）。

负责人要发，请显式带上口令：
  DEPLOY_CONFIRM=I-am-the-release-manager bash deploy/deploy-production.sh
DENY
  exit 2
fi

# Docker and rsync consume only this exact commit, including ignored-file
# exclusions implicit in Git. A later edit to the checkout cannot enter it.
source_snapshot=$(mktemp -d "${TMPDIR:-/tmp}/miaoimg-release.XXXXXX")
trap 'rm -r -- "$source_snapshot"' EXIT
git archive "$SOURCE_REVISION" | tar -x -C "$source_snapshot"
SOURCE_DIR=$source_snapshot

# 跳过发布前自检需要第二个显式确认（自检是拦"缺依赖、API 起不来"那类事故的，不许随手跳过）。
if [ "${DEPLOY_SKIP_PREFLIGHT:-0}" = "1" ] && [ "${DEPLOY_SKIP_PREFLIGHT_ACK:-}" != "yes" ]; then
  echo "拒绝发布：DEPLOY_SKIP_PREFLIGHT=1 跳过依赖自检，需要 DEPLOY_SKIP_PREFLIGHT_ACK=yes 明确确认。" >&2
  exit 2
fi

# 磁盘只做一条门槛：先清旧产物，仍少于 8GiB 就停止新构建。
available_disk_bytes=$(ssh "$REMOTE_HOST" "df --output=avail -B1 / | tail -n 1 | tr -d ' '")
if [ "$available_disk_bytes" -lt 8589934592 ]; then
  ssh "$REMOTE_HOST" "python3 - '$REMOTE_CONTAINER'" < "$SOURCE_DIR/deploy/cleanup-production.py"
  available_disk_bytes=$(ssh "$REMOTE_HOST" "df --output=avail -B1 / | tail -n 1 | tr -d ' '")
  if [ "$available_disk_bytes" -lt 8589934592 ]; then
    echo "服务器磁盘可用空间不足 8GiB，已清理旧产物，本次构建停止。" >&2
    exit 1
  fi
fi

# 本地构建只当预检：几十秒排掉语法/引用错误，交付物由服务器构建（见 AGENTS.md）。
if [ "$BUILD_MODE" = "local" ] && [ "${DEPLOY_SKIP_PREFLIGHT:-0}" != "1" ] && [ "${DEPLOY_SKIP_BUILD:-0}" != "1" ]; then
  npm --prefix web run build
fi

if [ "$BUILD_MODE" = "local" ]; then
  # 兜底路径：本地模拟 amd64 构建后传镜像；慢，且要求本机有 Docker。
  if [ "${DEPLOY_SKIP_BUILD:-0}" != "1" ]; then
    # 线上服务器是 linux/amd64；在 Apple Silicon 上必须显式指定平台，否则会产出 arm64 镜像。
    docker build --platform linux/amd64 --label "org.opencontainers.image.revision=$SOURCE_REVISION" --tag "$IMAGE_REF" "$SOURCE_DIR"
    image_arch=$(docker image inspect "$IMAGE_REF" --format '{{.Architecture}}')
    if [ "$image_arch" != "amd64" ]; then
      echo "镜像架构是 $image_arch，不是 amd64；已阻止发布。" >&2
      exit 1
    fi
  fi
  # 运行时镜像约 2GB。单条 ssh 管道传输一旦断线就要从头再来，而且断在传输阶段
  # 会让整次发布什么都做不成；改成先导出成文件，再用 rsync 续传，然后在服务器
  # 本地 docker load。
  image_archive=${OIP_DEPLOY_ARCHIVE:-${TMPDIR:-/tmp}/oip-image-$(printf '%s' "$IMAGE_REF" | tr -c 'A-Za-z0-9._-' '-').tar.gz}
  remote_archive=/opt/miaoimg/backups/$(basename "$image_archive")
  if [ "${DEPLOY_SKIP_UPLOAD:-0}" != "1" ]; then
    docker save "$IMAGE_REF" | gzip -1 > "$image_archive"
    ssh "$REMOTE_HOST" "mkdir -p /opt/miaoimg/backups && chmod 700 /opt/miaoimg/backups"
    rsync --partial --inplace --human-readable "$image_archive" "$REMOTE_HOST:$remote_archive"
    ssh "$REMOTE_HOST" "gzip -dc '$remote_archive' | docker load && rm -f '$remote_archive'"
    rm -f "$image_archive"
  fi
else
  # 默认：源码同步到服务器独立构建目录，在服务器上原生构建（无模拟、不传镜像）。
  # 服务器上的数据、媒体与凭据目录一律不同步，也不参与 --delete。
  # 服务器上构建前端要 ~5.5GB 峰值内存；内存不够时 docker build 会在
  # `npm run build` 里 OOM（exit 134），白等五分钟。先看一眼，不够就直说。
  if [ "${DEPLOY_SKIP_MEMCHECK:-0}" != "1" ]; then
    available_mb=$(ssh "$REMOTE_HOST" "awk '/MemAvailable/{print int(\$2/1024)}' /proc/meminfo")
    if [ "${available_mb:-0}" -lt "${DEPLOY_MIN_AVAILABLE_MB:-4600}" ]; then
      echo "服务器可用内存只有 ${available_mb}MB，构建前端需要约 5.5GB 峰值；" >&2
      echo "请先腾出内存，或设 DEPLOY_MIN_AVAILABLE_MB=<更小值> / DEPLOY_SKIP_MEMCHECK=1 跳过这项检查。" >&2
      exit 1
    fi
  fi
  # A build context is newly owned by this invocation. Never let --delete
  # follow a previously existing directory or symlink supplied as a retry path.
  ssh "$REMOTE_HOST" "umask 077; test ! -L /opt/miaoimg-builds && mkdir -p /opt/miaoimg-builds && mkdir '$REMOTE_BUILD_DIR'"
  rsync -az --delete \
    --exclude '.git/' --exclude 'node_modules/' --exclude 'web/node_modules/' --exclude 'web/dist/' \
    --exclude 'reference-sources/' --exclude 'desktop/' \
    --exclude 'docs/验收证据/' \
    --exclude 'vendor/' --exclude 'secrets/' --exclude '.oip/' --exclude 'media/' \
    --exclude 'images/' --exclude 'previews/' \
    --exclude 'data/*.sqlite*' \
    --exclude 'db/*.db' --exclude 'db/*.db.gz' --exclude 'db/*.db-wal' --exclude 'db/*.db-shm' --exclude 'db/*.lock' \
    --exclude '.env' --exclude '.env.*' \
    "$SOURCE_DIR/" "$REMOTE_HOST:$REMOTE_BUILD_DIR/"
  ssh "$REMOTE_HOST" "cd '$REMOTE_BUILD_DIR' && docker build --label 'org.opencontainers.image.revision=$SOURCE_REVISION' --tag '$IMAGE_REF' ."
fi

# The local-image fallback also needs the same committed release helper.
if [ "$BUILD_MODE" = local ]; then
  ssh "$REMOTE_HOST" "umask 077; test ! -L /opt/miaoimg-builds && mkdir -p /opt/miaoimg-builds && mkdir '$REMOTE_BUILD_DIR' && mkdir '$REMOTE_BUILD_DIR/deploy'"
  rsync -az "$SOURCE_DIR/deploy/container-runtime.py" "$REMOTE_HOST:$REMOTE_BUILD_DIR/deploy/"
fi

ssh "$REMOTE_HOST" "IMAGE_REF='$IMAGE_REF' SOURCE_REVISION='$SOURCE_REVISION' REMOTE_BUILD_DIR='$REMOTE_BUILD_DIR' REMOTE_CONTAINER='$REMOTE_CONTAINER' bash -s" <<'REMOTE'
set -Eeuo pipefail
# Use the same order as site publication and storage cleanup. Hold both locks
# through the replacement and health checks, including the rollback path.
exec 8>/opt/miaoimg/.production-release.lock
flock -x 8
exec 9>/run/lock/miaoimg-deploy.lock
flock -x 9
# 改名过渡：容器从 open-image-prompts 换成 miaoimg。线上第一个次部署时把旧容器接管过来，
# 之后这段就是空操作（新名已存在或旧名已不存在）。
legacy_container=open-image-prompts
if [ "$REMOTE_CONTAINER" != "$legacy_container" ] \
  && ! docker inspect "$REMOTE_CONTAINER" >/dev/null 2>&1 \
  && docker inspect "$legacy_container" >/dev/null 2>&1; then
  echo "adopting legacy container $legacy_container -> $REMOTE_CONTAINER"
  docker rename "$legacy_container" "$REMOTE_CONTAINER"
fi
backup="${REMOTE_CONTAINER}.previous-$(date +%Y%m%d-%H%M%S)"
image_metadata=$(docker image inspect "$IMAGE_REF" --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}')
read -r runtime_image_id runtime_revision <<< "$image_metadata"
if [ "$runtime_revision" != "$SOURCE_REVISION" ]; then
  echo "镜像与本次源码提交不一致，发布停止。" >&2
  exit 2
fi
runtime_args_file=$(mktemp)
chmod 600 "$runtime_args_file"
if ! python3 "$REMOTE_BUILD_DIR/deploy/container-runtime.py" args "$REMOTE_CONTAINER" > "$runtime_args_file"; then
  rm -f "$runtime_args_file"
  exit 2
fi
mapfile -d '' -t preserved_args < "$runtime_args_file"
rm -f "$runtime_args_file"
data_dir=$(python3 "$REMOTE_BUILD_DIR/deploy/container-runtime.py" path "$REMOTE_CONTAINER" /app/data)
secret_dir=$(python3 "$REMOTE_BUILD_DIR/deploy/container-runtime.py" path "$REMOTE_CONTAINER" /app/secrets)
mapfile -t env_args < <(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$REMOTE_CONTAINER")
if [ -f /opt/miaoimg/.oip/runtime-data/.grok-api.env ]; then
  while IFS= read -r value; do
    [ -n "$value" ] || continue
    case "$value" in \#*) continue ;; esac
    env_args+=("$value")
  done < /opt/miaoimg/.oip/runtime-data/.grok-api.env
fi

# 部署过程中任何一步失败都要把旧容器恢复回来：只要备份容器还在（即还没被
# 成功删除/重命名回去），就删除半成品容器并启动旧容器。
cleanup() {
  code=$?
  if [ "$code" -ne 0 ] && docker inspect "$backup" >/dev/null 2>&1; then
    echo "deploy failed; restoring $backup" >&2
    docker rm -f "$REMOTE_CONTAINER" >/dev/null 2>&1 || true
    docker rename "$backup" "$REMOTE_CONTAINER" >/dev/null 2>&1 || true
    docker start "$REMOTE_CONTAINER" >/dev/null 2>&1 || true
  fi
  return "$code"
}
trap cleanup EXIT

# Migrate credentials from the currently running container exactly once. The
# values are captured into a host-only directory without printing them or
# putting them into the next container's environment. Later releases read the
# mounted files directly.
mkdir -p "$secret_dir"
# The runtime image runs as UID 1000 (node); keep the directory private while
# making the files readable to that unprivileged process after the bind mount.
chown 1000:1000 "$secret_dir"
chmod 700 "$secret_dir"
secret_mappings=(
  'ARK_API_KEY:ark-api-key'
  'SUIHE_API_KEY:suihe-api-key'
  'YUNSHU_API_KEY:yunshu-api-key'
  'GROK_API_KEY:grok-api-key'
  'METASO_API_KEY:metaso-api-key'
  'OIP_ADMIN_EMAIL:admin-email'
  'OIP_ADMIN_PASSWORD:admin-password'
  'OIP_ADMIN_TOKEN:admin-token'
  'ZPAY_PID:zpay-pid'
  'ZPAY_KEY:zpay-key'
  'GOOGLE_OAUTH_CLIENT_ID:google-client-id'
  'GOOGLE_OAUTH_CLIENT_SECRET:google-client-secret'
  'QQ_OAUTH_APP_ID:qq-app-id'
  'QQ_OAUTH_APP_KEY:qq-app-key'
  'GITHUB_OAUTH_CLIENT_ID:github-client-id'
  'GITHUB_OAUTH_CLIENT_SECRET:github-client-secret'
  'WECHAT_OAUTH_APP_ID:wechat-app-id'
  'WECHAT_OAUTH_APP_SECRET:wechat-app-secret'
  'DINGTALK_OAUTH_CLIENT_ID:dingtalk-client-id'
  'DINGTALK_OAUTH_CLIENT_SECRET:dingtalk-client-secret'
  'LINUXDO_OAUTH_CLIENT_ID:linuxdo-client-id'
  'LINUXDO_OAUTH_CLIENT_SECRET:linuxdo-client-secret'
  'OIDC_OAUTH_CLIENT_ID:oidc-client-id'
  'OIDC_OAUTH_CLIENT_SECRET:oidc-client-secret'
  'SUB2API_API_KEY:sub2api-api-key'
  'QQ_CONNECT_APP_ID:qq-app-id'
  'QQ_CONNECT_APP_KEY:qq-app-key'
  'WECHAT_CONNECT_APP_ID:wechat-app-id'
  'WECHAT_CONNECT_APP_SECRET:wechat-app-secret'
  'DINGTALK_CONNECT_CLIENT_ID:dingtalk-client-id'
  'DINGTALK_CONNECT_CLIENT_SECRET:dingtalk-client-secret'
  'LINUXDO_CONNECT_CLIENT_ID:linuxdo-client-id'
  'LINUXDO_CONNECT_CLIENT_SECRET:linuxdo-client-secret'
  'OIDC_CONNECT_CLIENT_ID:oidc-client-id'
  'OIDC_CONNECT_CLIENT_SECRET:oidc-client-secret'
)
for mapping in "${secret_mappings[@]}"; do
  env_name=${mapping%%:*}
  file_name=${mapping#*:}
  # docker inspect output is consumed by the shell; it is never echoed.
  value=''
  for entry in "${env_args[@]}"; do
    case "$entry" in "$env_name="*) value=${entry#*=} ;; esac
  done
  if [ -n "$value" ] && [ ! -s "$secret_dir/$file_name" ]; then
    umask 077
    printf '%s' "$value" > "$secret_dir/$file_name"
    chown 1000:1000 "$secret_dir/$file_name"
    chmod 600 "$secret_dir/$file_name"
  fi
done
chown 1000:1000 "$secret_dir"/* 2>/dev/null || true
chmod 600 "$secret_dir"/* 2>/dev/null || true

# Verify credentials as the runtime UID before replacing the working container.
docker run --rm --network none --user 1000:1000 --entrypoint node \
  --mount "type=bind,src=$secret_dir,dst=/app/secrets,readonly" "$runtime_image_id" \
  --input-type=module -e '
    import { runtimeSecret } from "/app/server/runtime-secrets.ts";
    for (const name of ["ARK_API_KEY", "SUIHE_API_KEY", "YUNSHU_API_KEY", "GROK_API_KEY", "METASO_API_KEY", "OIP_ADMIN_EMAIL", "OIP_ADMIN_PASSWORD", "ZPAY_PID", "ZPAY_KEY"]) {
      if (!runtimeSecret(name)) throw new Error("Missing readable credential: " + name);
    }
    console.log("Mounted credential preflight passed");
  '
# 服务端模块依赖自检：镜像里少装一条依赖时，web 端口照样起、健康检查照样过（它探的是 4173），
# 但 API 进程会在 import 阶段直接崩掉——2026-10-06 真发生过一次：线上 502，原因是镜像里缺 Agent SDK。
# 这里在换容器**之前**把 server/ 的裸导入解析一遍，缺依赖就拦住这次发布，不让它碰到正在跑的容器。
docker run --rm --network none --entrypoint node "$runtime_image_id" /app/scripts/check-server-modules.ts

# 只备份数据库：账号、余额、订单、生成记录、以及工作区文件的**索引**。
# 媒体字节不在库里（2026-10-06 起落在 /opt/miaoimg/media 这个 bind mount 上），
# 这个备份**不含任何文件内容**——恢复它得到的是「索引 + 那时候的磁盘字节」，
# 而 media/ 本身没有任何备份。要动媒体布局（例如多项目迁移）之前请先单独快照 media/。
backup_dir=/opt/miaoimg/backups
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
python3 - "$backup_dir/management-$(date +%Y%m%d-%H%M%S).sqlite" "$data_dir/management.sqlite" <<'PYBACKUP'
import os, sqlite3, sys
source = sys.argv[2]
if not os.path.isfile(source):
    raise SystemExit('Management database missing; deployment stopped')
with sqlite3.connect('file:' + source + '?mode=ro', uri=True) as src, sqlite3.connect(sys.argv[1]) as dst:
    src.backup(dst)
os.chmod(sys.argv[1], 0o600)
print('Persistent data backup complete')
PYBACKUP

docker stop --time 180 "$REMOTE_CONTAINER" >/dev/null
docker rename "$REMOTE_CONTAINER" "$backup"

args=(
  --detach
  --name "$REMOTE_CONTAINER"
  --restart unless-stopped
  --stop-timeout 180
  # 日志上限：默认 json-file 驱动不封顶，线上实测已有单个容器日志涨到 73M。
  # 3×10M 够排查（重启即轮转），不会把磁盘吃满。
  --log-opt max-size=10m
  --log-opt max-file=3
  "${preserved_args[@]}"
)
# Remove every migrated credential, including compatibility aliases.
for value in "${env_args[@]}"; do
  [ -n "$value" ] || continue
  sensitive=false
  for mapping in "${secret_mappings[@]}"; do
    if [ "${value%%=*}" = "${mapping%%:*}" ]; then sensitive=true; break; fi
  done
  [ "$sensitive" = true ] && continue
  case "${value%%=*}" in OIP_RUNTIME_IMAGE|OIP_RUNTIME_REVISION) continue ;; esac
  args+=(--env "$value")
done
args+=(--env "OIP_RUNTIME_IMAGE=$IMAGE_REF" --env "OIP_RUNTIME_REVISION=$runtime_revision")
args+=(--env SUB2API_BASE_URL=https://api.zzyppz.cn)
# 工作区文件的字节放这个挂载里（旧容器若继承到别的值会被这一行覆盖）。
args+=(--env OIP_MEDIA_ROOT=/app/media)
# 媒体文件放宽到「同组可读」（0750/0640），nginx 的 worker 才发得出字节；
# 只放开同组，别人的素材仍然不对外可读。
args+=(--env OIP_MEDIA_MODE=group)
# 内层 API 绑到容器内的 0.0.0.0，宿主侧仍然只 --publish 到 127.0.0.1（不对外）。
# 为什么必须这么设：内层服务默认只绑容器内的 127.0.0.1，而 --publish 只是把宿主端口
# 映射到容器端口——容器内那个地址上没有监听，宿主侧就连不上（实测：宿主 curl 4175/4176 返回 000，
# 只有设了 OIP_WEB_HOST=0.0.0.0 的 4173 通）。不设这两行，nginx 就无法直连内层 API，
# 只能继续走「nginx → vite preview → 内层 API」那一跳。
# 边界说明：这会把内层 API 从「仅容器内可见」放宽到「docker 网桥内可见」，宿主侧仍只发布到
# 127.0.0.1；管理 API（4184）不在此列，它靠 OIP_ADMIN_LOCAL_ONLY 保持只允许本机。
args+=(--env OIP_IMAGE_API_HOST=0.0.0.0)
args+=(--env OIP_API_HOST=0.0.0.0)
# 固定内层端口，nginx 才能直接指过来（不固定的话每次启动都是随机端口）。
args+=(--env OIP_IMAGE_API_PORT=4175)
args+=(--env OIP_API_PORT=4176)
args+=(--env OIP_ADMIN_PORT=4184)
# 灵感库查询不能猜 Agent 与档案服务是否共用 loopback；生产显式指向档案 API。
# 默认是当前站点的公开档案入口，拆分档案服务时由发布者覆盖 OIP_ARCHIVE_API_URL。
args+=(--env OIP_ARCHIVE_API_URL="${OIP_ARCHIVE_API_URL:-https://miaoimg.cn}")
args+=(--env OIP_PUBLIC_ORIGINS="${OIP_PUBLIC_ORIGINS:-https://miaoimg.cn,https://canvas.miaoimg.cn,https://admin.miaoimg.cn}")
# 管理端从这个只读挂载统计实际 WebP 预览文件；不设置会长期显示 null。
args+=(--env OIP_PREVIEWS_ROOT=/app/previews)
docker run "${args[@]}" "$runtime_image_id"
python3 "$REMOTE_BUILD_DIR/deploy/container-runtime.py" compare "$backup" "$REMOTE_CONTAINER"

healthy=''
for _ in $(seq 1 45); do
  healthy=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$REMOTE_CONTAINER" 2>/dev/null || true)
  [ "$healthy" = healthy ] && break
  sleep 2
done
if [ "$healthy" != healthy ]; then
  docker logs "$REMOTE_CONTAINER" >&2 || true
  docker rm -f "$REMOTE_CONTAINER" >/dev/null || true
  docker rename "$backup" "$REMOTE_CONTAINER"
  docker start "$REMOTE_CONTAINER" >/dev/null
  exit 1
fi

# 独立复核全部四个端口，不只依赖容器 HEALTHCHECK 的配置；
# 每次探测都有期限，任何一个不通就按失败处理，回滚到上一个容器。
# 下面这四行端口号必须和上面 args+=(--env OIP_*_PORT=…) 固定的值一致。
if ! docker exec "$REMOTE_CONTAINER" node --input-type=module -e '
  const ports = [4173, 4175, 4176, 4184]
  const results = await Promise.all(ports.map(async (port) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) })
      await response.body?.cancel()
      return response.ok ? null : `${port} → HTTP ${response.status}`
    } catch (error) {
      return `${port} → ${error?.cause?.code || error?.message || error}`
    }
  }))
  const broken = results.filter(Boolean)
  if (broken.length) {
    console.error(`unready: ${broken.join(" | ")}`)
    process.exit(1)
  }
  console.log("inner api ports healthy: 4173 4175 4176 4184")
'; then
  echo "内层 API 未就绪，本次发布按失败处理并回滚。" >&2
  docker logs --tail 40 "$REMOTE_CONTAINER" >&2 || true
  docker rm -f "$REMOTE_CONTAINER" >/dev/null || true
  docker rename "$backup" "$REMOTE_CONTAINER"
  docker start "$REMOTE_CONTAINER" >/dev/null
  exit 1
fi
# Gracefully replace Nginx workers without restarting other hosted sites.
nginx -t
systemctl reload nginx
# 网页验收前保留刚替换的容器；验收后用 --accepted-revision 清成一个运行版本。
printf 'Production container healthy: %s\n' "$IMAGE_REF"
REMOTE

# 发布成功后复用统一清理入口；清理失败不应把健康的发布回滚。
ssh "$REMOTE_HOST" "python3 - '$REMOTE_CONTAINER' '$REMOTE_BUILD_DIR'" < "$SOURCE_DIR/deploy/cleanup-production.py" ||
  echo "发布已成功，空间清理未完成，请在验收后执行 deploy/cleanup-production.py" >&2

printf 'Public deployment complete: %s\n' "$IMAGE_REF"
