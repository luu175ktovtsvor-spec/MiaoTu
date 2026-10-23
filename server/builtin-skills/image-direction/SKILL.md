---
name: image-direction
displayName: "图片与视觉指导"
displayName_en: "Image and visual direction"
description: "图片与视觉板块：角色、场景、产品和图形的图片指导，视觉方向卡，以及从妙图灵感库挑选可追溯的参考。"
description_en: "The image and visual section: image direction for characters, scenes, products and graphics, visual direction cards, and traceable references from the MiaoImg library."
---
# 图片与视觉指导

负责单张图片和整体视觉风格：先定方向，再写可执行的图片指导，并找到真实的参考图。

## 先选方法

| 方法 | 什么时候用 | 读取 |
| --- | --- | --- |
| 图片创作指导 | 角色、场景、产品和图形的完整图片指导（本板块原有方法，见 references/core.md） | `readSkill({name:"image-direction", path:"references/core.md"})` |
| 视觉方向卡 | 把模糊的意图整理成视觉方向卡 | `readSkill({name:"visual-direction"})` |
| 灵感库参考 | 从灵感库检索可追溯的提示词和参考图，并接入画布 | `readSkill({name:"inspiration-library"})` |

## 和画布配合

- 参考图接入画布后连到图片生成节点的输入，提示词里用 @ 引用，引用顺序就是参考顺序。
- 需要调光、换机位、改局部时，用图片节点自带的打光、多角度、局部重绘，不必重写整段提示词。

## 读取规则

- 下列每个方法都是原作者的方法原文，只改了名称；细节以原文为准，不要凭印象改写。
- 只读当前任务需要的那一个方法，不要一次把整个板块读完。正文较长时 readSkill 会截断，用返回的 nextOffset 接着读需要的章节。
- 方法里写到的平台、模型、时长、比例和价格是当时的示例。实际能用的模型和参数，以画布节点返回的为准（getCanvas、node:getConfig），费用每次用节点的 estimate 重新询价。
- 方法原文里的相对路径，用该方法自己的名称读取，例如 `readSkill({name:"方法名", path:"references/…"})`。
