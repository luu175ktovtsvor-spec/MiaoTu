---
name: drama-director
displayName: 漫剧制作
displayName_en: Drama production
description: 从剧本到角色场景资产、机位、分镜、对白、段落衔接与视频提示词的漫剧制作流程。分集长篇结构调用分集短剧编剧，动作段调用对应专项导演。
description_en: From script to character and scene assets, camera set-ups, storyboards, dialogue and video prompts. Multi-episode structure goes to the series writer; action beats to the matching action director.
---

> 执行说明：保留本文的方法和工具步骤。先核对当前工具与用户授权；桌面端可用本机工具时先检查软件是否已安装，缺少时按统一工具说明，在用户任务授权范围内准备所需依赖；妙图不会因为读取本文而自动安装软件。不要把 Skill 的示例路径、模型或能力当成已安装配置。网页端使用当前实际可用工具。

# 漫剧制作

## 按需制作

先读取共享执行说明 readSkill({name:"drama-director",path:"references/miaoimg-adapter.md"})；本轮已读则复用。完整创作总纲位于 references/production/source-guide.md，按任务读取流程、案例与规则索引。

按当前问题选阶段，不强制用户每次走完全部阶段：

| 当前任务 | 读取参考或复用入口 |
| --- | --- |
| 全流程立项与制作交接 | production/asset-first-pipeline.md、production/production-ledger-handbook.md |
| 单集剧本与因果节拍 | production/screenplay-gate-engine.md；连续分集用 readSkill({name:"short-drama-factory"}) |
| 角色、场景与站位锁定 | production/asset-spatial-ledger.md、production/character-lineage-and-sheets.md；资产制作复用下表 |
| 文戏、台词与表情 | production/dialogue-doctor-7d.md、production/dialogue-speed-check.md、production/wenxi-micro-expression.md、production/facs-micro-expression.md |
| 写实动作段 | readSkill({name:"real-combat-director"})，本段不重复加载通用动作引擎 |
| 玄幻动作段 | readSkill({name:"xuanhuan-combat-director"})，本段不重复加载旧玄幻动作引擎 |
| 分镜、机位与段缝 | production/cinematic-dramaturgy-rules.md、production/spatial-topview-camera.md、production/camera-transitions-6types.md、production/segment-splicing.md |
| 模型提示词封装 | production/model-adapters.md；用户选 H3 时读 production/h3-adapter.md；参数以当前节点配置为准 |
| 旁白、独白与情绪节拍 | production/vo-os-weaving.md、production/emotion-beat-curve.md |
| 交付前审查 | production/quality-gate-review.md、production/prompt-feeding-checklist.md |

上表中的 production/... 均按表内实际文件名读取，例如 readSkill({name:"drama-director",path:"references/production/asset-first-pipeline.md"})。需要总纲详细锁定与模式切换时读取 source-guide.md 对应章节；其开头包含版本记录，不以版本记录代替正文。

## 已有资产能力只复用一次

角色正交视图用 miaotu-character-orthographic；服装、表情、姿态、道具分别用 miaotu-character-costume、miaotu-character-expression、miaotu-character-pose、miaotu-character-prop。场景布局、正交场景、俯视图分别用 miaotu-ai-drama-scene-layout、miaotu-scene-turnaround、miaotu-scene-top-view-layout。九宫格和故事面板分别用 miaotu-visual-storyboard-grid、miaotu-storyboard-panel。先 listSkills 确认当前账号可用入口，再 readSkill 对应 ID；只调用本任务需要的项；巨物尺度场景用 miaotu-giant-scale-scene，先锁定尺度参照和空间关系，再进入图片或视频提示词制作。

这些入口负责独立资产，漫剧总入口负责资产与剧本、分镜的关系。已经锁定的原图以路径和节点关联，不重复出图或建立平行资产册。

总纲的章节及读取 offset 见 readSkill({name:"drama-director",path:"references/guide-index.md"})，需要总纲正文时按章节读取。
