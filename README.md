# 妙图 MiaoImg

妙图以桌面创作为主体，官网、管理后台与共用 API 在同一 main 主线按职责维护，包含：

- 灵感库与落地页
- 登录、额度、支付和管理端
- 桌面本机画布：节点连接、文档和媒体处理，素材与结果保存在用户电脑
- 统一模型路由：GPT Image / Seedream / Grok 图片；MiniMax H3 / Seedance 2.0（含 mini）/ Seedance 2.0 Fast / Grok 视频；GPT 6.1 Sol / Grok 4.5 / DeepSeek Flash 文本
- 模型资格和结算：妙图模型校验正常账号与正积分，媒体与短文本沿用后台计价；Agent 当前暂不记账，自配模型不检查妙图积分

## 代码模块与开发入口

- `desktop/`：Electron 宿主、本机工具、项目与结果保存。
- `desktop/renderer/`：桌面界面、本机画布、节点与桌面灵感库；独立依赖和构建入口。
- `web/src/landing/`、`web/src/admin/`：官网与管理后台；不构建旧网页画布。
- `server/`：共用服务端 API；`server/web/` 管网页工具，`server/network/` 管网络出口。

产品开发只在 main 进行。首次准备桌面依赖使用 `npm run setup`，运行使用 `npm run dev`（`desktop:dev` 保留为同一入口），`npm run build` 只构建本机运行时，不生成安装包；`npm run preview` 构建后打开桌面。官网与后台使用明确的 `setup:web`、`dev:web`、`build:web` 和 `preview:web` 命令。

`npm run desktop:renderer` 只启动无本机 API 的界面开发服务；同样，`desktop/renderer` 内的 `preview` 只用于静态检查。它们不启动图片、管理或档案服务，不初始化业务数据库，也不能替代完整桌面的登录、任务与画布验收。

本次整合未发布或更新安装包；网页画布冻结源码仍在统一资料目录保留。参考目录中是上游原文件，不执行其中的安装、工作流或测试脚本。

## Docker 运行

本地运行官网、管理入口及共用 API 镜像：

```bash
cp .env.docker.example .env.docker
docker compose up -d --build
```

默认访问：`http://127.0.0.1:4174/`

停止：

```bash
docker compose down
```

配置模型时把 Key 放进服务器密钥目录（`/opt/miaoimg/secrets/`，容器只读挂载到 `/app/secrets`；
本地开发用仓库根目录的 `secrets/`，两份都不入库），一个 Key 一个文件：

```bash
echo '<key>' > /opt/miaoimg/secrets/deepseek-api-key
chown 1000:1000 /opt/miaoimg/secrets/deepseek-api-key && chmod 600 /opt/miaoimg/secrets/deepseek-api-key
```

文件名与字段的对应关系在 `server/runtime-secrets.ts` 的 `SECRET_FILES`；新增模型通道只加文件，
不改发布脚本。模型接口由容器内的统一路由提供，画布只按当前模型契约取参数、报价和任务状态。

## 服务器发布

完整源码以本机 main 为维护主线，服务器发布使用明确提交的独立临时构建目录；`/opt/miaoimg` 只保存持久数据，不能作为源码同步目标。发布后核对运行版本、进行网页验收并保留必要回滚，临时构建目录按项目规则清理。Yunshu、Dola、数据库等现有配套服务继续运行。

当前发布与空间规则见 [AGENTS.md](AGENTS.md) 和 [部署说明](deploy/README.md)。

下面的镜像传输脚本用于另行交付客户或服务器不可用时的备选，不是当前妙图线上默认发布路径。准备目标服务器环境文件后执行：

```bash
REMOTE_HOST=user@example.com \
REMOTE_ENV_FILE=/opt/miaoimg/.env \
REMOTE_DATA_DIR=/opt/miaoimg/data \
./deploy/publish-docker-image.sh
```

该交付脚本负责构建并传输镜像、替换容器及挂载数据。当前 `https://miaoimg.cn/` 是产品官网，`https://admin.miaoimg.cn/` 是独立管理站点，管理静态页和 API 由管理容器提供；旧 `https://canvas.miaoimg.cn/` 入口保持现有跳转。旧网页画布已冻结，不再通过 `/?studio=1` 启动。

## 本地开发

桌面源码开发使用本文上方的 `npm run dev`。官网与共用 API 单独开发时：

```bash
npm ci
npm --prefix web ci
OIP_ENABLE_ARCHIVE=false ENABLE_MODEL_CALLS=false npm run dev:web
```

终端打印的根地址是官网。`start.sh` / `start.bat` 是包含 Python 和公开灵感库数据准备的官网/API 引导，不是桌面安装器；它们会先安装根服务依赖，再安装官网依赖。桌面日常开发不需要下载整套公开素材。

## 桌面端构建与版本同步

Skill 的完整目录、创作逻辑、本机工具接线和桌面/网页能力边界统一见[技能适配说明](docs/技能适配说明.md)。用户使用教程见[妙图使用手册](https://ccnmkd2j0e36.feishu.cn/docx/FbhSdMKe3oIOlVxBQuFcxEhhn5f)。

macOS 与 Windows 均从 main 的 desktop 构建入口打包；两者先构建 desktop/renderer 的桌面界面，再编译宿主与共用服务模块。官网 web 工程单独构建，不写入桌面运行时。版本关系、下载和清理步骤见[桌面端构建与版本同步](docs/桌面端构建与版本同步.md)。

## 数据与持久化

- 桌面项目、画布、正文、素材与生成结果由本机运行时保存；关闭后仍从本机项目恢复。桌面文件不随源码目录整理而迁移，也不会写进安装包。
- 桌面生成调用的云端保留账号、请求、上游状态、计价与必要诊断数据；生成结果由桌面取回并写入本机画布，不长期保存桌面用户的媒体文件。
- 服务器 `/app/data` 等目录使用独立持久挂载；用户、积分、订单、生成与审计记录不随容器更换而删除。既有云端历史文件和兼容接口不属于源码归档清理范围。
- 灵感库公开数据库及媒体来自服务器已有挂载；需要在本机准备完整库时使用 `npm run data:pull`，不在每次镜像构建时重新下载。
- 妙图模型 Key 从服务器密钥目录读取，环境变量仅作既有部署回退；用户自配模型由桌面用户配置，不写入项目源码。密钥索引和运行配置保留在不入库的私有目录。
