---
name: visual-direction
displayName: 视觉方向卡
displayName_en: Visual direction card
description: 把模糊的创作意图整理成可执行的视觉方向卡，并从灵感库挑选风格、光线、色调和构图参考。
description_en: Turn a vague creative intent into an actionable visual direction card, and pick style, light, colour and composition references from the library.
---

# 妙图-视觉方向卡

这个技能处理“画面应该往哪种视觉语言走”：风格气质、光线方案、色调关系、构图重心、材质和参考图组合。它可以从灵感库挑选参考，也可以在检索结果基础上归纳方向卡；它不负责把档案原文当成提示词交付。

## 什么时候用

- 用户说“给我几种视觉方向”“定一个风格/色调/用光”“做 moodboard 或视觉方向卡”“找类似的画面气质”时，用本技能。
- 用户说“查档案原文”“找某条提示词”“保留原始 prompt、作者和来源”“把档案里的参考图放到画布”时，用 `inspiration-library`。
- 用户同时提出两类需求时，先用本技能确定方向，再单独调用 `inspiration-library` 获取需要逐字保留的档案证据；不要把方向卡的归纳句伪装成档案原文。

## 操作顺序

1. 先从用户话术提取主体、情绪、场景和限制，列出 2–4 个可比较的视觉方向。每个方向至少包含：风格关键词、主/辅色、光线与时间、构图重心、材质或镜头感觉。
2. 需要真实参考时调用 `searchInspirationLibrary`。把当前方向的画面意图作为 `query`，必要时用 `tag` 或 `tool` 缩小范围；一次先取 1–5 条，结果不足再递增 `offset`。
3. 从返回结果中说明“为什么选它”以及它支持方向卡的哪一项（色调、用光、构图或质感）。可以总结、比较和改写方向卡，但不要把总结写回 `prompt` 或声称它是档案原文。
4. 用户明确要把参考放到当前画布时，才使用 `saveReference:true`、`saveReference:N` 或 `saveReferences:[索引]`。多张返回值逐张读取 `savedReferences[].path` 与 `savedReferences[].mime`，然后按画布工具顺序执行：`getCanvas({include:["nodeTypes"]})` → `addNode` → `getNodeTools` → 对应图片节点的 `nodeTools.setImage`。
5. 完成后用 `getCanvasNodes` 核对每个图片节点实际挂载的工作区路径，并输出方向卡与参考来源的对应关系。

## 边界

- 视觉方向是创作建议，可以归纳、组合和改写；档案检索是可追溯证据，原文、作者、稳定 ID 和来源必须保持原样，两者不能混写。
- 只有工具返回 `datasetReady:true` 时，检索内容才可作为档案证据交付。版本不明或清单与档案库不一致时，遵循工具的口径说明，停止保存参考图或把内容称为档案原文；仍可继续讨论抽象的视觉方向。
- 不要为了填满方向卡而虚构作者、来源、图片路径或画布节点；没有命中就说明缺少可用参考，并保留当前方向判断。
