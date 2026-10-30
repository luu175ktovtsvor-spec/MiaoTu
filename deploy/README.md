# deploy

妙图生产已不使用 Docker 部署。部署、发布、回滚、清理和官网发布一律按 [native/README.md](native/README.md) 执行。模型网关 Sub2API 仍以自己的 Docker 容器运行，不属于本目录的发布范围。

## 不能用于生产的 Docker 脚本

下列文件只适用于 Docker 交付，不能用在原生生产上，也不能未经适配复制到服务器：

- `deploy-production.sh`、`deploy-admin.py`、`container-runtime.py`、`acceptance-container.sh`
- `publish-site.py --image`（原生官网发布用 `native/publish-site.py`）
- `publish-docker-image.sh`（为客户另行交付镜像的工具）
- `cleanup-production.py`、`miaoimg-storage.service/.timer`、`snapshot-media.sh`
- 仓库根目录的 `Dockerfile`、`docker-entrypoint.sh`、`.env.docker.example`

## 仍在使用的文件

| 文件 | 用途 |
| --- | --- |
| `native/` | 生产 systemd unit、Nginx 配置、发布/备份/检查脚本 |
| `inspect.sh` | 本机执行的只读生产检查；原生主机上自动转为 `native/inspect-native.py` |
| `publish-desktop-updates.sh`、`verify-update-metadata.py` | 桌面更新源发布与元数据核对，见 [桌面版本发布与包命名](../docs/桌面版本发布与包命名.md) |
| `install-mac.sh` | 随更新源发布的 Mac 安装脚本，见 [macOS安装与发布规范](../docs/macOS安装与发布规范.md) |
| `sync_upstream_dataset.py` | `miaoimg-sync` 定时任务执行的公开目录同步 |
| `cloud-showcase.filter` | 官网构建需要的桌面共享资料白名单（`showcase.json` 与灵感库 JSON），不放行桌面代码、依赖或媒体 |

## 仍然适用的规则

- `/opt/miaoimg` 是持久数据目录，不是源码目录，不作为 `rsync --delete` 目标。禁删清单见 [AGENTS.md](../AGENTS.md)「数据保护与禁删清单」。
- 数据、媒体、凭据不进发布包，也不在发布时被覆盖。
- 改 Nginx：校验不要过管道（`nginx -t | tail` 的退出码是 `tail` 的，会吞掉失败），用 `systemctl reload nginx` 而不是 `restart`。
- 媒体由 Nginx 内部 location `/__media_internal/` 直出，Node 只做鉴权和归属校验；`/api/imagine` 反代注入 `X-Miaoimg-Media-Accel 1` 才启用直出。`add_header` 按 location 生效且不继承，直出响应需要的头（如 `x-workspace-revision`）必须写在内部 location 里，否则保存已有画布/文档会被误判为冲突。
- 新增 `/api/<前缀>` 服务端路由时同步三处：服务端路由分发、`web/vite.config.ts` 的 `server.proxy` 与 `preview.proxy`、`native/nginx.conf`。`node scripts/nginx-api-routes.ts` 可从 vite 代理表生成对照段落；`--file-policy-map`、`--file-policy-headers` 生成素材响应策略（`server/file-content-policy.ts`），只用于素材静态 location。
- `gzip_types` 必须同时包含 `text/javascript` 和 `application/javascript`。
- 存量数据迁移（`scripts/migrate-projects.ts`、`scripts/migrate-media-blobs.ts`）没有明确授权不运行；需要时先 `--report`，确认备份和回滚路径后再单独执行。
