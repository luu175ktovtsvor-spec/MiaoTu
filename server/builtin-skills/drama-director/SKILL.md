---
name: drama-director
displayName: "短剧与漫剧制作"
displayName_en: "Short drama and comic drama production"
description: "短剧与漫剧制作板块：从剧本到资产、机位、分镜、对白、段落衔接和视频提示词的完整流程，画布上的实际制作，单段短剧，以及写实、玄幻动作段导演。"
description_en: "The short-drama and comic-drama section: the full flow from script to assets, camera set-ups, shots, dialogue, segment continuity and video prompts, hands-on canvas production, single segments, and realistic or fantasy action direction."
---
# 短剧与漫剧制作

负责把剧本真正做成视频：资产、机位、分镜、段落衔接、视频提示词，一直到画布上的成片片段。

## 先选方法

| 方法 | 什么时候用 | 读取 |
| --- | --- | --- |
| 漫剧制作 | 漫剧制作方法总纲：资产、机位、分镜、对白、段缝衔接（本板块原有方法，见 references/core.md） | `readSkill({name:"drama-director", path:"references/core.md"})` |
| workflow | 在当前画布上实际制作、续作和局部修改的执行流程（动手做时先读它） | `readSkill({name:"workflow"})` |
| 单段短剧 | 单段短剧情或独立场景 | `readSkill({name:"video-short-drama"})` |
| 写实动作导演 | 写实动作段：格斗、追逐、警匪、多人打斗 | `readSkill({name:"real-combat-director"})` |
| 玄幻动作导演 | 玄幻动作段：斗法、法术对轰、兵器近战、法阵 | `readSkill({name:"xuanhuan-combat-director"})` |

## 和画布配合

- 动手制作时先读 workflow，它说明怎样在画布上按剧本、资产、分镜、视频的顺序摆节点和连线。
- 剧本层的问题（分集大纲、改稿）转到「剧本创作」板块；角色和场景设定图转到「角色与场景设定」板块。
- 方法里对 MiniMax H3、Seedance 等模型写的时长和参数是原作者当时的规格。妙图当前的实际上限以视频节点给出的为准，例如 H3 现在 480p、768P、1080p 可选 4–30 秒，2K 最长 15 秒。

## 读取规则

- 下列每个方法都是原作者的方法原文，只改了名称；细节以原文为准，不要凭印象改写。
- 只读当前任务需要的那一个方法，不要一次把整个板块读完。正文较长时 readSkill 会截断，用返回的 nextOffset 接着读需要的章节。
- 方法里写到的平台、模型、时长、比例和价格是当时的示例。实际能用的模型和参数，以画布节点返回的为准（getCanvas、node:getConfig），费用每次用节点的 estimate 重新询价。
- 方法原文里的相对路径，用该方法自己的名称读取，例如 `readSkill({name:"方法名", path:"references/…"})`。
- 方法里要用到本机软件时，桌面端先取得授权并检查软件是否已安装；缺少时按统一工具说明，在用户任务授权范围内准备依赖。妙图不会因为读取方法就自动安装软件。生成结果保留在当前画布或用户指定的文件夹。网页端只用当前实际可用的工具。
