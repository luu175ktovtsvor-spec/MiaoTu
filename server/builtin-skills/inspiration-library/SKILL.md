---
name: inspiration-library
displayName: 灵感库参考
displayName_en: Library references
description: 从妙图灵感库检索可追溯的提示词与图片/视频参考，并把选中的参考图接入当前画布。
description_en: Search the MiaoImg library for traceable prompts and image or video references, and bring a chosen reference into the current canvas.
---

# 灵感库接入

灵感库是只读参考资料。它不会调用生图模型，也不会替用户决定要不要生成。

## 操作顺序

1. 先调用 `searchInspirationLibrary`，把用户原话放进 `query`；需要限定受控标签时再传 `tag`，知道工具或模型时传 `tool`。`limit` 保持在 1–5；结果不足时用同一筛选条件递增 `offset` 分页，不要猜测分页游标。
2. 只有工具返回 `datasetReady:true` 时，结果中的 `prompt` 才能作为档案原文交付；`datasetReady:false` 或版本口径报错时，停止把结果称为档案原文，也不要保存参考图，并把工具给出的口径说明原样告诉用户。
3. 结果里的 `prompt` 是档案原文，`sourceUrl`、作者、稳定 ID、图片/视频地址一起保留；不要把翻译或改写冒充原文。
4. 用户明确要把首张图放到画布时，在检索调用里传 `saveReference:true`。它仍只保存第一条图片，返回 `savedReference.path` 与 `savedReference.mime`。需要一次落多张时，可传 `saveReference:3` 保存扁平图片候选的前 3 张，或传 `saveReferences:[0,2,4]` 选择索引；单次最多 6 张，超过上限会报错并且不应改成静默截断。返回的 `savedReferences` 为每张图提供独立的 `path`、`mime`、`itemId` 和 `imageId`，之后分别走现有画布工具：
   - `getCanvas({include:["nodeTypes"]})` 读取真实节点类型；
   - `addNode` 创建已有的图片节点；
   - `getNodeTools` 读取该节点工具；
   - 对每个图片节点调用 `nodeTools` 的 `setImage({path:savedReferences[i].path,mimeType:savedReferences[i].mime})`。
5. 完成后用 `getCanvasNodes` 核对节点输出。不要直接编辑画布 JSON，也不要另造文件或节点写入协议。

## 约束

- 一次最多返回 12 条；先缩小关键词，再请求下一页，不要把整库塞进上下文。
- 没有匹配时如实报告，不用网页搜索替代档案来源。
- 中文自然语言没有命中时，不要静默改写成英文或放宽条件；如需尝试用户认可的近义词，把新 query 作为一次独立检索并说明它不是原话精确命中。
- 参考图落盘只写入当前用户的 `assets/` 工作区；保存动作只下载已有媒体，不产生模型调用或积分消耗。
- 数据集版本、清单和实际档案库必须一致；版本不明或不一致时检索结果不能作为档案原文交付，工具会以用户可见的口径说明结束本次档案操作。
- 图片可作为图片节点参考；视频使用现有视频节点能力，先确认其 `setVideo` 工具。
