---
name: script-writing
displayName: "剧本创作"
displayName_en: "Screenwriting"
description: "剧本这一层：电影、广告、短片的原创剧本，已有故事的原创改编，连续分集短剧和漫剧的大纲与单集，以及给现有剧本做诊断。只写剧本时使用；要一路做到资产和视频，用短剧漫剧全流程。"
description_en: "The script layer: original film, ad and short scripts, adaptations, episodic short-drama and comic-drama outlines and episodes, and script diagnosis. Use for scripts only."
---
# 剧本创作

把一句创意、一部小说或一份旧稿写成可以往下拆资产和分镜的剧本。

## 什么时候用别的板块

| 任务 | 用哪个板块 |
| --- | --- |
| 剧本写完还要做资产、分镜和视频，整条流程一起做 | 短剧漫剧全流程（drama-director） |
| 口播、解说、广告等短视频的脚本和时间安排 | 视频复刻与创作（video-create）里的 `video-script` |
| 把定稿剧本拆成镜头 | 分镜设计（storyboard） |

## 先选方法

| 方法 | 什么时候用 | 读取 |
| --- | --- | --- |
| 影视编剧创作 | 电影、广告、短片、独立场景的原创剧本 | `readSkill({name:"miaotu-film-screenwriting"})` |
| 剧本原创改编 | 把已有故事改成原创方案（换人物、世界观、冲突） | `readSkill({name:"miaotu-original-screenplay-adaptation"})` |
| 分集短剧编剧 | 连续分集短剧、漫剧：立项、赛道、大纲、开场钩子、断章、反转、跨集伏笔台账、单集撰写和精修 | `readSkill({name:"short-drama-factory"})` |
| 影视剧本分析 | 给现有剧本做诊断、改稿建议和创作规范手册 | `readSkill({name:"miaotu-film-script-analysis"})` |

## 分集短剧编剧的读法

- 先读入口，按入口里的「动态参考库按需挂载矩阵」只挂当前模式需要的文件。入口里写成 `references/…`、`templates/…`、`examples/…` 的文件，用 `readSkill({name:"short-drama-factory", path:"references/…"})` 读取。
- 入口里的集数、篇幅是默认档位。用户指定了集数、篇幅或只要一集时，按用户的要求写，不擅自扩成 60–100 集。
- 长篇写之前读唯一的正式台账，写完更新它；不在别处另建一套人物和伏笔表。
- `scripts/` 下的检查脚本只能在桌面端、本机操作已授权时运行，做法见 `readSkill({name:"drama-director", path:"references/miaoimg-adapter.md"})` 的「本机脚本」。没有运行的检查只能写成人工审查。

## 和画布配合

- 剧本、大纲、分集梗概写进文本节点；分集剧本一集一个文本节点，按集数从左到右排开，节点名写清集数。
- 很长的正文放进文档面板，画布上的文本节点放摘要和链接。
- 后面的资产、分镜都从这些文本节点读取。修改剧本时直接改原节点，不另建一份。

## 读取规则

- 方法正文是完整的专业方法：照正文执行，不凭印象改写、压缩，也不换成别的流程。
- 只读当前任务需要的那一个方法和章节。正文被截断时，用返回的 nextOffset 接着读需要的部分。
- 正文里的平台、模型、时长和价格是写作时的示例；实际能用的模型和参数以画布节点返回的为准。
- 正文里的相对路径，用该方法的 ID 读取：`readSkill({name:"方法 ID", path:"references/…"})`。
