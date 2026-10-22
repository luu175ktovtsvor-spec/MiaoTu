---
name: video-performance
displayName: 人物与表演
displayName_en: Performance
description: 设计角色的声音、态度、对白和动作关系，适用于口播、对话、短剧及旁白。
description_en: Design a character's voice, attitude, dialogue and action relationships for talking heads, conversations, short drama and narration.
---
# 人物与表演

Cast the person through appearance and sound, then let one recognizable identity express different thoughts. A-roll owns the performed passage even when another picture covers it. Voice design/clone remains a plan unless actual available tools support it.

## 按需读取完整指导

- `readSkill({name:"video-create",path:"references/playbooks/craft/voice-direction.md"})`：完整制作前阅读。
- `readSkill({name:"video-create",path:"references/playbooks/craft/voice-and-performance.md"})`：问题涉及此项时阅读。
- `readSkill({name:"video-create",path:"references/playbooks/craft/video-direction.md"})`：问题涉及此项时阅读。
- `readSkill({name:"video-create",path:"references/miaoimg-tools.md"})`：执行节点、媒体、费用或文件操作前阅读；本轮已读则复用。

这些是详细创作参考，不止简要提示词。readSkill 截断时用 nextOffset 继续当前所需章节；不要一次加载整个参考库。共享参考只保存一份，此技能可独立调用，也可由“视频创作”总入口组合调用。

## 从指导到实际作品

先理解当前目标与账号素材，把参考观察、创作决定和实际完成的结果分开。用现有节点和模型返回的 schema 实现作品；用户只要分析或方案时不触发生成。选择实际必要的其他技能，通过 listSkills / readSkill 读取，不强制跑完整流程。

