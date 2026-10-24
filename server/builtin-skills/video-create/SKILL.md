---
name: video-create
displayName: "视频复刻与创作"
displayName_en: "Video remake and production"
description: "照着一条参考视频复刻新版本，或从零做口播、街访、双人播客、演示解说、排名对比、单段剧情短片；含策划、脚本、导演、表演、补充画面、声音、字幕、动态图形、连续性和成片复查。"
description_en: "Remake a reference video, or make talking heads, interviews, podcasts, explainers, rankings and single-scene drama, with planning, script, direction, sound, captions, graphics and review."
---
# 视频复刻与创作

做一条完整的短视频：最快的入口是照着一条参考视频复刻，也可以从一个想法从零做起。画面、字幕、补充画面和特效都锚定在台词上，而不是锚定在秒数上。

## 什么时候用别的板块

| 任务 | 用哪个板块 |
| --- | --- |
| 连续多集的短剧、漫剧剧集 | 短剧漫剧全流程（drama-director） |
| 只要看懂参考视频、出拉片报告，不做新版本 | 视频拉片（video-analysis） |
| 单张图片或整体视觉风格 | 图片与视觉指导（image-direction） |

## 先选方法

先定是复刻还是从零做、做哪种形式，再只读这一种形式和真正需要的环节。

| 方法 | 什么时候用 | 读取 |
| --- | --- | --- |
| 视频复刻 | 保留参考视频的结构和表达关系，换人物、产品、语言或风格做新版本 | `readSkill({name:"video-remake"})` |
| 制作总纲 | 不确定从哪里开始，或需要完整的导演与制作流程 | `readSkill({name:"video-create", path:"references/core.md"})` |
| 创作策划 | 把需求、受众和参考整理成创作方案 | `readSkill({name:"video-plan"})` |
| 脚本与时间 | 口播、解说、广告等短视频的脚本和语义时间 | `readSkill({name:"video-script"})` |
| 导演指导 | 动作、表演、运镜和剪辑指导 | `readSkill({name:"video-direction"})` |
| 人物与表演 | 人物声音、态度、对白和动作 | `readSkill({name:"video-performance"})` |
| 角色与素材连续性 | 多机位下人物、产品和场景保持一致 | `readSkill({name:"video-continuity"})` |
| 补充画面 | 补充画面的选择和交接 | `readSkill({name:"video-broll"})` |
| 声音与混音 | 对白、原声、配乐和音效 | `readSkill({name:"video-sound"})` |
| 字幕设计 | 字幕分句、字体和强调 | `readSkill({name:"video-captions"})` |
| 画面与动态图形 | 图形层次、榜单和动态图形 | `readSkill({name:"video-graphics"})` |
| 成片复查 | 用真实成片核对画面、时长、字幕和声音 | `readSkill({name:"video-review"})` |

视频形式：

| 形式 | 读取 |
| --- | --- |
| 口播（单人面向观众） | `readSkill({name:"video-talking-head"})` |
| 街访与访谈 | `readSkill({name:"video-interview"})` |
| 双人对话与播客 | `readSkill({name:"video-podcast"})` |
| 产品演示、屏幕教程和解说 | `readSkill({name:"video-explainer"})` |
| 榜单、排名和对比 | `readSkill({name:"video-ranking"})` |
| 单段剧情短片（一个场景、一段剧情） | `readSkill({name:"video-short-drama"})` |

## 和画布配合

- 镜头画面用图片或视频生成节点，口播和对白的声音用音频节点；已有素材导入成媒体节点，用节点自带的截取、分离、提取音轨处理。
- 复刻时把参考视频放进视频节点，按方法先看懂它，再把结构连到后面的生成节点。
- 成片后按 `video-review` 用真实输出核对，不能只看提示词。

## 正文里的占位符

先读 `readSkill({name:"video-create", path:"references/miaoimg-tools.md"})`。正文里的 `video-tool`、`@video-tool/`、`VIDEO_SOURCE_URL`、`VIDEO_WEBSITE` 是占位符，不能当作真实命令、包名或网址执行。桌面端先调用 `localToolInfo({tool:"video"})`，看 installed 是否为真，再用返回的 replacements 还原执行所需的名称；没有安装时，只在用户的任务需要、且在本机操作授权范围内，按正文的安装步骤准备。模块文件里的占位符同样要替换。

## 读取规则

- 方法正文是完整的专业方法：照正文执行，不凭印象改写、压缩，也不换成别的流程。
- 只读当前任务需要的方法和章节，不一次读完整个板块。正文被截断时，用返回的 nextOffset 接着读需要的部分。
- 正文里的平台、模型、时长、比例和价格是写作时的示例；实际能用的模型和参数以画布节点返回的为准（getCanvas、node:getConfig），费用每次用节点的 estimate 询价。
- 正文里写成 `references/…` 的路径，用 `readSkill({name:"video-create", path:"references/…"})` 读取。
- 网页端只用当前实际可用的工具；生成结果放在当前画布或用户指定的文件夹。
