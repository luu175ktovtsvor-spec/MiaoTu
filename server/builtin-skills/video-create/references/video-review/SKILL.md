---
name: video-review
displayName: 成片复查
displayName_en: Review
description: 核对真实输出的画面、时长、尺寸、连续性、字幕与声音证据，定位需要修正的环节。
description_en: Check real output picture, duration, dimensions, continuity, captions and sound evidence, and locate what still needs fixing.
---
# 妙图-成片复查

Review the actual work and its handoffs. A successful request, a plan or a healthy application does not prove the viewing experience. Fix the responsible passage or composition and retain paid accepted media.

## 按需读取完整指导

- `readSkill({name:"video-create",path:"references/production/review.md"})`：完整制作前阅读。
- `readSkill({name:"video-create",path:"references/production/snapshots.md"})`：问题涉及此项时阅读。
- `readSkill({name:"video-create",path:"references/production/rendering.md"})`：问题涉及此项时阅读。
- `readSkill({name:"video-create",path:"references/miaoimg-tools.md"})`：执行节点、媒体、费用或文件操作前阅读；本轮已读则复用。

这些是详细创作参考，不止简要提示词。readSkill 截断时用 nextOffset 继续当前所需章节；不要一次加载整个参考库。共享参考只保存一份，此技能可独立调用，也可由“视频创作”总入口组合调用。

## 从指导到实际作品

先理解当前目标与账号素材，把参考观察、创作决定和实际完成的结果分开。用现有节点和模型返回的 schema 实现作品；用户只要分析或方案时不触发生成。选择实际必要的其他技能，通过 listSkills / readSkill 读取，不强制跑完整流程。

