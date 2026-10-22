---
name: video-continuity
displayName: 角色与素材连续性
displayName_en: Continuity
description: 组织多机位、人物、产品与场景的参考关系，保持跨镜头连续性。
description_en: Organise reference relationships across cameras, people, products and scenes to hold continuity between shots.
---
# 角色与素材连续性

Each new picture is a complete view. Give it the references that own the facts it needs. Keep useful dependencies shallow; reverse cameras see the same world differently, with coherent gaze, costume, props and physical relationships.

## 按需读取完整指导

- `readSkill({name:"video-create",path:"references/playbooks/craft/generated-dependencies.md"})`：完整制作前阅读。
- `readSkill({name:"video-create",path:"references/playbooks/craft/examples/conversation-images.md"})`：问题涉及此项时阅读。
- `readSkill({name:"video-create",path:"references/creation/transformations.md"})`：问题涉及此项时阅读。
- `readSkill({name:"video-create",path:"references/miaoimg-tools.md"})`：执行节点、媒体、费用或文件操作前阅读；本轮已读则复用。

这些是详细创作参考，不止简要提示词。readSkill 截断时用 nextOffset 继续当前所需章节；不要一次加载整个参考库。共享参考只保存一份，此技能可独立调用，也可由“视频创作”总入口组合调用。

## 从指导到实际作品

先理解当前目标与账号素材，把参考观察、创作决定和实际完成的结果分开。用现有节点和模型返回的 schema 实现作品；用户只要分析或方案时不触发生成。选择实际必要的其他技能，通过 listSkills / readSkill 读取，不强制跑完整流程。

