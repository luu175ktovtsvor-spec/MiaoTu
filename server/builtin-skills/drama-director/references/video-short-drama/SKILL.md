---
name: video-short-drama
displayName: 单段短剧
displayName_en: Single-segment drama
description: 组织单段短剧情或独立场景的人物关系、行为、机位、对白与连续性。连续漫剧制作和多集编剧使用专项入口。
description_en: Organise characters, behaviour, camera positions, dialogue and continuity for one short drama segment or standalone scene. Full comic-drama production uses its own entry.
---
# 妙图-单段短剧

## 职责与交接

本入口处理单段短剧情。连续多集规划读取 short-drama-factory；从剧本到资产、分镜和视频的完整漫剧流程读取 drama-director。不把独立场景写作扩展成另一套长篇流程。

Give every passage a dramatic job. Wants, reactions, actions and surroundings make one event lead to the next. Establish the useful camera views, then let every camera see the same world differently.

## 按需读取完整指导

- `readSkill({name:"video-create",path:"references/playbooks/formats/short-drama.md"})`：完整制作前阅读。
- `readSkill({name:"video-create",path:"references/miaoimg-tools.md"})`：执行节点、媒体、费用或文件操作前阅读；本轮已读则复用。

这些是详细创作参考，不止简要提示词。readSkill 截断时用 nextOffset 继续当前所需章节；不要一次加载整个参考库。共享参考只保存一份，此技能可独立调用，也可由“视频创作”总入口组合调用。

## 从指导到实际作品

先理解当前目标与账号素材，把参考观察、创作决定和实际完成的结果分开。用现有节点和模型返回的 schema 实现作品；用户只要分析或方案时不触发生成。选择实际必要的其他技能，通过 listSkills / readSkill 读取，不强制跑完整流程。

