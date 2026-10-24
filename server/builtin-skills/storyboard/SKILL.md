---
name: storyboard
displayName: "分镜设计"
displayName_en: "Storyboard"
description: "把定稿剧本拆成镜头：文字分镜、剧本转分镜脚本、90 秒分镜、带画面的故事分镜面板和视觉分镜九宫格。"
description_en: "Break a finished script into shots: written storyboards, script-to-shot scripts, 90-second plans, illustrated storyboard sheets and visual nine-panel grids."
---
# 分镜设计

负责把定稿剧本拆成镜头：每个镜头拍什么、多长、怎么拍，必要时先出画面预演。

## 什么时候用别的板块

| 任务 | 用哪个板块 |
| --- | --- |
| 正在按短剧漫剧全流程做剧集 | 短剧漫剧全流程（drama-director）里的 `sd-storyboard-engine`（文戏）和打戏引擎 |
| 口播、访谈、解说等短视频的镜头安排 | 视频复刻与创作（video-create） |

## 先选方法

| 方法 | 什么时候用 | 读取 |
| --- | --- | --- |
| 文字分镜 | 把已明确的故事写成可审阅的文字分镜 | `readSkill({name:"storyboard", path:"references/core.md"})` |
| 剧本分镜脚本 | 单段剧本转成资产编号统一、时间轴闭合的分镜脚本 | `readSkill({name:"miaotu-script-to-video"})` |
| 90秒剧本分镜 | 明确要求 90 秒的独立作品 | `readSkill({name:"miaotu-90s-script-to-video"})` |
| 故事分镜面板 | 15 秒内 3–8 个镜头的横向分镜表（带手绘分镜画面） | `readSkill({name:"miaotu-storyboard-panel"})` |
| 视觉分镜九宫格 | 根据参考图出 3×3 纯视觉分镜九宫格 | `readSkill({name:"miaotu-visual-storyboard-grid"})` |

## 和画布配合

- 文字分镜写进文本节点；要出画面时一个镜头一个图片生成节点，按镜头顺序排开，资产设定图连到对应镜头。
- 九宫格出图后用图片节点的「宫格切分」拆成单镜，再连到视频生成节点做首帧或参考。
- 镜头时长按目标模型实际支持的时长来切，先读视频节点的可选时长再定分镜。

## 读取规则

- 方法正文是完整的专业方法：照正文执行，不凭印象改写、压缩，也不换成别的流程。
- 只读当前任务需要的那一个方法和章节，不一次读完整个板块。正文被截断时，用返回的 nextOffset 接着读需要的部分。
- 正文里的平台、模型、时长、比例和价格是写作时的示例；实际能用的模型和参数以画布节点返回的为准（getCanvas、node:getConfig），费用每次用节点的 estimate 询价。
- 正文里的相对路径，用该方法的 ID 读取：`readSkill({name:"方法 ID", path:"references/…"})`。
- 正文要求用本机软件时，桌面端先确认本机操作已授权并检查软件是否已安装；没有安装时，只在用户的任务需要、且在授权范围内准备。网页端只用当前实际可用的工具；生成结果放在当前画布或用户指定的文件夹。
