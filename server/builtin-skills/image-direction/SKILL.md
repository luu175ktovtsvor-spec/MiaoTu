---
name: image-direction
displayName: "图片与视觉指导"
displayName_en: "Image and visual direction"
description: "定单张图片和整体视觉风格：角色、场景、产品和图形的图片指导与提示词优化，视觉方向卡，以及从妙图灵感库挑选可追溯的参考图。"
description_en: "Single-image and overall visual direction: image direction and prompts for characters, scenes, products and graphics, visual direction cards, and library references."
---
# 图片与视觉指导

负责单张图片和整体视觉风格：先定方向，再写可执行的图片指导，并找到真实的参考图。

## 什么时候用别的板块

| 任务 | 用哪个板块 |
| --- | --- |
| 角色三视图、表情、服装、道具、场景四视图等设定图 | 角色与场景设定（asset-design） |
| 视频里的镜头画面、动态图形 | 视频复刻与创作（video-create） |

## 先选方法

| 方法 | 什么时候用 | 读取 |
| --- | --- | --- |
| 图片创作指导 | 角色、场景、产品和图形的完整图片指导 | `readSkill({name:"image-direction", path:"references/core.md"})` |
| 视觉方向卡 | 把模糊的意图整理成视觉方向卡 | `readSkill({name:"visual-direction"})` |
| 灵感库参考 | 从灵感库检索可追溯的提示词和参考图，并接入画布 | `readSkill({name:"inspiration-library"})` |

## 和画布配合

- 参考图接入画布后连到图片生成节点的输入，提示词里用 @ 引用，引用顺序就是参考顺序。
- 需要调光、换机位、改局部时，用图片节点自带的打光、多角度、局部重绘，不必重写整段提示词。

## 读取规则

- 方法正文是完整的专业方法：照正文执行，不凭印象改写、压缩，也不换成别的流程。
- 只读当前任务需要的那一个方法和章节，不一次读完整个板块。正文被截断时，用返回的 nextOffset 接着读需要的部分。
- 正文里的平台、模型、时长、比例和价格是写作时的示例；实际能用的模型和参数以画布节点返回的为准（getCanvas、node:getConfig），费用每次用节点的 estimate 询价。
- 正文里的相对路径，用该方法的 ID 读取：`readSkill({name:"方法 ID", path:"references/…"})`。
- 正文要求用本机软件时，桌面端先确认本机操作已授权并检查软件是否已安装；没有安装时，只在用户的任务需要、且在授权范围内准备。网页端只用当前实际可用的工具；生成结果放在当前画布或用户指定的文件夹。
