# 妙图 MiaoImg

妙图是以桌面创作为主体的 AI 图片/视频创作产品。本仓库包含：

- **桌面客户端**：本机画布（节点、连线、文档、媒体处理）、内置 Agent、桌面灵感库与案例；项目、素材和生成结果保存在用户电脑。
- **官方网站与管理后台**：网页只有这两部分，网页画布已不存在。
- **共用 API**：登录、积分与支付、模型目录与询价、生成任务的提交与取回、MCP。

模型：图片有 GPT Image、Seedream、Grok；视频有 Seedance 2.5 / 2.0 / 2.0 Fast / 2.0 Mini、MiniMax H3、Grok；文本有 GPT、Grok、DeepSeek 等。豆包、Dola 通过用户在桌面登录的平台账号使用。各模型的渠道、能力和参数见[模型参数对照](docs/模型参数对照.md)，规则见 [AGENTS.md](AGENTS.md)。

## 代码模块

| 路径 | 内容 |
| --- | --- |
| `desktop/` | Electron 宿主：本机工具、项目与结果保存、任务取回 |
| `desktop/renderer/` | 桌面界面与本机画布，独立依赖和构建 |
| `web/src/landing/`、`web/src/admin/` | 官网、管理后台 |
| `server/` | 共用 API；`server/web/` 网页读取工具，`server/network/` 网络出口策略 |
| `server/builtin-skills/`、`skills/` | 内置 Skill |
| `deploy/native/` | 生产部署配置与脚本 |

## 桌面开发

本机直接用 Node（≥ 22.19）+ Electron，不需要 Docker。

```bash
npm run setup     # 首次或 lockfile 变化后：安装根、desktop、renderer 三处依赖
npm run dev       # 准备 .app 并启动桌面
npm run build     # 只准备 .app，不生成安装包
```

不加隔离参数直接运行会连接正式 API。开发和验收前按[开发隔离与桌面发布](docs/开发隔离与桌面发布.md)设置独立 profile、workspace、云端地址，并关闭更新与生成。

`npm run desktop:renderer` 只启动界面静态服务，没有本机 API，登录、保存、任务和画布必须用完整桌面验证。

## 官网与 API 开发

```bash
npm ci
npm --prefix web ci
OIP_ENABLE_ARCHIVE=false ENABLE_MODEL_CALLS=false npm run dev:web
```

终端打印的根地址是官网。`dev:web` 会启动 API 服务，运行前核对它使用的数据库路径、凭据和副作用。需要本机完整灵感库时用 `npm run data:pull`。

## 打包与发布

- 桌面：macOS 与 Windows 都从 `desktop` 构建入口打包（先构建 renderer 界面，再编译宿主与共用服务模块）。流程见[开发隔离与桌面发布](docs/开发隔离与桌面发布.md)，版本号与包命名见[桌面版本发布与包命名](docs/桌面版本发布与包命名.md)。
- 服务端与官网：原生部署在美国服务器，见 [deploy/native/README.md](deploy/native/README.md)。
- 用户使用教程：[妙图使用手册](https://ccnmkd2j0e36.feishu.cn/docx/FbhSdMKe3oIOlVxBQuFcxEhhn5f)。

## 数据与密钥

- 桌面项目、画布、正文、素材与成品由本机运行时保存，不随源码目录整理而迁移，也不写进安装包。
- 云端保留账号、积分、订单、任务、计价与必要诊断记录；生成结果由桌面取回写入本机，服务器只短时保存交付副本。
- 妙图模型 Key 放服务器密钥目录 `/opt/miaoimg/secrets/`，一个 Key 一个文件，文件名映射见 `server/runtime-secrets.ts` 的 `SECRET_FILES`；新增模型通道只加文件。本地开发用仓库根目录的 `secrets/`。两处都不进 Git。用户自配模型由桌面用户自己配置。
