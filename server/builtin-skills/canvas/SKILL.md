---
name: canvas
displayName: 画布操作手册
displayName_en: Canvas guide
description: 妙图画布操作手册。使用画布工具创建、切换和重命名画布，添加、移动、重命名、连接和删除节点，自动整理整幅画布、调整视口，以及调用节点注册的函数。用户要求操作当前画布或搭建节点流程时使用。
description_en: Create or switch canvases; add, move, rename, connect and delete nodes; tidy the canvas, adjust the viewport and call node functions. Use when operating a canvas or building a node flow.
metadata:
  version: "2.2.0"
  displayName: 画布操作手册
  displayName_en: Canvas operations
  author: 妙图
---

# 画布操作手册

通过已启用的“画布操作”工具控制当前运行中的画布。工具仅在存在画布上下文时可用；缺少工具时，请用户打开目标项目的画布并确认工具已启用，不通过编辑画布 JSON 绕过工具。

内置 Agent 的主任务与每个子任务各有自己的画布绑定。子任务开始时从父任务的绑定分支；成功新建、切换或重命名画布后，只更新本任务的绑定，不会把兄弟任务或父任务重定向。页面当前显示哪张画布，不会改变其他正在运行任务的目标。宿主按项目串行执行实际画布操作并等待保存完成，任务不需要另行申请全局画布锁，也不应因另一个子任务可能切换显示画布而拒绝独立任务。并行任务仍应分工操作各自的画布或节点，不同时改同一份内容。

外部 MCP 客户端操作页面当前激活的画布，共享页面显示状态；多个外部客户端不应同时切换同一页面的画布。它与内置 Agent 的子任务绑定不同。

## 操作流程

1. 已知节点 ID 时直接读取目标；否则用 `getCanvas({})` 确认激活画布概览，用 `findCanvasNodes` 按名称、类型或选择状态查找。仅在需要添加节点时用 `getCanvas({ include: ["nodeTypes"] })` 查询类型。
2. 根据用户要求选择下面的操作，逐次等待返回。后续调用使用前一步返回的 ID，不猜测 ID、节点类型、端口或节点函数。
3. 用 `getCanvasNodes` 按需读取目标字段，`getCanvasEdges` 查询局部连接；需要调整节点内容时，用 `getNodeTools` 读取该节点函数的描述和完整 `parameters`，通过 `nodeTools` 调用。
4. 完成结构调整后，按需调用 `fitCanvas` 展示结果，再用 `getCanvasNodes` / `getCanvasEdges` 只核对受影响节点、名称与连接。`arrangeCanvas` 已自动适配视口，不必重复调用 `fitCanvas`。只报告工具实际完成的操作。

故事或视频制作先读取 [制作阶段与确认](references/videoProduction.md#0-逐阶段协作)。默认只落实当前已确认阶段；先逐步收集信息，再展示阶段成果并询问调整，等用户明确继续。不因用户说“做一个短片”就一次创建全部分镜与生成节点，也不把提问失败、跳过或沉默当作确认。

默认从本次完整剧本生成角色、场景、道具资产，再拆为多镜头片段；一片段对应一份视频提示词和一个视频节点，资产直接用于多参生成。写资产提示词前读取 [资产规范](references/workflow/references/assets.md)，写视频提示词前读取 [视频制作工作流](references/workflow/SKILL.md) 里的 Seedance 分段规则，角色面部特写与正侧背完整三视图不能省成通用单张剧情图。

文档内链接相对当前文件目录。跨技能先通过 `listSkills` 确认实际 ID，再使用 `readSkill({name:"目标技能ID",path:"技能内路径"})`；相对链接归一化后不能含 `..`。编剧按任务选择 `miaotu-film-screenwriting`、`video-script` 或 `short-drama-factory`，不调用不存在的 `script` 技能或 `available_skills` 工具。依赖缺失时说明缺项，仅继续不依赖它的工作，不凭简介补造规范。

以下写法表示“工具名（参数对象）”。直接调用对应工具，不额外包一层 `{ name, args }`；只有 `nodeTools` 自身含有 `name` 和 `args` 参数。

## 读取画布

五个读取工具都支持可选 `canvasId`，用于确认本轮绑定的画布，不能用它跳读任意画布。需要换目标时先用 `switchCanvas` 更新本任务的绑定；其他子任务的绑定保持不变。每次响应最多 64 KiB，不提供全图快照：

| 工具 | 参数与返回 |
| --- | --- |
| `getCanvas` | 默认返回 `id`、节点数、连线数、选中数量、`viewport`、工具栏开关 `view` 和撤销状态 `history`。`include: ["canvases"]` 查询 `{ id, name }` 画布列表，`include: ["nodeTypes"]` 查询 `availableNodeTypes` 的 `{ type, label }`，`include: ["folders"]` 查询画布文件夹；三类列表共用分页，`limit` 默认 30、最多 100。 |
| `findCanvasNodes` | 按 `query`（ID 或完整名称）、`types`（最多 20 类）、`selectedOnly`、`parentIds` 筛选；`parentIds: [null]` 查顶层，指定组 ID 查直接子节点，`includeDescendants: true` 查后代。省略筛选时分页列举。返回 `nodes` 摘要，名称预览最多 512 字符；`limit` 默认 30、最多 100。 |
| `getCanvasNodes` | `nodeIds` 每次 1–20 个、不允许重复；`fields` 默认 `label/type/position`，还可选 `geometry/ports/data/outputs`。`dataKeys` 限定需要的 data 自身属性，最多 20 个；返回 `nodes` 投影。 |
| `getCanvasEdges` | `nodeIds` 可选、最多 20 个；`direction` 取 `incoming/outgoing/both`，默认 `both`，省略 ID 才分页遍历全部边。返回 `edges`；`limit` 默认 100、最多 200。 |
| `getNodeTools` | `nodeIds` 每次 1–20 个、不允许重复，`names` 可筛选最多 20 个完整函数名。返回 `nodeTools`（含 `nodeId/name/description/parameters`）；`limit` 默认 20、最多 50。schema 不截断，单项过大则明确报错。 |

分页检查 `hasMore` / `nextCursor`，保留全部原查询参数，仅替换 `cursor`；节点筛选和连线查询每次最多扫描 2000 项，即使当前 `nodes` / `edges` 为空，`hasMore: true` 也表示尚未扫描完。`totalNodes` / `totalEdges` 是整张画布的总量，不是筛选命中数。游标不自行解析或构造，失效后重新查询。`selectedOnly` 按各页读取当时的选择状态筛选，用户编辑可能改变查询结果，不把分页当成冻结快照。

单节点内部也可能很大。`getCanvasNodes` 用 `path` 选择投影内的子路径，例如 `path: ["data", "promptModel"]` 或 `["outputs", "text", "value"]`，返回该路径的 `value`；首段只能是 label/type/position/geometry/ports/data/outputs 七种投影字段，`ports` 对应节点的 `data.handles`。数组和对象用 `valueOffset` / `valueLimit` 分页，默认 0 / 30、最多 100 项；字符串用 `textOffset` / `textLimit` 分段，默认 0 / 1000、最多 4000 字符。`valueOffset` 或 `textOffset` 大于 0 时必须提供 `path`，避免所有投影字段一起错位。路径只访问自身属性，不能读取继承属性。

`path` 最多 64 层，每段最多 256 字符（允许 JSON 对象的空键），整个路径的 JSON UTF-8 长度最多 2048 字节。达到路径深度或字节边界时返回 `pathDepthLimit` / `pathBytesLimit`，不得将该标记误认成已读完整内容；超长键用 `keyTooLong` 标记，并提供 `nextOffset` 以继续读取后续字段。

顶层 `hasMore/nextCursor` 表示还有节点未返回，保持原参数继续节点分页；每个节点的 `truncated` 表示该节点的值未读全。处理任一截断项时仅查询所属节点，使用该项路径及偏移，不携带原 `cursor`；具体规则：

- `text`：用该项 `path` 和 `nextOffset` 作为 `textOffset` 续读；`entries`：用该项 `path` 和 `nextOffset` 作为 `valueOffset` 续读。没有 `nextOffset` 表示该路径已到末尾，标记仍可能存在，因为本次只返回了后半段。
- `depth/budget`：以该项 `path` 发起新的详情查询，缩小读取范围；重新读取路径时不携带原查询的 `cursor`。
- `pathDepthLimit/pathBytesLimit/keyTooLong/circular` 表示无法完整展开。`keyTooLong` 可按返回的 `nextOffset` 跳过该键继续读取后续字段，但被跳过的值仍未取得；不反复重试硬限制或把它当完整内容。

节点内容先读取所需字段，发现截断后再沿路径补齐，不扩大为整图读取。已有文本文件路径交给文件读取工具；核对全文时必须包含已读片段和续读片段。

全局任务逐页处理并记录进度，只在上下文保留当前批次、累计摘要和游标；不要累计全部详情。对全图做增删操作可能使遍历游标失效，重新查询并根据已处理 ID 或结果核对，避免重复执行。节点新增、删除或画布切换后，用 `getNodeTools` 重新发现相关函数。

## 画布管理

| 工具 | 参数 | 行为与返回 |
| --- | --- | --- |
| `addCanvas` | `{ name? }` | 创建空白画布并切换到它；省略名称时自动使用未占用的“画布N”。返回新激活画布的概览。 |
| `switchCanvas` | `{ canvasId }` | 等待当前修改保存后切换到指定画布，返回新激活画布的概览。 |
| `renameCanvas` | `{ canvasId?, name }` | 省略 ID 时重命名激活画布，同时修改 JSON 文件名。返回操作后的激活画布概览。 |

名称去除首尾空白后为 1–120 个字符，不带 `.json` 扩展名，须为合法文件名；不能包含路径分隔符、文件名非法字符、控制字符，不能以点结尾或使用系统保留名。同名文件不会被覆盖。

画布 ID 与文件名关联，重命名后重新读取返回的 ID。重命名非激活画布不会切换过去。通过上述工具成功创建或切换画布后，本轮后续调用会作用于新的激活画布。

## 节点与连线

| 工具 | 参数 | 行为与返回 |
| --- | --- | --- |
| `addNode` | `{ type, position: { x, y }, label? }` | 新增节点，返回节点信息；函数用 `getNodeTools` 查询。未指定名称时使用类型的 `label`。 |
| `moveNodes` | `{ moves: [{ nodeId, position: { x, y } }] }` | 批量移动，返回 `nodes` 节点信息。不可拖动的节点会拒绝操作。 |
| `renameNodes` | `{ renames: [{ nodeId, label }] }` | 批量更新显示名称，返回 `nodes` 节点信息。不改变节点 ID。 |
| `deleteNodes` | `{ nodeIds: [...] }` | 删除节点及其连接边，返回 `nodeIds`、`removedEdgeCount`、最多 100 项 `removedEdgeIds` 和 `truncated`；截断仅影响回执。 |
| `connectNodes` | `{ connections: [{ source, sourceHandle, target, targetHandle }] }` | 批量连接输出与输入端口，返回 `{ edges }`。完全相同的连接已存在时返回已有边。 |
| `deleteEdges` | `{ edgeIds: [...] }` | 删除指定连线，返回 `edgeIds` 及关联节点信息 `nodes`。 |
| `selectNodes` | `{ nodeIds: [...] }` | 替换当前选择，返回 `selectedCount`、最多 100 项 `selectedNodeIds` 和 `truncated`；空数组取消节点选择。 |
| `arrangeCanvas` | `{}` | 整理整个当前画布：按真实节点尺寸与连线将顶层节点从左到右排列，子节点随父节点移动，并自动适配视口。返回 `arrangedCount`、最多 100 项 `arrangedNodeIds`、`truncated` 和 `viewport`；不改内容、连线或选择，不触发生成。 |
| `fitCanvas` | `{ nodeIds?: [...] }` | 调整视口，返回 `fitted`、`viewport`、`nodeCount` 和 `truncated`；传入 `nodeIds` 时另返回最多 100 项 `nodeIds`，省略时展示全部节点。 |
| `groupNodes` | `{ nodeIds, label? }` | 打组，返回 groupId，保留子节点内容、绝对位置与连线。 |
| `ungroupNodes` / `mergeGroups` | `{ nodeIds, label? }`（解组不传 label） | 解组提升子节点；合并保留首个组 ID。 |
| `reparentNodes` | `{ nodeIds, parentId }` | 移入分组，null 移出到顶层；拒绝循环，保持绝对位置。 |
| `resizeGroups` | `{ sizes: [{ nodeId, width, height, position? }] }` | 调整分组框，保持子节点绝对位置，不缩放原件。 |
| `duplicateNodes` | `{ nodeIds, withEdges? }` | 创建副本，包含分组子树；返回新旧 ID 对照及是否截断，不重新生成媒体。 |
| `arrangeNodes` | `{ nodeIds, mode: "horizontal" / "vertical" / "grid" }` | 与界面选区排列共用逻辑，只影响目标范围。 |
| `undoCanvas` / `redoCanvas` | `{}` | 撤销/重做结构操作，getCanvas.history 返回可用状态。不能撤销生成、正文或外部文件。 |
| `copyNodes` / `pasteNodes` | `{ nodeIds, writeSystemClipboard? }` / `{ position, command? }` | 项目内跨画布复制粘贴，保留分组及内部连线；使用复制回执 command，默认不改系统剪贴板。 |
| `setCanvasView` | `{ viewport?, snapToGrid?, showEdges?, showMap?, showAssets?, handMode? }` | 平移缩放和工具栏开关；getCanvas.view 返回当前状态。 |
| `importCanvasAssets` | `{ paths, position }` | 将项目内现有图片、视频、音频、文本放入画布；普通媒体建立节点内部副本，已有内部原片共享，不下载整片再上传。文本正文独立保存，相对文件链接保留来源文件目标。按返回节点及实际输出路径继续。 |
| `createCanvasFolder` / `moveCanvas` | `{ folder }` / `{ canvasId?, folder }` | 创建文件夹或移动画布，空 folder 移到根目录。getCanvas include:folders 读取画布目录；素材文件夹使用 createAssetFolder({folder})。 |
| `deleteCanvas` | `{ canvasId }` | 仅在明确授权时删除该画布，保留共用素材，至少保留一张画布，不可撤销。 |
| `duplicateCanvas` | `{ canvasId?, target }` | 整张画布独立复制到新的 .json 相对路径；正文与节点状态独立，已有媒体共用原片，正文相对文件链接保留原目标，保留分组、连线和布局，不改变激活画布或系统剪贴板。 |
| `switchPanel` / `openDocument` / `getDocument` / `writeDocument` | 依据工具 schema | 内置 Agent 与外部接入共用文档入口；canWriteText=false 的预览不支持文本写入。写入原样携带同次读取的 documentId 与 expectedText，防止写错文档或覆盖新编辑；保存回执对应实际写入目标。 |
| `closeDocument` | `{ path? }` 或 `{ canvasPath?, nodeId? }`，省略使用当前文档 | 保存后关闭该文档全部视图，返回 closedViews/remainingViews；失败保留草稿，不删除文件或节点。 |
| `moveDocument` | `{ path?, target }` | 移动或重命名文档及目录，省略 path 使用当前文件文档；更新已打开的文档/画布路径，保留 Markdown 链接目标，不覆盖目标。单张画布仍用 moveCanvas/renameCanvas，内部原件另存副本后整理。 |

文档文件 path 和节点 canvasPath+nodeId 只能选一种，不能混用。正在打开的普通文档整理使用 moveDocument，不必先关闭再靠原始文件接口移动；仅关闭时用 closeDocument。switchPanel 保留后台文档并尝试保存，保存失败仍保留草稿；离开工作区必须通过完整保存检查。

上述操作回执的 `truncated` 只表示 ID 列表缩略，不表示操作只完成了预览部分。不要为了取全回执重复执行操作；按需用读取工具核对受影响范围。

### 参数约束

- `position` 始终使用画布绝对坐标，分组内节点也一样，不是屏幕像素坐标；`getCanvasNodes` 的 `geometry` 包含 parentId、relativePosition、width、height；`x`、`y` 必须是有限数字。开启网格吸附时，新增和移动的位置会按网格取整，以返回的 `node.position` 为准。
- 节点 `label` 去除首尾空白后为 1–200 个字符。
- `addNode` 只接受当前 `availableNodeTypes` 中的类型，不接受任意 `data` 或自定义节点 ID。需要填写内容或设置节点参数时使用已注册的节点函数。
- 上述移动、重命名、删除、连接操作每批 1–64 项，单项也使用数组参数。任一项校验失败则整批不执行；执行期间的异常不代表已产生的副作用自动回滚，恢复前仍需回读。
- 工具顶层参数采用严格对象校验，不传未声明字段。`nodeTools.args` 还要满足具体节点函数的参数定义。
- 节点 ID、画布 ID、边 ID 是不同的标识，不用显示名称代替它们。

### 连接规则

先通过 `getCanvasNodes({ nodeIds: [...], fields: ["ports"] })` 读取两端端口，每个端口含 `id`、`type`、`dataType`，可能还有 `label`。`source`、`target` 是节点 ID；`sourceHandle`、`targetHandle` 是各自节点内的端口 ID。

- 只能从 `type: "source"` 的输出端口连接到 `type: "target"` 的输入端口。
- 使用实际端口 ID，不根据“图片输入”等提示文字猜测。不同节点可有同名端口，必须同时确认所属节点。
- 工具沿用画布和目标节点的连接校验；类型匹配不保证一定可连，目标节点可能有额外规则。连接被拒绝时检查最新端口和函数说明，不修改 JSON 强行接线。
- 剧本和分镜文本用于规划，不直接作为图片或视频生成节点的输入。先确认角色、场景等资产，再把当前片段的全部镜头转写成一份专用视频提示词；连线只承载本次真正使用的素材。
- 接好媒体后核对目标的实际引用顺序，再用 `node:setPrompt` 写入 `{{ref N}}`、素材名称和用途。连线成功不等于提示词已绑定素材，详细编号与配置核对见 [制作转换第 3–4 节](references/videoProduction.md)。
- 节点或连线禁止连接、选择、移动、删除时遵守返回错误。删除有子节点的节点须先删除子节点或将其纳入同一删除批次；若涉及用户未要求删除的内容，先明确范围，不自动扩大删除操作。

## 调用节点函数

使用 `nodeTools({ nodeId, name, args })`：

- `nodeId` 与 `name` 必须来自同一项函数清单；`name` 保留完整 `node:` 前缀。
- 按该项 `parameters` 的 JSON Schema 构造 `args`，遵守必填字段、枚举与数据结构；无参数函数也传 `{}`。
- 不假定所有节点都有同一组函数，例如设置提示词、导入素材、生成媒体等能力必须以该节点实际注册内容为准。
- 需要核对或修改生成配置时，若清单提供 `node:getConfig`，通过它读取当前配置和可用模型能力；需要变更的选项使用 `node:setConfig` 按实际参数说明修改，再核对返回结果。配置修改不触发生成；用户已确认的有效设置继续沿用，不因普通编辑任务重新选模型。
- 积分由当前生效价格决定。每次说明费用或核对预算，都重新调用对应节点的 `node:getConfig`，以当前参数返回的 `estimate.points` 为准；不沿用历史对话、技能示例或模型目录单价。参数、参考素材或数量变化后重新询价；报价为空就说明暂时无法确认，视频预估与最终结算可能不同。
- 图片或视频生成前展示实际模型、对象与数量、规格、提示词、参考及费用，等待用户明确批准算力消耗方案；报价未知就说明未知。单张、小样、追加、重生成和可能收费的重试都受授权范围约束，具体批次可一次确认。使用可用的 `askUser`，没有该工具时文字提问等待答复；未回答不能触发生成。图片未指定模型时优先选择可用的 gpt-image，不能把节点自动默认值当成用户选择；不可用时先确认替代模型。
- 返回值由节点函数决定；无返回值时为 `null`。五个画布读取工具的 64 KiB 上限不适用于 `nodeTools` 业务函数执行结果。执行成功不自动代表媒体生成成功，须检查返回内容及最新节点状态。
- 新建节点后可立即用返回的节点 ID 查询 `getNodeTools` 并调用，不必结束当前轮对话。

## 常见任务

### 把创作方案转成可执行画布

剧本、小说或创意制作任务需要把分镜、素材和提示词落实为节点时，读取 [视频制作的画布转换](references/videoProduction.md)。其中说明哪些内容放进文本节点、如何复用媒体和连接真实依赖，以及后台生成的完成核对。通用参数仍以本手册和当前工具返回的说明为准。

### 新建画布并添加节点

调用 `addCanvas({ "name": "分镜草稿" })`，再用 `getCanvas({ "include": ["nodeTypes"] })` 查询 `availableNodeTypes`，选取符合用户要求的类型传入 `addNode` 的 `type`。例如位置可用 `{ "x": 120, "y": 160 }`；名称由用户意图决定。记录返回的 `node.id`，用 `getNodeTools` 查询并调用函数填写节点内容，最后调用 `fitCanvas({})`。

### 连接两个已有节点

调用 `findCanvasNodes`，按用户指定的名称或选择状态定位两个节点；已知 ID 时跳过查找，若同名节点无法区分则先明确目标。用 `getCanvasNodes` 读取输出与输入端口后，将实际 ID 填入 `connectNodes` 的 `connections` 数组。检查返回 `edges` 的两端，再按需聚焦这两个节点。

### 查找并读取指定片段

例如用户指定 G51，先调用 `findCanvasNodes({ "query": "G51", "limit": 20 })`，按分页结果确认目标。以下 `目标ID` 须替换成返回的实际 ID：

- 核对提示词与输出：`getCanvasNodes({ "nodeIds": ["目标ID"], "fields": ["label", "data", "outputs"], "dataKeys": ["prompt", "referenceOrder"] })`。默认字段不含 `ports/data/outputs`，不能把未请求的字段当作空值。
- 读取长提示词：`getCanvasNodes({ "nodeIds": ["目标ID"], "path": ["data", "prompt"], "textLimit": 4000 })`；后续使用返回的 `nextOffset`，不自行按请求长度推算。
- 查询目标入边：`getCanvasEdges({ "nodeIds": ["目标ID"], "direction": "incoming", "limit": 100 })`；查询可调用函数：`getNodeTools({ "nodeIds": ["目标ID"], "limit": 20 })`。

### 批量整理节点

仅当用户明确要求整理整幅当前画布时，在确认目标后调用一次 `arrangeCanvas({})`，不自行计算所有节点坐标再逐个移动。此工具复用画布现有整理功能，不接受 `nodeIds` 或其他局部范围参数。

待整理节点尚未测量或不可移动时，工具明确返回错误；不要猜测尺寸或绕过移动限制。空画布正常返回空的 `arrangedNodeIds`，不执行布局或视口调整。

只整理指定镜头或局部节点时，优先用 `arrangeNodes` 的水平、垂直、宫格模式；需要精确坐标时读取实际位置与目标范围，用 `moveNodes` 的 `moves` 数组调整这些节点，按需用 `fitCanvas({ "nodeIds": [...] })` 展示。只要求看清内容时直接用 `fitCanvas`，不重排节点。不得为了局部整理调用 `arrangeCanvas` 移动用户其他节点，也不删除或重建节点来代替移动。

## 失败后的处理

- 节点类型未启用、端口不存在、函数未注册：分别用 `getCanvas({ include: ["nodeTypes"] })`、`getCanvasNodes`、`getNodeTools` 查询最新状态并调整操作，不要猜测替代函数。
- 画布已关闭、用户切换项目或本轮上下文失效：停止沿用旧 ID，请用户在目标画布重新发送请求。仅切换页面显示的画布不会改变正在运行的内置 Agent 任务绑定。
- 超时、取消或保存失败不等于操作已回滚。上下文仍有效时先读取最新画布状态，确认是否已创建节点、连线或画布，再决定是否重试，避免重复创建或重复触发生成。 改名、移动、删除回执异常时，用 getCanvas(include: ["canvases"]) 核对实际列表与当前 canvasId，再使用真实路径；不要直接按旧地址重复整理。
- 工具会等待需要保存的操作完成保存；不要另外直接写画布 JSON 或任意覆盖节点数据。节点编辑使用实际注册函数，视口调整使用 setCanvasView；deleteCanvas 仅用于用户明确要求删除的画布。
- 外部 MCP 连接 ready=false 时先等状态同步或旧操作结束。同步中或画布命令未完成时，原始文件操作不能修改已有文件。没有未确认操作的断线，已知打开路径最多继续保护 30 秒，同页新状态可提前更新；这不是长期离线锁。已有操作下发却未确认结束时，不因重连或满 30 秒解锁，须等同一页面明确报告执行结束，期间不下发新画布/文档命令，也不能删除项目。不切换工具绕过保护。


## 节点内部操作

`assets/` 是节点内部文件目录。已有正文、模型及媒体保持原路径，修改正文或模型使用实际节点工具；整理素材先另存副本到普通素材目录，再移动或改名副本。不要直接改名、删除内部原件，也不要通过媒体处理覆盖它们。历史画布、Markdown 正文及附件链接仍引用的普通目录文件同样保持原位；关闭画布或删除节点后仍有撤销记录，都不代表原件可以移动。另存副本继续允许整理。

供应商配置只在设置中管理。文档、节点、扩展文件能力不能读取、另存或改写它，也不能通过整理父目录绕过；遇到此类拒绝不要换一个文档入口重试。

保存冲突后界面“刷新画布”保留的本页副本同样使用独立节点和正文，媒体共享原片；读取副本后按实际新 nodeId 操作，不复用原图的编号。

普通 Markdown 文件移动、复制到不同目录时，文件接口保留图片和附件链接的目标；整目录移动或复制时，目录内的互相引用跟随对应文件。不要再手工重复改写链接。文本节点通过 saveOutputAsAsset 另存为 .md/.markdown 时也保留相对链接目标；界面默认使用 .md，内部正文保持原位。旧服务缺少该能力时，客户端会拒绝这类文档整理并提示更新。文档打开失败时先处理读取错误并重试，不要把失败状态当作空白正文写入。

setImage/setVideo/setAudio 选择普通项目媒体时保留内部副本，已有内部原片直接共享，返回实际输出引用；不要假定该路径等于传入 path。通常自动读取文件类型，只需 path，未声明类型时可补 mimeType，仍以实际函数 schema 为准。

以 `getNodeTools` 实际返回为准，使用 `nodeTools` 调用，不能只根据下列名称猜参数。只读查询也要分页或按返回的正文路径续读。

- 文本：getConfig/setConfig 选择模型与提示词，getText 分页读正文、setText 写正文；修改已有正文时先读完整内容，再传 expectedText 核对，内容已变化时重新读取，不强行覆盖。setTextEditor 打开/关闭正文编辑窗口并设置全屏。generateText 开始文本生成，getGenerationStatus/cancelGeneration 查询和停止；getReferences/setReferenceOrder 重排真实输入。
- 图片/视频生成：getConfig/setConfig 覆盖界面当前全部输出参数；setPrompt 改提示词；generateImage/generateVideo 开始生成，getGenerationStatus/cancelGeneration 查询和停止。getOutputHistory 分页查历史，setImage/setVideo 恢复项目内已有结果，不发生成。
- 生成状态 `pending` 表示已停止等待，但取消未确认或原任务已经完成；这不是已取消或生成失败。保留原节点和 requestId，调用该节点的 generateImage/generateVideo 继续取回，不另建节点重新下单。`saving` 的保存问题同样只恢复原任务；取消以回执为准，不能根据观察连接断开推断成功或退款。
- 图片：splitImageGrid 宫格切分；editImageMarks 标记、文字、矩形、笔刷和蒙版及编辑历史。mark 的 save 新建图片节点；inpaint 只准备选区。进入局部重绘后重新 getNodeTools 获取 getInpaintConfig/setInpaintConfig，切换模型后再画选区。generateInpaint/cancelInpaint/getGenerationStatus 常驻图片节点；状态为 pending 时调用 generateInpaint 只继续取回原任务，无需重新打开面板、选模型或画选区。关闭面板或画布不会取消已提交任务，重新打开画布后自动取回；cancelled=true 才表示已确认取消。未结束任务需取回或确认取消后再替换图片、删除节点，复制节点不接管原任务。
- 图片打光、多角度、全景：getImageTools 查询真实能力；prepareImageVariation 复用界面设置和提示词构建，只创建并连接生成节点，不自动生图。openPanorama 打开已有全景的预览，随后 getNodeTools 发现 getPanoramaView/setPanoramaView；capturePanorama 按当前校正真实截图、合图或分图成组，不发模型请求。
- 视频：processVideo 截取、提取音轨、分离音视频，保留原片并生成新节点；截取返回关键帧对齐后的实际范围。captureVideoFrame 截取首帧、尾帧或当前帧；当前帧固定调用瞬间的播放位置，播放器已释放时沿用保留的进度，按该位置对应的真实画面取图，不向后跳到下一帧。当前帧与尾帧返回实际画面时间，不把较长的音轨、平均帧率或标称时长当作画面时间。controlPlayback 控制预览。
- 音频：processAudio 变速或按片段顺序截取拼接，生成新节点；controlPlayback 控制预览。
- 各类节点：focusNode 与双击聚焦共用逻辑，给 Agent 面板、导航和编辑工具栏让出空间。图片节点/图片生成节点使用 setImagePreview 打开或关闭已有图片大图预览。saveOutputAsAsset 另存为项目素材，默认不覆盖已有文件。操作系统文件导入/导出继续使用已授权的 importLocalFile/exportWorkspaceFile。
- 3D 导演台：readDirector 先读 summary/schema，editDirector 批量修改场景、人物、关节动作、方案与镜头。只改 scene 时不要求先创建动画；修改 plan 时必须提供完整有效方案。addDirectorMannequin 添加真实内置关节人偶，setDirectorOptions 设置灯光、网格和天空，editDirectorAnchors 增删/修改/排序参考关键帧，selectDirectorPlan 切换已保存方案，exportDirectorImage 将关键帧真实渲染为 PNG 节点。setDirectorEditor 打开预览后重新 getNodeTools，可用 controlDirectorView 播放、定位、设置镜头/焦距、捕捉或恢复当前关键帧。setDirectorAspect、getDirectorModels/setDirectorModel、setDirectorPrompt、runDirector、inspectScene、exportDirectorVideo 使用节点现有机制。

图片/视频模型请求须遵守用户授权；“准备节点”“配置模型”“已有素材处理”不等于真实生成。当前未打开某个编辑面板时，其专属函数可能尚未挂载，先使用常驻入口，再重新 getNodeTools 查询，不随机尝试函数名。系统权限仍适用，不能把工具清单当成无限制访问电脑的授权。

新建节点、查询函数与调用函数都会等待节点组件完成挂载；加载失败会明确报错，不能把挂载过程中的空清单当成功能不支持。readDirector 读取现有数据还会等待场景文件加载，失败不返回临时空场景；可调用 setDirectorEditor(open: true) 重试读取，不要因此新建模型替代原文件。schema 查询无需等待文件读取。导演台预览由实际 canvas 挂载触发初始化，窗口被遮挡时不等待打开动画结束。实际播放和实时视频渲染仍遵守窗口可见性要求。

inspectScene 在无动画方案时接受 timestamps: [0]，返回真实静态渲染画面，不必为了回看而创建无关动画。
