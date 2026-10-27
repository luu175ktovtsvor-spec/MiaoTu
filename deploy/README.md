# 部署与运行

桌面开发、真包验收和更新源发布先读[开发隔离与桌面发布](../docs/开发隔离与桌面发布.md)。本机默认使用 Node + Electron；本文 Docker 部分适用于远端服务及另行选择的服务端镜像交付。

主线服务镜像保留 `server/` 的运行模块；主应用还保留提示词 CLI 所需的 `retrieval/`、`taxonomy/` 及其 JSON。画布只使用当前格式标记，不再依赖额外的兼容配置文件。

桌面源码不上传到服务构建目录，也不进入 Docker 构建输入。运行所需资源按原路径保留，不能把整个 docs 目录一并排除。

换容器前的 `scripts/check-server-modules.ts` 只解析源码，不执行服务。它扫描服务端及存在时的 `web/scripts/`，检查裸依赖和字面相对导入（包括 JSON）；不能据此证明动态计算的资源路径、数据库或真实业务已经运行。完整发布仍须核对实际镜像、挂载与四端口，并完成用户路径验收。

独立后台升级以当前 `miaoimg-admin` 的实际配置为基线，保留其数据挂载、读写属性、端口、网络与环境；只有首次安装才从主应用派生。`deploy-admin.py` 与共用的 `container-runtime.py` 必须一同放在部署目录。无法完整复现的特殊运行约束会在停旧容器前拒绝；健康检查的显式覆盖按旧容器与其原镜像比较，不阻止目标镜像正常更新健康检查。后台数据库备份读取自身的数据挂载，不能默认与主应用相同。

## 当前空间与清理规则（2026-10-07）

本节是当前执行规则；下面带日期的迁移、事故和镜像记录是历史背景，不能作为当前版本或保留份数的依据。妙图是本服务器的主项目，现有 Yunshu、Dola、数据库与缓存属于生产链路，不按无关项目删除。

| 项目 | 当前规则 |
|---|---|
| 容器与镜像 | 验收后只留妙图当前运行版；发布过渡期间暂留上一版，失败立即回滚，网页验收完成后删除。所有容器仍引用的镜像、其他任务的新候选镜像不删。 |
| 独立数据库备份 | 最新一份 `management*.sqlite[.gz]`，关闭且无非空 WAL 的快照才清理或无损压缩。生产库及其 WAL 不在范围内。 |
| 原始素材与记录 | 原始图片、视频、画布、生成历史及积分账本保留。同一账号的相同内容共用 blob，画布和历史保留引用；跨账号分别存储。 |
| 历史归档 | 旧整库历史快照已清理。旧快照里的独有素材和文本保存在 retained-blobs/，与线上相同内容使用硬链接，共用物理字节；索引文件保留原路径，不增加原片副本。 |
| 媒体快照 | 旧每日快照定时器已停用，日常发布不新建全量媒体快照。涉及媒体布局变更时，才按迁移范围准备必要的一次性备份并明确收尾。 |
| 构建与缓存 | 从明确 Git 提交使用仓库 Dockerfile，在服务器原生构建，不连续叠加线上镜像。构建结束清空可回收缓存；运行镜像共享层和活跃构建不误删。运行包只带服务端依赖、静态 bundle、词典和最小预览服务，不复制前端开发依赖、数据集及媒体。 |
| 日志 | 新容器 `json-file / max-size=10m / max-file=3`，每容器约 30MB；已有容器配置不会自动改变。系统 journal 限制 100MB，业务账本仍保留。 |
| 内存与磁盘 | 约 8GB 内存 + 4GB swap。swap 是占磁盘的备用内存，保留应对运行及构建峰值。新构建前至少留 8GiB 磁盘可用空间。 |

统一清理入口在服务器执行：

```bash
python3 /opt/miaoimg-ops/cleanup-production.py
# 网页验收并同步源码后，清掉本轮独立构建上下文：
python3 /opt/miaoimg-ops/cleanup-production.py miaoimg /opt/miaoimg-builds/<本轮目录> --accepted-revision <实际运行提交>
```

时机要区分清楚：发布中保留刚替换的上一版容器和镜像；实际网页验收完成后，用 --accepted-revision 确认当前提交，删除所有停用旧版。后续日常维护读取该标记，新 revision 尚未验收时继续保留临时回滚。网页验收、本地源码同步完成后再执行任务收尾，移除本轮临时目录并停止自己启动的进程。清理脚本只检查当前容器是否健康，不能判断网页、模型返回或画布是否验收通过，也不会替你清理任务 Git 工作树或停止开发进程。

清理使用生产发布锁，发布进行中拒绝执行；失败只报告并补做，不因清理失败回滚健康的应用。日常清理不重启 Docker，不手动删除 Docker/containerd 内部存储，不删除 Git 源码、用户 WIP、凭据、媒体或生产数据库。Docker 配置维护必须单独核对影响；`live-restore` 不能代替重启后的服务检查，也不能据此承诺完全无中断。

历史独有原始内容位于 `/opt/miaoimg/backups/archive/retained-blobs/<sha256>`。原路径由 `media-index.json` 和 `snapshot-media-index.json` 记录，按索引复制到独立目录即可恢复。与当前素材相同的内容共用硬链接，只有一个物理文件；旧整库历史快照已删除，不能恢复旧数据库状态。当前账号和账本使用唯一最新数据库快照恢复。该目录权限只允许管理员访问，不对普通用户直接公开。

## 单份存储与自动维护

原始素材位置为 `media/<账号>/_blobs/<内容哈希>`，工作区节点和生成历史仅保留索引。相同账号相同字节复用一份；删除一条引用不删除其他节点或历史仍使用的文件。不同账号维持独立权限边界。小预览是派生缓存，不是第二份原片，保留它们用于快速显示；用户预览最长 30 天、软目标 256MB，丢失后读取原片重新生成。公开灵感库图片与预览是产品内容，不能当无用构建文件删除。

`miaoimg-storage.timer` 每天上海时间 04:15 后随机十分钟执行短维护任务：用 SQLite online backup 验证并更新唯一小型压缩快照，清理无引用且过宽限期的 blob、过期预览及可回收构建层。上传落字节和写索引与 GC 共用数据库写锁，回收前再次确认引用与 mtime；不运行旧的全目录 --fix。不会删除原始素材、画布、生成记录或积分账本，也不启动额外常驻服务。

安装和手动执行：

```bash
install -d -m 755 /opt/miaoimg-ops
install -m 755 deploy/cleanup-production.py /opt/miaoimg-ops/cleanup-production.py
install -m 644 deploy/miaoimg-storage.service deploy/miaoimg-storage.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now miaoimg-storage.timer
python3 /opt/miaoimg-ops/cleanup-production.py --maintenance
```

部署数据仍挂载在宿主机。精简运行镜像不内置数据库归档，必须保留 /app/db 等既有挂载；数据集同步的新版本通过校验后删除同步用的 previous 副本，不每次成功后多留一份。数据库快照只是索引/账号恢复用途，不能恢复已删除的原片；硬盘损坏恢复需要另行安排异地备份。

## 灵感库数据同步

生产服务器只自动同步灵感库数据库和官方图片包，不拉取应用代码。数据目录 `/opt/miaoimg` 与发布用的临时构建目录分开，`OIP_DATASET_ROOT` 指定数据写入位置。

## Application image delivery

This section describes the server application image, not the Electron desktop.
Desktop development uses local Node + Electron without Docker. Production server builds
happen **on the server** from an immutable archive of a clean local Git commit.
`deploy-production.sh` creates a separate directory under `/opt/miaoimg-builds/`
for each release; the server does not keep a second source checkout. The local
amd64 build and `docker save` / `docker load` path remains a fallback
(`DEPLOY_BUILD=local`). Dataset and runtime state remain bind mounts and never
enter the image. Untracked changes block release, and ignored local files are
absent from the Git archive even if they would pass Docker's ignore rules.

The following local Compose commands are an optional server-only workflow,
not a prerequisite or the default path for desktop development:

```bash
cp .env.docker.example .env.docker
docker compose up --build
# open http://127.0.0.1:4174/
```

Real provider calls are disabled by default in the local container. To test
generation with your own quota, set `ENABLE_MODEL_CALLS=true` and the relevant
provider key in `.env.docker`, then recreate the container. UI and request
validation can be checked without sending a real generation request.

```bash
deploy/publish-docker-image.sh
```

For a customer's **first installation**, set `REMOTE_HOST`, `REMOTE_ENV_FILE`
and optionally `REMOTE_DATA_DIR` explicitly. The helper refuses an existing
container; updates require a release process that preserves its configuration
and rollback. It does not copy credentials from our server. A customer can also skip the helper and
run the image through their own Compose, Kubernetes, Nginx or Caddy setup.

Production release entry (requires the release-manager confirmation):

```bash
DEPLOY_CONFIRM=I-am-the-release-manager REMOTE_HOST=<SSH-host> deploy/deploy-production.sh
```

The script builds only the selected committed archive and requires the image's
revision label to match it, including when reusing an image. Before replacing
the service, it takes the same two locks as site/admin release and storage
cleanup, captures the current container's actual mounts, published ports and
network, and preserves its environment. Database backup and credential access
use the existing bind-mount sources. After starting the replacement it compares
the actual container configuration and checks service health; a failure restores
the previous container. Unsupported mount/network layouts stop before the old
service is stopped. Keep the rollback container until real acceptance completes;
health alone does not establish that desktop, login or models work.

## Post-deploy verification (multi-account isolation, no local data)

The server is shared by real users; each account must only see its own canvas,
files and assets. After every publish, verify all three checks:

1. The image contains no local data — the build context excludes
   `data/*`, `web/data`, `secrets`, `db/*.db` and `**/*.sqlite*`:

   ```bash
   docker exec miaoimg sh -lc 'ls /app/web/data 2>&1; find /app -maxdepth 2 -name "*.sqlite*"'
   # expect: /app/web/data: No such file or directory, and only /app/data/management.sqlite (bind mount)
   ```

2. The live database has no local test accounts — check that the local user
   IDs/emails return `0` (replace with the IDs from `data/management.sqlite`):

   ```bash
   sqlite3 /opt/miaoimg/.oip/runtime-data/management.sqlite \
     "select count(*) from users where id in ('<local-user-id>');"
   ```

3. Account isolation must use separately authorized existing accounts. Never register throwaway accounts or grant test credits. If only one account is authorized, report that cross-account isolation is unverified. Website generation acceptance uses the specified canvas and keeps results when the user requests it.

Runtime accounts, workspaces and files live in the bind mount
`/opt/miaoimg/.oip/runtime-data`, so replacing the container keeps
every user's data.


## nginx 直出（X-Accel-Redirect，2026-10-06 上线）

素材响应策略（2026-10-19）：Node、桌面转发及档案预览复用 `server/file-content-policy.ts`。生产 Nginx 的 `/images/`、`/previews/`、`/thumbs/`、`/showcase/` 静态 alias 绕过 Node，发布时也须配置相同策略。`node scripts/nginx-api-routes.ts --file-policy-map` 生成应放在 `http {}` 内、站点 server 之前的 MIME 映射；`--file-policy-headers` 生成放入上述各素材 location 的响应头。先安装 map，再配置 location，已有 nosniff 单行由同一段替换，保留原 Range、缓存、alias 和缺文件视频回源规则。配置后先 `nginx -t`，正式变更仍沿现行回滚部署流程执行。这些策略不能加到应用的 `/`、`/assets/` 或后台界面资源；`/__media_internal/` 继续继承 Node 返回的策略，使用下方生成器现有的 `--media` 输出。本次只准备源码和生成器，未修改线上配置或 reload。

工作区媒体的字节由 nginx 直接发（sendfile / Range / 断点续传都在 nginx 层），Node 只负责鉴权与归属校验。
两个开关配套：Node 侧只在请求带 `X-Miaoimg-Media-Accel: 1` 时才回直出头，这个头由 nginx 注入；
没配 nginx 时永远走 Node 发字节，功能不受影响。

```nginx
# 反代 /api/imagine/ 那一段里加一行（这就是开关，注释掉立刻回到 Node 直发）
proxy_set_header X-Miaoimg-Media-Accel 1;

# 同一个 server 块里新增：媒体内部目录
location /__media_internal/ {
    internal;                         # 外部直连一律 404：URI 不含凭据，鉴权只在 Node 一层
    alias /opt/miaoimg/media/;        # 宿主机路径，末尾斜杠不能少
    # 直出的响应由本 location 重新生成，Node 的响应头默认到不了客户端；
    # 少了这行前端 read() 拿不到修订号，保存已有画布/文档会被误判成 409。
    add_header x-workspace-revision $upstream_http_x_workspace_revision always;
}
```

权限（否则 nginx 读不到 0700/0600 的媒体，直出会 403）：

```bash
groupadd -g 1000 miaoimg            # 宿主机给 gid 1000 起个组名（容器里是 node）
usermod -aG miaoimg www-data        # nginx worker 用户
systemctl restart nginx
chmod -R u+rwX,g+rX,o-rwx /opt/miaoimg/media
```

容器侧配套：`--env OIP_MEDIA_MODE=group`（新建目录 0750 / 文件 0640，只放开同组）、
`--env OIP_MEDIA_ROOT=/app/media` 与 `--mount src=/opt/miaoimg/media,dst=/app/media`。

三个坑（都踩过）：
1. **`add_header` 按 location 生效**：内部重定向会切到内部 location 的配置，
   外层 location 的 `add_header`/`proxy_pass_header` 对直出响应都无效，必须写在上面的内部 location 里。
2. **`add_header` 不继承**：在内部 location 写了 `add_header` 后，server 块里其它 `add_header`
   （未来的安全响应头）对媒体响应不再生效，新增时要在这里补一份。我们的 server 块目前没有其它 add_header。
3. **本地 Mac 验直出会看到假象**：Docker Desktop 的 VirtioFS 在 rename 之后会短暂查不到新名字
   （纯 shell `mv` 也能复现，与代码无关）；Linux 上不存在，线上不会遇到。

改 nginx 的纪律（血泪）：**校验不要过管道**（`nginx -t | tail` 的退出码是 `tail` 的 0，会把失败吞掉），
并且用 `systemctl reload` 而不是 `restart`——reload 遇到坏配置会保留旧进程，零停机。

## 工作区多项目（2026-10-06）：先发代码，再择机迁移

一个账号下有多个工作区（项目）。磁盘从 `<MEDIA_ROOT>/<账号>/<相对路径>` 变成
`<MEDIA_ROOT>/<账号>/<项目 id>/<相对路径>`，`workspace_files` 主键加上 `project_id`。

**发布代码和跑迁移是两件事，可以分开做。** 新代码在没有迁移过的库上按单项目语义照常跑
（不建 projects 表、不改 `workspace_files`、不碰字节），行为和老版本一致；迁移是一次显式执行的
存量数据变更，只由 `scripts/migrate-projects.mjs` 触发，服务端启动时不会自己跑。

> **顺序提醒**：这一轮之后还有一次「媒体内容寻址」迁移（见下面「媒体内容寻址」一节），
> 它必须在项目迁移**之后**跑——它会把路径树本身清掉。两次迁移都做了护栏，顺序反了会直接拒绝。

推荐顺序（前 4 步都在不可逆那一步之前，随时可以无脑回滚镜像）：

1. **发新镜像，不迁移**。新镜像在老库上按单项目语义跑，行为与现在完全一致；健康检查和抽验在这一步做完。
2. `--report` 看账：多少行、多少字节、当前在哪一步。
3. `--copy-only`（推荐）：把字节复制到项目布局并逐字节校验，表结构一个都不动。随时可以放弃。
4. 抽验：旧镜像、新镜像都还能正常读写（复制出来的那份是冗余的，谁都不依赖它）。
5. **`--apply`**：跳过复制，只做「改主键 + 建默认项目 + 清理旧位置」。
6. **重启服务**（进程在启动时读一次结构，见下）。

```bash
# 一次性脚本也在容器里跑，和线上环境一致
docker run --rm \
  --mount type=bind,src=/opt/miaoimg/.oip/runtime-data,dst=/app/data \
  --mount type=bind,src=/opt/miaoimg/media,dst=/app/media \
  miaoimg:<tag> node scripts/migrate-projects.mjs --report     # 只报账，先看清楚
  # 核对无误后把 --report 换成 --apply
```

`--apply` 的顺序是刻意排的：**先把字节整份复制到项目布局并逐字节校验，再改表结构，最后才删旧的那一份**。
所以任何时刻至少有一个布局是完整的：

- 复制阶段崩了：老布局原样可用，旧容器直接起得来，回滚镜像零风险；
- 复制完、还没删旧的时候：两个布局都有完整字节，项目布局那一份已经逐字节校验过；
- 删除阶段崩了：项目布局已经整份校验过，继续跑一次 `--apply` 就收尾，或者 `--rollback` 把老布局重建回来。

`--copy-only` 就停在「复制完、结构还没动」这个点上：**它只复制字节，表结构一个都不改**，
所以停在那里时老库还是老库——旧镜像、新镜像读写都正常。这是整个迁移里唯一一个可以随便停、随便放弃的安全点，
建议正式迁移前先单独跑它一次（几秒钟到几分钟，取决于媒体体积），后面 `--apply` 会跳过复制。

**迁移后必须重启服务**：进程在启动时读一次库里有没有 `project_id` 来决定走哪套结构。第 4 步改完主键之后，
迁移前就起来的进程还按老结构干活，会变成「读 404、写 500」（实测过），重启即恢复。最稳的是
「停服务 → `--apply` → 起服务」。

**第 4 步（改主键）是不可逆的分水岭**，之前随便回滚镜像，之后必须先 `--rollback`：
旧镜像面对「已迁移的库 + 项目布局的字节」时能起来、能列文件（`GET /workspace/files` 返回 200），
但读任何一个文件都是 404，写任何文件都报 500（`ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`）。
退路是用**新镜像里的脚本**（不用新镜像跑起来，`docker run --rm` 调脚本就行）跑一次 `--rollback`，
老布局恢复后旧镜像读写都正常——这条我在副本上完整验过。

所以推荐把迁移排在健康检查之后：**发新镜像 → 新镜像在老库上跑（行为与老版本一致）→ 抽验 → 再 `--apply`**，
这样「健康检查失败要回滚」的风险发生在不可逆那一步之前。

- **搬迁不是 rename**：rename 搬到一半崩掉老布局就只剩一半字节，回滚到旧容器对用户就是文件消失。
- 幂等、可续跑：两个布局都有的行会先校验一致再删源；中途失败重跑即可。
- 严格：体检发现任何一行搬不动就一行都不动，列出是哪一行；迁移前就已经缺失的孤儿索引
  （索引在、两个布局都没有字节）加 `--allow-missing` 放行。
- **回滚镜像前先 `--rollback`**：同样先复制回老布局、校验、再退表结构。它会保留 `projects` 表
  （旧代码不认它，留着才能在重新发布后恢复用户建过的项目），要彻底清掉再加 `--drop-projects`。
- 媒体根目录指错（比如没设 `OIP_MEDIA_ROOT`）时脚本会直接拒绝，不会误判成「字节全丢了」。
- 启动日志里关于工作区的提醒和 `--report` 的「判断」是**同一份判断**（`projects.mjs` 的 `layoutAdvice`），
  不会出现「报告说没事、启动说中间态」这种自相矛盾的说法。老库上启动不打任何 workspace 日志——
  那是正常工作状态；打了就是真要处理，按它给的命令做即可。
- 迁移期间写文件：表结构改过之后，旧代码的 upsert 会报 `ON CONFLICT clause does not match any PRIMARY KEY
  or UNIQUE constraint` —— 所以改结构那一步之后就不要再用旧版本容器了。

### 动媒体之前：数据库备份不含媒体，迁移工具须能独立恢复

两件容易在真出事时才发现的坑，正式迁移前先做掉：

1. **数据库备份不含媒体字节。** `deploy-production.sh` 只做 `management.sqlite` 的在线备份——
   账号、余额、订单、生成记录，以及工作区文件的**索引**。字节在 `/opt/miaoimg/media` 这个
   bind mount 上，不能假定历史归档包含迁移开始时的全部字节。所以「恢复数据库备份」**不是**媒体布局迁移的退路：
   恢复出来的是「老结构的索引 + 项目布局的字节」，实测新旧代码逐行读都是 0/134，比不恢复还糟。
   迁移前先做一次快照（硬链接副本，几乎不占空间；迁移是「复制到新路径再删旧路径」，不原地改内容，
   所以硬链接快照是安全的）：

   ```bash
   snap=/opt/miaoimg/backups/media-$(date +%Y%m%d-%H%M%S)
   cp -al /opt/miaoimg/media "$snap" && du -sh --apparent-size "$snap"
   ```

2. **`--rollback` 依赖的脚本只存在于新镜像里，而镜像只保留当前版和上一版。**
   迁移之后只要再发布两次，带脚本的那个镜像就被自动清掉了，那时想回滚就没有工具了。
   迁移前把它拷到服务器上（镜像之外）：

   ```bash
   mkdir -p /opt/miaoimg/migrations/$(date +%F)
   cp scripts/migrate-projects.mjs server/projects.mjs /opt/miaoimg/migrations/$(date +%F)/
   ```

   **推论：观察窗口内不要删掉带迁移脚本的那一版镜像 tag**，或者就靠上面这份拷贝兜底。

### 媒体快照工具（历史每日任务已于 2026-10-07 停用）

2026-10-06 曾启用每天 03:30 UTC 的 `miaoimg-media-snapshot.timer`，默认保留七份；2026-10-07 按当前空间规则已禁用并停止该定时器。`deploy/snapshot-media.sh` 留作必要媒体迁移时的一次性工具，不在日常发布中调用，不默认重新启用定时器。

```bash
systemctl is-enabled miaoimg-media-snapshot.timer  # 当前应为 disabled
systemctl is-active miaoimg-media-snapshot.timer   # 当前应为 inactive
```

- 工具输出位于 `/opt/miaoimg/backups/media/<UTC 时间戳>/`。仅在明确的一次性迁移任务中使用；显式设置保留范围，不把脚本旧默认值七份当作现行日常策略。已有旧快照的独有字节已并入上文历史媒体归档。
- **用硬链接**（`cp -al`）：工作区媒体的每次写入都是「写临时文件 → 原子改名」，多项目迁移也是
  「复制到新路径 → 校验 → 再删旧路径」，都不原地改已有文件内容，所以硬链接快照能完整保留快照时刻的每个文件，
  而**新增占用只等于这之后新增或改过的字节**。实测：对 83MB 媒体，第二份快照新增占用 **0 MiB**。
  （注意 `du -sh 快照目录` 会把共享的块重复计算，看起来仍是 83M；脚本打印的是「本次新增占用」= 可用空间变化。）
- **它挡的是逻辑事故**：改错、误删、迁移出问题。**挡不了磁盘故障**——它和源数据在同一块盘上。
  真要容灾得把快照搬到别的机器/对象存储（后续可加）。
- 恢复单个文件：直接从快照目录里 `cp -a` 回去（快照里的文件是完整内容，不是增量补丁）。
- 被删掉的文件只要还有一份包含它的快照就还在；快照按份数轮换，超过保留份数的会连同里面的旧文件一起清掉。

## 媒体内容寻址（2026-10-06）：字节只存一份，其余地方只存引用

**要解决的问题**：同一张生成结果以前在盘上存两份——工作区里一份（`<账号>/<项目>/assets/<节点>/…`）、
生成结果缓存里一份（`_artifacts/<id>`）；同一张图贴进 10 个节点就是 10 份。用户的原话是
「你这个地方存一份一模一样的东西，那个地方又存一模一样的东西，那就不合理」。

**现在的布局**（`server/blob-store.mjs`）：

```
<MEDIA_ROOT>/<账号>/_blobs/<sha256>     有账号归属的字节（工作区文件 + 该账号的生成结果）
<MEDIA_ROOT>/_blobs/<sha256>            没有账号归属的字节（guest 生成结果）
<MEDIA_ROOT>/_artifacts/<id>            迁移前的老位置，迁移后清空（常量留给回滚与对账）
```

- `workspace_files.blob` / `artifacts.blob` 存 sha256；索引里的 `path` **不再对应磁盘文件**，
  盘上只有 blob。**排查问题不能再 `ls` 目录看画布结构**，走接口或读索引。
- **只在一个账号内去重**——账号目录是权限与归属的边界，跨账号去重会让「这份字节别人是不是也有」变成可探测的。
- 生成结果的字节放在**所有者**的桶里，所以「前端把生成结果写进画布」这一步天然命中同一份字节，
  一个字节都不会多写（线上实测：`/api/imagine/result/<id>` 的字节与画布素材落成同一个 blob）。
- 顺带的效果：复制节点/目录从「按体积搬字节」变成「插几行索引」，改名完全不动磁盘。

### 删除语义：删的是引用，不是字节

| 动作 | 索引 | 字节 |
|---|---|---|
| 画布上删节点 / 删画布 | 删行 | **不动**——生成历史那条引用还指向同一份字节 |
| 生成结果到期（`artifact_expiry`） | 删 artifacts 行 | **不动**——画布上还引用着同一份字节 |
| 最后一个引用也没了 | — | 才 unlink |

安全性靠一条闭包性质：**任何时刻「引用存在 ⇒ 字节存在」**。写入永远先落字节再提交引用行，
删除永远先删引用行再动字节（`WorkspaceFiles.deferBytes` 把字节释放推到事务提交之后——
在事务里删字节，事务一回滚就是不可恢复的数据丢失）。

活跃集合不存计数列，每次从两张表现查（`liveCount`）：**计数列会漂移，查询不会**。
回收之前还要过三道关，挡的是真实存在的并发（admin 进程的 `recoverStale` 与 image API 会同时动同一批 blob）：
① 先扫盘、后查活跃集合；② 300 秒宽限期（写入方复用已有 blob 时会 touch 一次 mtime，所以这个窗口是有效的，
不是摆设）；③ 回收时持写锁。

### 迁移：`scripts/migrate-media-blobs.mjs`

```bash
node scripts/migrate-media-blobs.mjs --report            # 只报账：多少项、去重能省多少、重复组
node scripts/migrate-media-blobs.mjs --link-only         # 建 blob + 校验，源一个不删、表结构一列不动
node scripts/migrate-media-blobs.mjs --apply             # 建 blob -> 校验 -> 回填索引 -> 翻布局 -> 回收旧位置
node scripts/migrate-media-blobs.mjs --rollback          # 退回路径树布局（回滚镜像前必须先跑这个）
```

**顺序是固定的：`migrate-projects.mjs` 在前，`migrate-media-blobs.mjs` 在后。** 反了的话项目迁移要的
路径树已经被这一轮清掉了。两个方向都有护栏，跑反了会直接拒绝并告诉你先做什么。

- **`--link-only` 是这个迁移唯一可以随便停的安全点**（对应项目迁移的 `--copy-only`）：blob 已整份建好并
  校验过，**源一个字节没删、表结构一列没动，旧镜像新镜像都能跑**。推荐在这里停下来抽验一轮。
- **不可逆的一步是回填索引**（`--apply` 的第 3 步）：从那一刻起索引行指向 blob，旧镜像读不了。
  **回滚镜像之前必须先 `--rollback`**，否则旧容器看到的是「索引在、路径树是空的」。
- 迁移用**硬链接**（同盘，不复制、不额外占空间）：省下来的空间来自去重——同一份内容第二次出现时
  不再建第二个 inode，回收阶段把多出来的那几份 unlink 掉。真正的空间释放在第 5 步，不是第 1 步。
- 任何一行搬不动就**整体停下并报出是哪一行**，不做部分成功。读不到的孤儿索引（迁移前就缺失的）
  加 `--allow-missing` 放行。索引里 `size` 是旧的（对不上实际字节）**不算搬不动**，按实际字节处理并修正索引。
- 迁移完成后空目录树与 `_artifacts/` 直接删掉，**不留观察期**：留着旧名字会让「只回滚镜像」看起来可行、
  其实是半通的（旧镜像读得到、写进去的是旧位置，和新代码分叉），那比明确的「必须先 --rollback」更危险。
- **脚本要提前拷到镜像之外**（同 `migrate-projects.mjs` 那条：镜像只保留当前版和上一版，
  发两次之后回滚工具就没了）。

### 对账：`node server/media-reconcile.mjs`

两个方向都要核，缺一个都会出事：

- **① 引用在、字节没了** —— **严重**，数据丢失。只报告、绝不自动处理（字节删了就是删了，没有别的副本）。
- **② 字节在、引用没了** —— 泄漏。`--fix` 回收（守宽限期）。
- 另外还核：③ 索引 size 与 blob 实际大小不符；④ `--verify-hashes` 时 blob 的内容哈希是否等于文件名；
  ⑤ 路径树上的残留（索引已指向 blob 但旧文件没删 = 回收没跑完）与孤儿文件（索引里根本没有，`--fix` 可清）；
  ⑥ 迁移没跑完的行。

退出码沿用老约定：有未处理的不一致 → 1，方便挂定时任务看告警。**②类必须是 0**；
出现 ①类就先别动任何东西，人工确认。

### 对运维的影响

- **nginx 一行都不用改**：`X-Accel-Redirect` 的落点是从 `file.diskPath` 推出来的
  （2026-10-06 那次「两处各算一份必然对不上」的修复留下的性质），blob 落在 `alias /opt/miaoimg/media/`
  覆盖范围内，内部 URI 自动变成 `/__media_internal/<账号>/_blobs/<sha>`。实测内容哈希与文件名一致。
- `x-workspace-revision` 语义不变（取自索引行的 revision，每次写入都换新的）。
- **需要一次性媒体快照时工具兼容 CAS**（`snapshot-media.sh` 扫整个 MEDIA_ROOT）；当前不运行每日快照。
  新写入永远是新 inode（临时文件 → 改名），从无原地改写，回收只 unlink、不会碰到快照的链接。
- 以 root 跑一次性脚本（`docker exec` / `docker run`）时，**属主由落盘层统一对齐媒体根**
  （`media-files.mjs` 的 `alignMediaOwner`），不再由每个脚本自己 chown——以前漏一处就是 nginx 403。

## 发布纪律与检查清单（2026-10-06 用一次线上 502 换来的）

**一次只允许一个发布者。** 默认从服务器上的明确提交准备独立构建上下文，记录提交与镜像标签。旧 `deploy-production.sh` 仍会 rsync 调用目录，使用兼容入口时只能输入该提交的干净快照，不能输入混合工作树。镜像记录 `org.opencontainers.image.revision`，执行流程见本文末尾“当前默认发布路径”。

发布前逐条过：

```bash
npm --prefix web run build                 # 服务器任务目录预检；正式构建仍在 Dockerfile 内
node scripts/check-server-modules.mjs      # 服务端裸导入都能解析（缺依赖会拦住发布）
for f in server/*.mjs scripts/*.mjs; do node --check "$f" || echo "语法错: $f"; done
ssh root 'df -h /; free -g'                # 磁盘与内存（曾观测构建峰值约 5.5GB；当前约 8GB RAM + 4GB swap）
```

部署脚本里有两道自检，**都不许删**（它们是互补的，各拦一类事故）：

1. **换容器之前**：`scripts/check-server-modules.mjs` 在镜像里解析 `server/` 的全部裸导入。
   少装依赖时镜像能构建成功、web 端口照常起，但 API 进程会在 import 阶段崩掉。
2. **换容器之后**：`scripts/container-health.mjs`（Dockerfile 的 `HEALTHCHECK`）探 web 端口**和部署时声明的内层 API 端口**。
   只探 4173 的话，「web 活着、API 死了」会被 docker 和发布脚本**双双判成健康**——那次 502 就是这么漏过去的。

**新增一个 `/api/<前缀>` 服务端路由时，nginx 那段不要手抄**（手抄就会漂移，漏一个前缀就是"本地好、线上 404"，2026-10-06 真踩过：`/api/plugins` 落到了档案 API 上静默 404）：

1. 加服务端路由本身；
2. 改 `web/vite.config.ts` 的**两个**代理段（`server.proxy` 开发用、`preview.proxy` 生产用——生产容器跑的是 `vite preview`，只改 dev 那处线上不通）；
3. 跑 `node scripts/nginx-api-routes.mjs` **重新生成 nginx 里那段 API location**（vite 的 `preview.proxy` 表是唯一来源；脚本遇到不认识的端口环境变量会直接报错退出，不会静默生成错的）。

校验照旧：拿真实 `nginx.conf` 复制一份、把 `sites-enabled` 指向临时目录只放新配置跑 `nginx -t`，**不要过管道**（`nginx -t | tail` 的退出码是 tail 的 0，会把失败吞掉），然后 `systemctl reload nginx`（不要 `restart`）。

**打快照前必须「工作树全干净」**（`git status --porcelain` 为空）——快照是从**提交**建工作树，
**未跟踪的新文件不在提交里**，而别的线的代码可能已经 import 它了：结果就是"看着没事、一构建就炸"
（2026-10-06 真出现过：`web/src/studio/generationProgressCore.ts` 是某条线新加的文件，另一条线已经 import）。
所以只提交并审核本任务需要的全部文件，构建从明确提交提取；其他任务的 WIP 另存，不能为了凑齐依赖把混合改动全部提交，也不把未提交文件手工塞入发布快照。

**顺序**：发代码（可逆，随时回滚镜像）→ 抽验 → 需要时再单独跑存量数据迁移（不可逆，见上面多项目那一节）。
把不可逆步骤和一次大发布拆开，是因为大发布本身已经带了多条线的改动，两者的风险不该叠加。

**回滚判据**（按顺序做，别直接换镜像）：

1. 站点 502 / 端点异常 → 先看 `docker logs --tail 50 miaoimg`，按报错定位；
2. 确认是本次镜像问题，且没有不兼容的数据迁移：健康检查失败由发布流程自动恢复旧容器；网页验收前临时保留一个 `miaoimg.previous-*` 停止容器及镜像，可停止新容器后恢复并重新检查挂载、登录、四个端口和网页。验收后仅留当前版，若以后要恢复旧代码，从 Git 明确提交重新构建，不长期占用服务器保存旧镜像。不能同时启动两个使用生产数据库的应用容器。
3. 数据布局已迁移时先按上文迁移工具恢复兼容布局，不能只切镜像。回滚后保留恢复成功的可用版本；失败候选由本次任务明确核对后清理，不用全局强制清理代替判断。

## 旧构建入口（保留兼容，不作为默认发布输入）

**默认在服务器上原生构建**：`deploy-production.sh` 把源码 rsync 到服务器的独立构建目录
（默认 `/opt/miaoimg-build`，不含数据/媒体/凭据），在服务器上 `docker build`，然后走原有的
「备份 → 换容器 → 健康检查 → 失败回滚」。好处是**不再需要本地模拟 amd64，也不再传输镜像**；
服务器上第一次构建要拉基础镜像和 `npm ci`，之后有层缓存会快很多。

本地 `npm --prefix web run build` 只作为发布前的**预检**（快速排掉语法/引用错误），不是交付物。

需要本地构建时（例如服务器不可用）：`DEPLOY_BUILD=local bash deploy/deploy-production.sh`
—— 会走旧的「本地模拟 amd64 构建 + 导出镜像 + rsync 续传 + 服务器 docker load」路径。

数据、媒体与凭据（`db/ images/ previews/ secrets/ .oip/runtime-data/ media/`）都在服务器挂载里，
**不进镜像、不参与同步、也不被 `--delete` 删除**。


## 当前默认发布路径（用户确认，2026-10-07）

服务器 `/opt/miaoimg-source` 是独立 Git 源码目录，任务在独立分支/工作树开发。先核对正在服务的镜像及尚未入库的热修，保存生产基线；再从明确提交在服务器构建。镜像标签 `org.opencontainers.image.revision` 记录实际构建提交。发布前确认队列空闲，串行发布，模块依赖检查、SQLite 在线备份、四端口健康检查与失败回滚必须执行。已确认的最小修复授权不重复询问。不要将本地 WIP、未跟踪文件或备份目录通过 rsync 覆盖生产，不直接修改运行中的容器作为开发。

发布后通过用户 Google Chrome 的登录表单进入网页，使用全局 playwright-cli 做少量真实生成，检查原始尺寸、播放、参数、画布回写、刷新持久化和后台积分记录。用户指定画布并要求保留结果时，保留所有有效节点、媒体和生成记录。只清理未使用临时文件和自己启动的进程。不要自动删除仍需要的旧容器、旧镜像或媒体回滚备份。

本地用 `git fetch production` 同步服务器已提交源码，再核对并快进当前源码分支。`production/current` 表示已入库的源码与运维说明，`production/runtime` 表示正在运行的应用源码；只改文档或维护脚本时二者可以不同，不需要重建应用镜像。旧未完成源码仅在 `wip/miaoimg-before-acceptance-20261007`，原散落文件可从 `/Users/cch/Developer/miaoimg-backups/20261007-pending-local` 恢复。旧三个临时工作树的提交保存在 `archive/*-20261007` 分支，目录已清理。

历史镜像记录（2026-10-07 当时阶段，不代表现在运行）：原版 `miaoimg:grok-ratio-20261007-1420` 以 `c6e5e2b` 保存其源码基线；文件挂载修复提交 `58fe01b`，Grok 自动格式提交 `9b304ca`，方舟图片链接传输提交 `c7482c3`。图片 MIME 修复提交 `89b1acd`。该阶段运行镜像 `miaoimg:canvas-mime-20261007-1530` 对应 `89b1acd267dffe9569fb000ead7e91b2c70f52f4`。后续运行版本以实际容器、镜像标签和 `production/runtime` 为准；保留范围按本文顶部当前空间规则执行。

## 画布上传与预览（2026-10-07）

本轮范围为图片、视频、音频、Markdown 和 TXT，不新增 PDF、Word、压缩包支持。图片、视频、音频每文件上限 100MB，文本文件上限 10MB，避免巨量正文阻塞编辑器；Markdown/TXT 读取正文后保存为可编辑文本节点。选择文件与拖入使用相同类型判断；浏览器没有 MIME 时按已知扩展名补齐，保存 MIME 与节点输出一致。

节点媒体直接写入唯一的新路径，不先请求创建两个空目录；服务端负责父路径及内容去重。图片展示与视频首帧使用账号鉴权的修订版预览缓存，原件下载、参考生成、编辑与播放仍取原文件。预览可以重建，不能将其大小或尺寸当作原件。

Nginx 的 gzip_types 必须同时包含 text/javascript 和 application/javascript；Vite 预览返回 text/javascript，漏掉会把数 MB 的画布与 Agent 代码按原大小传输。画布挂载不等待重复获取模型选项，节点在平移、缩放、选中时复核预览可见性。

### 官网静态发布（2026-10-14）

只更新官网时，使用明确提交构建镜像，再运行 `python3 deploy/publish-site.py --image <镜像>`。脚本只提取 HTML/静态资源，备份并平滑重载 Nginx；不替换用户 API 或独立管理容器。`/opt/miaoimg/site-current` 指向官网版本，`site-assets/assets/` 保留已发布的内容哈希资源，缺失资源回退运行容器；`site-release.json` 记录官网版本，API 运行版本仍以容器为准。首页不缓存，媒体继续使用版本目录。后续完整服务发布如包含官网变更，也必须执行此步骤，避免首页停留旧版。回滚使用 `site-backups/` 保存的配置和旧链接，先 `nginx -t` 再平滑重载。

官网新增视频后，用 `scripts/prepare-site-playback.py` 检查 `web/src/landing/films.ts` 中的完整公开清单及主宣传片。脚本在带 ffmpeg/ffprobe 的独立容器内运行，`--root` 指向挂载的官网媒体，`--films` 指向清单，`--output` 输出播放 URL 映射，`--report` 保存实际媒体参数与哈希。高于 4 Mbps 或浏览器编码不兼容的视频生成最高 1080p、保留帧率的 H.264/AAC 预览；仅索引在末尾的视频无损转封装。原片不改动，派生视频使用带源哈希的独立 URL，避免 immutable 缓存混用不同字节。将生成映射同步到 `web/src/landing/playback.json`，确认对应文件均存在后再构建、静态发布，并真实点击检查首帧、持续播放和拖动进度。只保留正式原件、实际使用的预览和必要结果记录，清掉生成过程的 `.pending.mp4`、临时容器、构建目录与镜像。

MP4 兼容版本准备后，再执行 `scripts/prepare-site-adaptive.py`；参数 `--playback` 读取前一步映射，`--output` 同步到 `web/src/landing/adaptive.json`。高于 550 kbps 的视频准备约 360p 的低码率首播及原有高清档，以 4 秒 VOD 片段发布到 `website-media/adaptive-v3/`。保留原始帧率；遇到源视频编辑列表导致无损切段丢开头时，重新编码该高清档并校对两档时长。浏览器按播放器尺寸及实际带宽选择档位；支持 MSE 时使用 Hls.js，其他支持 HLS 的浏览器用原生播放，其余保留 MP4 回退。固定主清单及首播清单随页面发布，媒体仍从 Nginx 读取，减少点击后的往返；初始仅加载一个目标的少量片段。检查必须覆盖关闭缓存的页面按钮实际播放，不能把单文件播放速度等同于整页体验。

主宣传片另生成低带宽 720p 中间档，配合首播档及原有 1080p 档自动选择。新增 `master-720.m3u8`，不覆盖已发布的双档主清单；正式播放资源按版本路径保持字节不变。
