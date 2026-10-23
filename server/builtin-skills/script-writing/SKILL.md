---
name: script-writing
displayName: "剧本创作"
displayName_en: "Screenwriting"
description: "剧本板块：原创编剧、改编、分集短剧规划、短视频脚本和剧本诊断。先判断要写哪一种，再读取对应方法。"
description_en: "The screenwriting section: original scripts, adaptations, episodic short-drama planning, short-video scripts and script diagnosis."
---
# 剧本创作

负责故事和剧本这一层：从一句创意、一部小说或一份旧稿，写成可以往下拆资产和分镜的剧本。

## 先选方法

| 方法 | 什么时候用 | 读取 |
| --- | --- | --- |
| 影视编剧创作 | 电影、广告、短片、独立场景的原创剧本 | `readSkill({name:"miaotu-film-screenwriting"})` |
| 剧本原创改编 | 已有故事改成原创方案（换人物、世界观、冲突） | `readSkill({name:"miaotu-original-screenplay-adaptation"})` |
| 分集短剧编剧 | 连续分集短剧、漫剧的大纲、钩子、断章、伏笔台账和单集撰写 | `readSkill({name:"short-drama-factory"})` |
| 剧本与分镜 | 口播、解说、广告等短视频脚本和语义时间 | `readSkill({name:"video-script"})` |
| 影视剧本分析 | 给现有剧本做诊断、改稿建议和创作规范手册 | `readSkill({name:"miaotu-film-script-analysis"})` |

## 和画布配合

- 剧本、大纲、分集梗概写进文本节点；分集剧本一集一个文本节点，按集数从左到右排开，节点名写清集数。
- 很长的正文可以放进文档面板，画布上的文本节点放摘要和链接。
- 后续的资产、分镜都从这些文本节点读取，修改剧本时直接改原节点，不要另建一份。

## 读取规则

- 下列每个方法都是原作者的方法原文，只改了名称；细节以原文为准，不要凭印象改写。
- 只读当前任务需要的那一个方法，不要一次把整个板块读完。正文较长时 readSkill 会截断，用返回的 nextOffset 接着读需要的章节。
- 方法里写到的平台、模型、时长、比例和价格是当时的示例。实际能用的模型和参数，以画布节点返回的为准（getCanvas、node:getConfig），费用每次用节点的 estimate 重新询价。
- 方法原文里的相对路径，用该方法自己的名称读取，例如 `readSkill({name:"方法名", path:"references/…"})`。
- 方法里要用到本机软件时，桌面端先取得授权并检查软件是否已安装；缺少时按统一工具说明，在用户任务授权范围内准备依赖。妙图不会因为读取方法就自动安装软件。生成结果保留在当前画布或用户指定的文件夹。网页端只用当前实际可用的工具。
