---
name: video-create
displayName: 视频创作
displayName_en: Video production
description: 视频创作板块：策划、导演、表演、补充画面、声音、字幕、动态图形、连续性和成片复查，以及口播、访谈、双人播客、演示解说、排名对比等视频形式。
description_en: The video production section: planning, direction, performance, b-roll, sound, captions, motion graphics, continuity and review, plus talking heads, interviews, podcasts, explainers and rankings.
---
# 视频创作

负责短剧以外的各类视频：先定形式，再按需要读取策划、导演、声音、字幕等环节的方法。完整总纲见 references/core.md。

## 先选方法

| 方法 | 什么时候用 | 读取 |
| --- | --- | --- |
| 视频创作总纲 | 不确定从哪里开始，或需要完整制作流程时 | `readSkill({name:"video-create", path:"references/core.md"})` |
| 创作策划 | 把需求、受众和参考整理成创作方案 | `readSkill({name:"video-plan"})` |
| 视频创作指导 | 动作、表演、运镜和剪辑指导 | `readSkill({name:"video-direction"})` |
| 人物与表演 | 人物声音、态度、对白和动作 | `readSkill({name:"video-performance"})` |
| 角色与素材连续性 | 多机位、人物、产品和场景的连续性 | `readSkill({name:"video-continuity"})` |
| 素材与补充画面 | 补充画面的选择和交接 | `readSkill({name:"video-broll"})` |
| 声音与混音 | 对白、原声、配乐和音效 | `readSkill({name:"video-sound"})` |
| 字幕设计 | 字幕分句、字体和强调 | `readSkill({name:"video-captions"})` |
| 画面与动态图形 | 图形层次、榜单和动态图形 | `readSkill({name:"video-graphics"})` |
| 成片复查 | 核对真实成片的画面、时长、字幕和声音 | `readSkill({name:"video-review"})` |
| 口播视频 | 口播：单人面向观众 | `readSkill({name:"video-talking-head"})` |
| 街访与访谈 | 街访与访谈 | `readSkill({name:"video-interview"})` |
| 双人对话与播客 | 双人对话与播客 | `readSkill({name:"video-podcast"})` |
| 演示与解说视频 | 产品演示、屏幕教程和解说 | `readSkill({name:"video-explainer"})` |
| 排名与对比视频 | 榜单、排名和对比 | `readSkill({name:"video-ranking"})` |

## 和画布配合

- 先确定视频形式（口播、访谈、解说……），只读这一种形式和真正需要的环节方法。
- 镜头画面用图片或视频生成节点，口播和对白的声音素材用音频节点；已有素材导入成媒体节点，用节点自带的截取、分离、提取音轨处理。
- 成片后按 video-review 用真实输出核对，不能只看提示词。

## 读取规则

- 下列每个方法都是原作者的方法原文，只改了名称；细节以原文为准，不要凭印象改写。
- 只读当前任务需要的那一个方法，不要一次把整个板块读完。正文较长时 readSkill 会截断，用返回的 nextOffset 接着读需要的章节。
- 方法里写到的平台、模型、时长、比例和价格是当时的示例。实际能用的模型和参数，以画布节点返回的为准（getCanvas、node:getConfig），费用每次用节点的 estimate 重新询价。
- 方法原文里的相对路径，用该方法自己的名称读取，例如 `readSkill({name:"方法名", path:"references/…"})`。
