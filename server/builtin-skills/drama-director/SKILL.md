---
name: drama-director
displayName: "短剧漫剧全流程"
displayName_en: "Short drama and comic drama pipeline"
description: "AIGC 短剧、漫剧剧集的完整导演流程：立项与前置选项、赛道分流（国内剧、海外剧、解说叙事）、剧本、资产、分镜、文戏与打戏、视频提示词封装和出稿质检。从创意、小说或剧本一路做成剧集时使用。"
description_en: "The full director pipeline for AIGC short dramas and comic dramas: set-up choices, track routing, script, assets, storyboards, drama and action scenes, video prompt packaging and QC."
---
# 短剧漫剧全流程

把一个创意、一部小说或一份剧本做成可以直接生成视频的短剧或漫剧剧集。真人写实、3D 国漫、二次元都走这一条流程，画风在开工前的选项里定。

本板块是一整套导演系统：一个总控技能负责立项、分流和调度，十二个子技能各管一个环节。

## 什么时候用别的板块

| 任务 | 用哪个板块 |
| --- | --- |
| 只写剧本或分集大纲，不往下做资产和视频 | 剧本创作（script-writing） |
| 单独做一张角色、场景或道具设定图 | 角色与场景设定（asset-design） |
| 口播、访谈、播客、解说、榜单，或照着一条参考视频复刻 | 视频复刻与创作（video-create） |
| 看懂一条参考视频、出拉片报告 | 视频拉片（video-analysis） |

## 开始顺序

1. 先读妙图执行说明：`readSkill({name:"drama-director", path:"references/miaoimg-adapter.md"})`，本轮读过就复用。
2. 再读总控：`readSkill({name:"short-drama-director"})`。正文很长，先读开头的「使用入口」和「前置锁」部分，其余按需用 nextOffset 接着读。
3. 总控按任务把工作交给下面的子技能。读子技能时用它的 ID：`readSkill({name:"sd-script-engine"})`。

## 子技能

| ID | 负责 |
| --- | --- |
| `sd-decision-engine` | 这场戏该用什么镜头：情境映射、情绪锚点、构图禁区 |
| `sd-recon-engine` | 对标爆款和热点的采风，交付对标情报卡 |
| `sd-script-engine` | 剧本创作与小说改编：六阶段编剧链、圆桌审核、台词诊断 |
| `sd-overseas-engine` | 海外剧剧本：语言与风格、北美英语对白 |
| `sd-jieshuo-engine` | 解说叙事剧本：历史人物、事件战役、科普，旁白稿 |
| `sd-asset-engine` | 资产锁定：角色、场景、道具清单，场景连续性，人群调度 |
| `sd-storyboard-engine` | 文戏和日常戏的分镜、故事板、段内衔接 |
| `sd-combat-engine` | 通用打戏分镜与群战 |
| `sd-xuanhuan-engine` | 玄幻仙侠打戏：斗法、法术、兵器、法阵 |
| `sd-real-engine` | 真人写实打戏：格斗、追逐、多人打斗 |
| `sd-feed-engine` | 把分镜封装成可直接投喂视频模型的提示词，含多段衔接 |
| `sd-qc-engine` | 出稿质检、连续性台账、剪辑转场、声音与配乐 |

同一个动作段只用一个打戏引擎：写实用 `sd-real-engine`，玄幻仙侠用 `sd-xuanhuan-engine`，其余用 `sd-combat-engine`。

## 正文里的路径怎么读

- 写成 `references/…` 或 `scripts/…` 的路径，属于正在读的那个技能：`readSkill({name:"当前技能 ID", path:"references/…"})`。
- 写成 `技能ID/…` 的路径，例如 `sd-combat-engine/references/combat-cheatsheet.md`、`short-drama-director/references/model-adapters.md`，拆成 `readSkill({name:"sd-combat-engine", path:"references/combat-cheatsheet.md"})`。
- 正文提到的 `CHANGELOG.md` 是版本记录，不影响制作，不用读取。

## 读取规则

- 正文是完整的专业方法：照正文执行，不凭印象改写、压缩，也不换成别的流程。
- 只读当前任务需要的技能和章节，不一次读完整套。正文被截断时，用返回的 nextOffset 接着读需要的部分。
- 正文里的平台、模型、时长、比例和价格是写作时的示例；实际能用的模型和参数以画布节点返回的为准（getCanvas、node:getConfig），费用每次用节点的 estimate 询价。
- 正文要求运行本机脚本或软件时，按妙图执行说明里的「本机脚本」一节处理。网页端只用当前实际可用的工具。
