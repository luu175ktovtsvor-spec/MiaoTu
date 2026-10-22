---
name: xuanhuan-combat-director
displayName: 玄幻动作导演
displayName_en: Xuanhuan action director
description: 设计仙侠斗法、法术对轰、兵器近战、法阵与终结动作的分镜提示词，控制攻守轮换、特效尺度和空间连续性。用于玄幻动作段，不处理写实格斗或整剧分集规划。
description_en: Design shot prompts for immortal-cultivation duels, spell barrages, weapon melee, formations and finishing moves, controlling attack-defence rotation, VFX scale and spatial continuity.
---

> 执行说明：保留本文的方法和工具步骤。先核对当前工具与用户授权；桌面端可用本机工具时先检查软件是否已安装，缺少时按统一工具说明，在用户任务授权范围内准备所需依赖；妙图不会因为读取本文而自动安装软件。不要把 Skill 的示例路径、模型或能力当成已安装配置。网页端使用当前实际可用工具。

# 玄幻动作导演

先读取共享执行说明 readSkill({name:"drama-director",path:"references/miaoimg-adapter.md"})。详细正文位于 readSkill({name:"drama-director",path:"references/fantasy-action/source-guide.md"})，包括动作颗粒度、攻守轮换、空间收束与标准输出格式。

按本段需要读取同目录参考：
- 核心动作协议：01-core-combat-laws-and-protocols.md。
- 运镜与近战：02-camera-specs-and-15modes.md、03-close-quarters-combat-engine.md。
- 术法、特效与法阵：04-xuanhuan-elements-and-vfx.md、05-grand-scale-domains-and-formations.md。
- 兵器、招式与场景：06-martial-and-magic-arsenal.md、07-arsenal-parameter-library.md、08-character-and-scene-presets.md。

读取格式例如 readSkill({name:"drama-director",path:"references/fantasy-action/01-core-combat-laws-and-protocols.md"})。30 秒、8K、16:9 和模型名称沿用户选定模型的真实配置拆段。需要持续攻防就保留动态收束；需要爆炸终结再选空间闭环协议，不把两种收尾叠成矛盾要求。完整制作关系交给 drama-director，同一动作段只使用本专项规则。

总纲的章节及读取 offset 见 readSkill({name:"drama-director",path:"references/guide-index.md"})，需要总纲正文时按章节读取。
