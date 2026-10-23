---
name: video-script
displayName: 剧本与分镜
displayName_en: Script and storyboard
description: 编写独立视频、广告、口播和解说的脚本、对白、分镜及语义时间。连续分集短剧规划由分集短剧编剧负责。
description_en: Write scripts, dialogue, storyboards and semantic timing for standalone videos, ads, talking heads and explainers. Episodic short-drama planning goes to the series writer.
---
# 妙图-剧本与分镜

## 职责与交接

连续分集短剧的大纲、人物和伏笔台账读取 short-drama-factory；完整漫剧制作读取 drama-director。本入口继续负责独立视频的正式脚本和语义时间，不重复建立整剧规划。

Keep one adopted Script. Choose performable passages and useful spans/events; camera shot count is not the script structure. Let accepted delivery establish actual time while preserving the meaning of each reveal, response and cut.

## 按需读取完整指导

- `readSkill({name:"video-create",path:"references/creation/script-and-time.md"})`：完整制作前阅读。
- `readSkill({name:"video-create",path:"references/creation/brief.md"})`：问题涉及此项时阅读。
- `readSkill({name:"video-create",path:"references/miaoimg-tools.md"})`：执行节点、媒体、费用或文件操作前阅读；本轮已读则复用。

这些是详细创作参考，不止简要提示词。readSkill 截断时用 nextOffset 继续当前所需章节；不要一次加载整个参考库。共享参考只保存一份，此技能可独立调用，也可由“视频创作”总入口组合调用。

## 从指导到实际作品

先理解当前目标与账号素材，把参考观察、创作决定和实际完成的结果分开。用现有节点和模型返回的 schema 实现作品；用户只要分析或方案时不触发生成。选择实际必要的其他技能，通过 listSkills / readSkill 读取，不强制跑完整流程。

