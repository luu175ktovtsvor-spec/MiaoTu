---
name: asset-design
displayName: "角色与场景设定"
displayName_en: "Character and scene design"
description: "把角色、场景、道具做成稳定可复用的设定图：角色设定图、三视图、表情、动作、服装、道具，场景四视图、俯视布局、短剧场景板、VR 全景、巨物场景，以及从剧本提炼资产清单和视觉 DNA。"
description_en: "Reusable design sheets for characters, scenes and props: turnarounds, expressions, poses, costumes, props, scene views, top views, scene boards, VR panoramas, giant scenes and script asset DNA."
---
# 角色与场景设定

负责把角色、场景、道具做成稳定可复用的设定图，保证后面每个镜头里人物和场景都是同一个。

## 什么时候用别的板块

| 任务 | 用哪个板块 |
| --- | --- |
| 正在按短剧漫剧全流程做剧集，需要锁定整部剧的资产清单 | 短剧漫剧全流程（drama-director）里的 `sd-asset-engine`；它需要单张设定图时再回到本板块的方法 |
| 整体视觉风格、单张图片的画面指导 | 图片与视觉指导（image-direction） |

## 先选方法

| 方法 | 什么时候用 | 读取 |
| --- | --- | --- |
| 剧本资产美术指导 | 从剧本提炼角色、场景、道具清单和视觉 DNA（通常第一步） | `readSkill({name:"miaotu-script-asset-dna"})` |
| 角色设定图 | 角色设定图与正侧背三视图 | `readSkill({name:"miaotu-character-turnaround"})` |
| 角色正交视图 | 建模用的标准正交视图（四视图、六视图） | `readSkill({name:"miaotu-character-orthographic"})` |
| 角色表情设定 | 十二表情库 | `readSkill({name:"miaotu-character-expression"})` |
| 角色动作设定 | 十五种标准动作姿态 | `readSkill({name:"miaotu-character-pose"})` |
| 角色服装设定 | 服装结构、面料、纹样拆解 | `readSkill({name:"miaotu-character-costume"})` |
| 角色道具设定 | 武器、饰品、装备等道具拆解 | `readSkill({name:"miaotu-character-prop"})` |
| 场景四视图 | 场景正交四视图 | `readSkill({name:"miaotu-scene-turnaround"})` |
| 场景俯视布局 | 场景俯视图、走位和机位规划 | `readSkill({name:"miaotu-scene-top-view-layout"})` |
| 短剧场景布局 | 短剧场景资产板（四个机位视角加空间布局） | `readSkill({name:"miaotu-ai-drama-scene-layout"})` |
| 全景场景设计 | 720° 全景环境 | `readSkill({name:"miaotu-vr-panorama"})` |
| 巨物场景导演 | 巨型生物、巨神、遗迹等巨物场景的尺度与构图 | `readSkill({name:"miaotu-giant-scale-scene"})` |

## 和画布配合

- 一张设定图一个图片生成节点，角色原图或参考图连到节点输入；同一个角色的设定图放在一起并打组，组名用角色名。
- DNA 文本写进文本节点，后面生成画面时用 @ 引用，不要每次重新描述。
- 全景图可以直接用图片节点的「全景」预览和截图；三视图、四视图需要拆开时用「宫格切分」。
- 生成前用节点 estimate 报价；用户只要方案时只写文字，不触发生成。

## 读取规则

- 方法正文是完整的专业方法：照正文执行，不凭印象改写、压缩，也不换成别的流程。
- 只读当前任务需要的那一个方法和章节，不一次读完整个板块。正文被截断时，用返回的 nextOffset 接着读需要的部分。
- 正文里的平台、模型、时长、比例和价格是写作时的示例；实际能用的模型和参数以画布节点返回的为准（getCanvas、node:getConfig），费用每次用节点的 estimate 询价。
- 正文里的相对路径，用该方法的 ID 读取：`readSkill({name:"方法 ID", path:"references/…"})`。
- 正文要求用本机软件时，桌面端先确认本机操作已授权并检查软件是否已安装；没有安装时，只在用户的任务需要、且在授权范围内准备。网页端只用当前实际可用的工具；生成结果放在当前画布或用户指定的文件夹。
