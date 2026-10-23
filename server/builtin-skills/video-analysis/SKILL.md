---
name: video-analysis
displayName: "拉片与复刻"
displayName_en: "Breakdown and remake"
description: "拉片与复刻板块：按时间分析真实视频的镜头、动作、图文和节奏，逐镜拉片报告，以及保留参考结构制作新版本。"
description_en: "The breakdown and remake section: analyse a real video over time, write shot-by-shot breakdowns, and remake a new version that keeps the reference structure."
---
# 拉片与复刻

负责看懂一条参考视频，并在需要时照它的结构做一版新的。

## 先选方法

| 方法 | 什么时候用 | 读取 |
| --- | --- | --- |
| 视频拉片 | 按时间理解参考视频的镜头、动作、图文系统和节奏（本板块原有方法，见 references/core.md） | `readSkill({name:"video-analysis", path:"references/core.md"})` |
| 逐镜拉片拆解 | 逐镜拉片报告：剪切点、时间码、景别、机位、运镜、光影和声音 | `readSkill({name:"miaotu-video-shot-analysis"})` |
| 视频复刻 | 保留参考结构，换人物、产品、语言或风格做新版本 | `readSkill({name:"video-remake"})` |

## 和画布配合

- 参考视频放进视频节点；需要看画面时用节点的「截取当前帧 / 首帧 / 尾帧」，需要听内容时用「提取音轨」。
- 拉片报告写进文本节点放在参考视频旁边；复刻时把报告和参考视频一起连到后面的生成节点。
- 抽几帧不等于看完了整条视频，报告里写清楚实际看过的时间段。

## 读取规则

- 下列每个方法都是原作者的方法原文，只改了名称；细节以原文为准，不要凭印象改写。
- 只读当前任务需要的那一个方法，不要一次把整个板块读完。正文较长时 readSkill 会截断，用返回的 nextOffset 接着读需要的章节。
- 方法里写到的平台、模型、时长、比例和价格是当时的示例。实际能用的模型和参数，以画布节点返回的为准（getCanvas、node:getConfig），费用每次用节点的 estimate 重新询价。
- 方法原文里的相对路径，用该方法自己的名称读取，例如 `readSkill({name:"方法名", path:"references/…"})`。
- 方法里要用到本机软件时，桌面端先取得授权并检查软件是否已安装；缺少时按统一工具说明，在用户任务授权范围内准备依赖。妙图不会因为读取方法就自动安装软件。生成结果保留在当前画布或用户指定的文件夹。网页端只用当前实际可用的工具。
