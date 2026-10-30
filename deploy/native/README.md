# 妙图生产部署（美国原生）

业务数据库配置、首次导入、隔离验收和回退边界见 [云端数据库与缓存](../../docs/云端数据库与缓存.md)。本目录的新应用与备份单元按 PostgreSQL + Redis 配置；安装这些单元前先完成数据库导入及私有配置。实际运行后端由只读巡检确认。

## 拓扑

- 全部妙图服务和唯一写入的账号库在美国 `172.93.164.68`，使用 Nginx + systemd + Node/Python。所有妙图域名指向这台机器，不按用户 IP 选服务器。
- 不得恢复大陆实例、大陆中继或 `miaoimg-egress.service` 一类指向已释放机器的配置。美国对部分运营商的直连问题按实际出口单独排查，不承诺全网可达。
- 模型网关 Sub2API 以独立 Docker 容器运行，保持原有运行方式。
- ICP 备案：用户决定暂不办理。将来恢复时用真实信息重新核实主体、网站内容和服务器资格，不虚构网站性质。

| 单元 | 内容 |
| --- | --- |
| `miaoimg.service` | 页面服务 4173、图片 API 4175、管理 API 4184；启动前检查 PostgreSQL、Redis、导入标记并运行 `scripts/check-server-modules.ts`；停止时等已受理任务收尾 |
| `miaoimg-catalog.service` | 桌面灵感库只读档案目录 4176 |
| `miaoimg-library-content.service` | 独立精选内容与视频封面 4177 |
| `miaoimg-sync.timer` | 每六小时检查公开目录和素材更新，只重启目录服务，不重启生成/计费主进程 |
| `miaoimg-backup.timer` | 每天上海时间 04:15 后随机十分钟，生成并校验唯一账号库快照 |
| Nginx | 官网与管理后台静态文件、媒体 Range、鉴权后的内部媒体直出、API 反代；配置在本目录 `nginx*.conf` |

- 所有服务只监听回环。公网 `/health` 指向 API 4175；目录服务在 4176 独立自检。
- 同步、备份和发布共用锁 `/run/lock/miaoimg-deploy.lock`。
- 生产 Node 为 `/opt/miaoimg/node-v22.23.4-linux-x64`。固定 Node 版本和锁定依赖是一次交付整体，不能单独替换 `node` 或随意 `npm update`；Python/系统工具兼容性以真实启动为准。
- TLS 证书在 `/etc/letsencrypt/live/miaoimg.cn/`，`certbot.timer` 自动续期并在成功后 reload Nginx。
- 日志用 systemd journal，持久上限 100MB、运行时 50MB。

## 目录

| 路径 | 内容 |
| --- | --- |
| `/opt/miaoimg/releases/<完整SHA>` | 某一版的服务代码、锁定依赖、官网与后台静态资源（后台在 `admin-web/`） |
| `/opt/miaoimg/current` | 指向当前版本的符号链接，原子切换；版本以实际运行进程为准，不能只看链接 |
| `/opt/miaoimg/.oip/runtime-data` | 运行状态文件及迁移前 SQLite；启用 PostgreSQL 后旧 SQLite 冻结留存，不能作为活跃写库 |
| `/opt/miaoimg/media` | 桌面输入与待取回结果的短期副本，不是用户云盘 |
| `/opt/miaoimg/images`、`previews`、`db`、`catalog` | 灵感库原图、预览、数据包与展开数据库 |
| `/opt/miaoimg/site-current`、`site-assets`、`website-media` | 官网版本、内容哈希资源、官网媒体 |
| `/opt/miaoimg/desktop-downloads` | 桌面正式更新包；`tools/` 是客户端下载 ffmpeg 的位置 |
| `/opt/miaoimg/backups/management-native-latest.pgdump` | PostgreSQL 当前一致性快照 |
| `/opt/miaoimg/backups/management-native-latest.sqlite.gz` | 迁移前 SQLite 恢复点，保留原样 |
| `/opt/miaoimg/secrets` | 供应商 Key 文件 |
| `/etc/miaoimg/main.env` | 运行配置，权限 600 |
| `/var/lib/miaoimg/vite-temp` | Vite 预览缓存；`web/node_modules/.vite-temp` 指向这里，版本目录保持只读 |
| `/opt/miaoimg-ops/` | 运维脚本（`native/`、`deploy/` 等） |

以上数据目录和正式文件的禁删规则见 [AGENTS.md](../../AGENTS.md)「数据保护与禁删清单」。

服务器只保留账号、价格/账本、任务/请求记录、短期输入和待取回结果。桌面原件、画布和项目先写本机，客户端确认保存后按引用回收服务器副本，未取回的按既有期限处理。公共案例、灵感库图片/预览/目录、官网素材和正式下载长期保留；部分公开视频按目录 ID 由服务器转发上游，并非所有原片都长期缓存。

## 客户端地址

客户端云端地址为 `https://miaoimg.cn`，更新源为 `https://miaoimg.cn/desktop-downloads/updates/`，会话和取回地址校验绑定同一 origin。只换服务器 IP 不需要改客户端或发新包；更换域名/origin 必须另行验收登录恢复、素材地址、任务取回和更新。

## 只读检查

```bash
deploy/inspect.sh                                          # 本机执行，原生主机上自动运行 inspect-native.py
ssh root python3 /opt/miaoimg-ops/native/inspect-native.py # 直接在服务器检查
```

它报告服务状态、实际 PID 与工作目录、端口、账号库计数和余额不变量，不读密钥。检查 PostgreSQL 候选时显式传 `--unit` 和候选私有 `--env-file`；SQLite 历史快照检查使用 `--db`。连接配置仅用于连接，不输出凭据。它不能证明外部域名、真实生成、付费结算或跨账号权限已验收。

## 发布

完整自动发布工具尚未实现，按以下步骤手动执行。只发布本次需要更新的组件（API、管理后台、官网、桌面更新各自独立）。

1. **本机构建**：`npm run build:web` 生成 `web/dist`；在 `web/` 下 `vite build -c admin.config.ts` 生成 `web/admin-dist`。
2. **建版本目录**：服务器上 `cp -a /opt/miaoimg/current/ /opt/miaoimg/releases/<完整SHA>`，沿用锁定依赖。`package-lock.json` 有变化时另装依赖并做真实启动验证。
3. **同步代码**：`git archive <SHA> server scripts package.json package-lock.json web/scripts web/vite.config.ts web/preview.config.ts web/admin.config.ts web/package.json` 导出后 rsync 到新目录；`web/dist` → `web/dist`，`web/admin-dist` → `admin-web`。
   - 先 `rsync -n --delete --itemize-changes` 试运行，确认改动范围和 `git diff` 一致、没有误删。
   - 本机 shell 是 zsh，变量里的多个参数不会自动拆开，rsync 参数写进 bash 脚本执行。
4. **模块自检**：在新目录执行 `node scripts/check-server-modules.ts`。
5. **候选验收**：
   - 用 PostgreSQL 一致性备份恢复到独立候选库；首次从 SQLite 导入按数据库文档执行。
   - 候选使用自己的数据库角色、Redis 命名空间、输出目录和回环端口。不能只复制生产环境文件后关闭生成开关，更不能依赖只读文件系统保护远端 PostgreSQL。
   - 配置 `MIAO_CANDIDATE_MODE=true`、名称含 `candidate` 的数据库与 Redis 命名空间、独立 `OIP_DATA_DIR`、`OIP_MEDIA_ROOT`，以及候选的四个端口。禁用正式更新与全部真实外部副作用。
   - systemd 的 `EnvironmentFile` 会覆盖 `-p Environment=`，候选覆盖项应写入候选私有文件；生产媒体原件只读。
   - 验收数据库摘要、会话与权限、账号/订单/账本、幂等与并发退款、模型目录、素材引用及本机取回；使用现有授权账号，不创建测试账号。真实生成单独授权。
6. **切换**：
   1. 持有 `/run/lock/miaoimg-deploy.lock`，暂停会改同一数据的同步/维护任务。
   2. 确认没有未完成的受理任务，停止旧写入方。
   3. 备份活跃数据库与 `main.env`。首次数据库切换必须重新制作最终 SQLite 快照并导入，不能直接用演练期间的旧副本。
   4. 核对 `MIAO_DATABASE_URL`、Redis 独立凭据、命名空间、导入标记与 `OIP_RUNTIME_REVISION`。
   5. `ln -sfn` 加 `mv -T` 原子切换 `current`，随后启动 `miaoimg.service`。
   6. 核对四个端口、实际进程 cwd、只读巡检、数据库计数、现有会话和账本，以及模型网关的健康；再恢复业务入口。
7. **回退**：只允许退回仍兼容当前 PostgreSQL 的代码版本。已有新交易后，禁止恢复旧 SQLite 或旧整库覆盖新交易。不能兼容时先保持维护状态，按数据库文档修复或单独核实数据迁移。
8. **收尾**：删除候选目录（内含带密钥的配置）和本机的 `web/dist`、`web/admin-dist`。新版本稳定后删除旧版本目录。

DNS 变更时保留旧值与 TTL，核对所有 A/AAAA、www、支付回调和更新下载；缓存期内旧入口只能转到唯一写入方。

## 桌面更新源

用 `deploy/publish-desktop-updates.sh <版本>` 发布，命名与改名规则见[桌面版本发布与包命名](../../docs/桌面版本发布与包命名.md)。发布后从公网核对 `latest*.yml` 版本、版本化下载和固定下载别名；服务器本机回读只用于诊断。

## 官网发布

只改官网或外置安装脚本不需要重打客户端。版本、更新日志和安装说明按 [macOS安装与发布规范](../../docs/macOS安装与发布规范.md) 核对。

1. 在干净工作树 `npm --prefix web run build`，完成页面验收。
2. 把 `web/dist/index.html`、`web/dist/assets`（和需要更新的 `install-mac.sh`）上传到服务器本轮私有 staging。
3. 执行 `python3 /opt/miaoimg-ops/native/publish-site.py --dist <staging/dist> --revision <完整SHA> --install-script <staging/install-mac.sh>`。脚本持有发布锁，保留旧哈希资源，备份旧 HTML/安装脚本，原子切换官网并 reload Nginx，核对四个端口和主服务 PID 未变；失败恢复旧入口。
4. 从公网实际读取页面、脚本、版本化下载和更新日志，用浏览器核对最新版本标签。保留上一份官网/脚本回滚点，清理 staging 和本机预览进程。

官网视频：

- 主视频和案例共用一个播放器。首屏不自动下载完整视频，不同时预载多条；只在用户移入、聚焦或准备播放时加载当前目标；暂停、离开视口、切换和隐藏页面时停止取流，卸载时销毁播放器。
- 新增视频先用 `scripts/prepare-site-playback.py` 生成兼容 MP4（高于 4 Mbps 或编码不兼容的出最高 1080p H.264/AAC 预览，原片不改），映射写入 `web/src/landing/playback.json`；再用 `scripts/prepare-site-adaptive.py` 生成低码率首播档与高清 HLS 分段（发布到 `website-media/adaptive-v3/`），映射写入 `web/src/landing/adaptive.json`。主视频另有 720p 中间档 `master-720.m3u8`。脚本在带 ffmpeg 的临时容器里运行。
- 派生文件用带源哈希的独立 URL，已发布的播放资源按版本路径保持字节不变，不覆盖旧清单。
- 验收以关闭缓存时真实点击的首帧、连续播放、拖动和切换为准，不能只看 HTTP 状态或单独打开文件。清理 `.pending.mp4`、临时容器和构建目录，已引用的分段不是临时文件。

## 备份与清理

- 活跃 PostgreSQL 每日备份为 `backups/management-native-latest.pgdump`，归档校验通过才原子替换；定期在空库实际恢复并核对数据摘要。迁移前的 SQLite 快照冻结保留。数据库备份不含媒体，也不等于异地容灾。
- 清理时保留：当前运行版本；唯一账号库快照；`desktop-downloads/tools`；当前和最近一个正式更新包版本及固定下载别名；`site-current` 指向的官网版本、上一版和最新一份官网备份；有效的桌面暂存、公共案例和账户记录。
- 维护脚本必须适配原生运行方式后才能启用，Docker 时代的清理/同步 timer 不能原样复制（见 [deploy/README.md](../README.md)）。
- 验收后清理本轮临时下载、解压包、临时代理、隧道和候选进程。正式下载包、用户原片、账本、唯一恢复点和其他任务的工作不属于垃圾。

## 运维访问

- 服务器地址、SSH 方式和密码在仓库外 `/Users/cch/Developer/miaoimg/本地资料/私有配置/服务器访问.md`。本机 SSH 别名 `root` 指向美国生产。Sub2API 服务器的地址和 SSH 入口也在这份私有记录里。
- 服务器 SSH、防火墙等安全设置保持用户原样，修改前先征得同意。
- 部分本机出口下 SSH 会在握手前断开（`kex_exchange_identification: Connection closed`），这不是服务器故障。处理：
  1. 用 `/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo` 单独起临时进程，配置从用户订阅里挑一个节点生成，只监听本机端口。
  2. SSH 和 rsync 加 `ProxyCommand nc -X 5 -x 127.0.0.1:<端口> %h %p`（rsync 可用 PATH 里的 ssh 包装脚本）。
  3. 不改用户正在用的 Clash 配置和选中节点；用完关闭临时进程，删除它的配置（内含节点凭据）。

## 灵感库内容发布

图片/视频分类、独立内容版本、封面缓存及内置 Agent API 见[灵感库与内容发布](../../docs/灵感库与内容发布.md)。素材内容发布不重打客户端包，也不改桌面更新源。新增服务先在独立端口验收，再配置 `library-content.conf` 并回读资源类型。
