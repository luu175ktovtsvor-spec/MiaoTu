---
name: video-direction
displayName: 视频创作指导
displayName_en: Video direction
description: 编写动作、表演、运镜和剪辑指导，选择真实支持的图片、视频或音频参考。
description_en: Write action, performance, camera and edit direction, and choose image, video or audio references that really exist.
---
# 视频创作指导

Direct the reason for an action. Choose temporal evidence when motion, contact or coordination would be lost in prose and stills. Let attitude shape voice, expression, posture and rhythm rather than attaching a gesture to every phrase.

## 按需读取完整指导

- `readSkill({name:"video-create",path:"references/playbooks/craft/video-direction.md"})`：完整制作前阅读。
- `readSkill({name:"video-create",path:"references/miaoimg-tools.md"})`：执行节点、媒体、费用或文件操作前阅读；本轮已读则复用。

这些是详细创作参考，不止简要提示词。readSkill 截断时用 nextOffset 继续当前所需章节；不要一次加载整个参考库。共享参考只保存一份，此技能可独立调用，也可由“视频创作”总入口组合调用。

## 从指导到实际作品

先理解当前目标与账号素材，把参考观察、创作决定和实际完成的结果分开。用现有节点和模型返回的 schema 实现作品；用户只要分析或方案时不触发生成。选择实际必要的其他技能，通过 listSkills / readSkill 读取，不强制跑完整流程。

