---
name: video-analysis
displayName: "视频拉片"
displayName_en: "Video breakdown"
description: "看懂一条真实视频：按时间分析镜头、动作、图文和节奏，或出逐镜拉片报告（剪切点、时间码、景别、机位、运镜、光影、声音）。只做分析；要照着做新版本，用视频复刻与创作。"
description_en: "Understand a real video: analyse shots, action, text and pacing over time, or write a shot-by-shot breakdown. Analysis only; to make a new version, use video remake and production."
---
# 视频拉片

把一条参考视频看懂、拆清楚，写成可以拿去用的拉片报告。

## 什么时候用别的板块

| 任务 | 用哪个板块 |
| --- | --- |
| 照着参考视频的结构做一版新的 | 视频复刻与创作（video-create）里的 `video-remake` |
| 对标爆款短剧、出对标情报卡，再接着做剧集 | 短剧漫剧全流程（drama-director）里的 `sd-recon-engine` |

## 先选方法

| 方法 | 什么时候用 | 读取 |
| --- | --- | --- |
| 参考视频理解 | 按时间理解参考视频的镜头、动作、图文系统和节奏，为后续创作找出它为什么好看 | `readSkill({name:"video-analysis", path:"references/core.md"})` |
| 逐镜拉片拆解 | 要一份逐镜头的拉片报告：剪切点、时间码、景别、机位、运镜、光影和声音 | `readSkill({name:"miaotu-video-shot-analysis"})` |

## 和画布配合

- 参考视频放进视频节点；要看画面时用节点的「截取当前帧 / 首帧 / 尾帧」，要听内容时用「提取音轨」。
- 拉片报告写进文本节点，放在参考视频旁边。
- 抽几帧不等于看完了整条视频，报告里写清楚实际看过的时间段。

## 读取规则

- 方法正文是完整的专业方法：照正文执行，不凭印象改写、压缩，也不换成别的流程。
- 只读当前任务需要的那一个方法和章节。正文被截断时，用返回的 nextOffset 接着读需要的部分。
- 正文里的相对路径，用该方法的 ID 读取：`readSkill({name:"方法 ID", path:"references/…"})`。
- 正文要求用本机软件时，桌面端先确认本机操作已授权并检查软件是否已安装；没有安装时，只在用户的任务需要、且在授权范围内准备。网页端只用当前实际可用的工具。
