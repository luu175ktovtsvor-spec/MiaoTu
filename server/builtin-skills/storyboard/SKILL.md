---
name: storyboard
displayName: "分镜设计"
displayName_en: "Storyboard"
description: "分镜板块：文字分镜、剧本转分镜脚本、90 秒分镜、故事分镜面板和视觉分镜九宫格。"
description_en: "The storyboard section: written storyboards, script-to-shot scripts, 90-second plans, storyboard sheets and visual nine-panel grids."
---
# 分镜设计

负责把定稿剧本拆成镜头：每个镜头拍什么、多长、怎么拍，必要时先出画面预演。

## 先选方法

| 方法 | 什么时候用 | 读取 |
| --- | --- | --- |
| 文字分镜 | 把已明确的故事写成可审阅的文字分镜（本板块原有方法，见 references/core.md） | `readSkill({name:"storyboard", path:"references/core.md"})` |
| 剧本分镜脚本 | 单段剧本转成资产编号统一、时间轴闭合的分镜脚本 | `readSkill({name:"miaotu-script-to-video"})` |
| 90秒剧本分镜 | 明确要求 90 秒的独立作品 | `readSkill({name:"miaotu-90s-script-to-video"})` |
| 故事分镜面板 | 15 秒内 3–8 个镜头的横向分镜表（带手绘分镜画面） | `readSkill({name:"miaotu-storyboard-panel"})` |
| 视觉分镜九宫格 | 根据参考图出 3×3 纯视觉分镜九宫格 | `readSkill({name:"miaotu-visual-storyboard-grid"})` |

## 和画布配合

- 文字分镜写进文本节点；要出画面时一个镜头一个图片生成节点，按镜头顺序排开，资产设定图连到对应镜头。
- 九宫格出图后用图片节点的「宫格切分」拆成单镜，再连到视频生成节点做首帧或参考。
- 镜头时长按目标模型实际支持的时长来切，先读视频节点的可选时长再定分镜。

## 读取规则

- 下列每个方法都是原作者的方法原文，只改了名称；细节以原文为准，不要凭印象改写。
- 只读当前任务需要的那一个方法，不要一次把整个板块读完。正文较长时 readSkill 会截断，用返回的 nextOffset 接着读需要的章节。
- 方法里写到的平台、模型、时长、比例和价格是当时的示例。实际能用的模型和参数，以画布节点返回的为准（getCanvas、node:getConfig），费用每次用节点的 estimate 重新询价。
- 方法原文里的相对路径，用该方法自己的名称读取，例如 `readSkill({name:"方法名", path:"references/…"})`。
