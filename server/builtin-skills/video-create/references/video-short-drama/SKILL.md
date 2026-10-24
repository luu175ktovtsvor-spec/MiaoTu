---
name: video-short-drama
displayName: 单段剧情短片
displayName_en: Single-scene drama
description: 组织一段剧情或一个独立场景的人物关系、行为、机位、对白与连续性。连续多集的短剧和漫剧用短剧漫剧全流程。
description_en: Organise characters, behaviour, camera positions, dialogue and continuity for one drama scene or standalone segment. Episodic dramas use the short drama pipeline.
---
# 妙图-单段剧情短片

## 职责与交接

本方法处理一段剧情或一个独立场景。只写连续多集的剧本读 short-drama-factory；从剧本到资产、分镜和视频的完整剧集流程读 drama-director。不把单个场景扩展成长篇流程。

Give every passage a dramatic job. Wants, reactions, actions and surroundings make one event lead to the next. Establish the useful camera views, then let every camera see the same world differently.

## 按需读取完整指导

- `readSkill({name:"video-create",path:"references/playbooks/formats/short-drama.md"})`：完整制作前阅读。
- `readSkill({name:"video-create",path:"references/miaoimg-tools.md"})`：执行节点、媒体、费用或文件操作前阅读；本轮已读则复用。

这些是详细创作参考，不止简要提示词。readSkill 截断时用 nextOffset 继续当前所需章节；不要一次加载整个参考库。共享参考只保存一份，此技能可独立调用，也可由「视频复刻与创作」板块组合调用。

## 从指导到实际作品

先理解当前目标与账号素材，把参考观察、创作决定和实际完成的结果分开。用现有节点和模型返回的 schema 实现作品；用户只要分析或方案时不触发生成。选择实际必要的其他技能，通过 listSkills / readSkill 读取，不强制跑完整流程。

