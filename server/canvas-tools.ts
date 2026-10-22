// Single canvas contract for the UI, embedded Agent, delegated tasks and MCP.
import { z } from 'zod';

const nodeId = z.string().min(1).max(256);
const position = z.strictObject({ x: z.number().finite(), y: z.number().finite() });
// canvasId 和 cursor 都是「只能从工具返回里学到的确认值」，不是让模型自己填的参数。
// 不加 min(1)：模型想留空却必须凑够一个字符时，它会塞一个空格（实测过），而那串东西谁也认不出来。
const canvasId = z.string().max(4096).optional();
const cursor = z.string().max(4096).optional();
const nodeIds = z.array(nodeId).min(1).max(20);

export const canvasSchemas = {
  getCanvas: z.strictObject({
    canvasId,
    include: z.array(z.enum(["canvases", "nodeTypes", "folders"])).max(3).optional(),
    cursor,
    limit: z.number().int().min(1).max(100).default(30),
  }),
  findCanvasNodes: z.strictObject({
    canvasId,
    query: z.string().max(200).optional(),
    types: z.array(nodeId).max(20).optional(),
    selectedOnly: z.boolean().optional(),
    parentIds: z.array(nodeId.nullable()).min(1).max(20).optional(),
    includeDescendants: z.boolean().default(false),
    cursor,
    limit: z.number().int().min(1).max(100).default(30),
  }),
  getCanvasNodes: z.strictObject({
    canvasId,
    nodeIds: nodeIds.refine(value => new Set(value).size === value.length, "nodeIds 不能重复，请先去重"),
    fields: z.array(z.enum(["label", "type", "position", "geometry", "ports", "data", "outputs"])).max(7).default(["label", "type", "position"]),
    dataKeys: z.array(nodeId).min(1).max(20).optional(),
    path: z.array(z.string().max(256)).min(1).max(64)
      .refine(value => ["label", "type", "position", "geometry", "ports", "data", "outputs"].includes(value[0]), "path 必须从节点投影字段开始")
      .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 2048, "path 的 JSON UTF-8 长度不能超过 2048 字节").optional(),
    valueOffset: z.number().int().min(0).default(0),
    valueLimit: z.number().int().min(1).max(100).default(30),
    textOffset: z.number().int().min(0).default(0),
    textLimit: z.number().int().min(1).max(4000).default(1000),
    cursor,
  }).refine(value => Boolean(value.path) || (value.textOffset === 0 && value.valueOffset === 0), "textOffset 或 valueOffset 大于 0 时必须提供 path"),
  getCanvasEdges: z.strictObject({
    canvasId,
    nodeIds: nodeIds.optional(),
    direction: z.enum(["incoming", "outgoing", "both"]).default("both"),
    cursor,
    limit: z.number().int().min(1).max(200).default(100),
  }),
  getNodeTools: z.strictObject({
    canvasId,
    nodeIds: nodeIds.refine(value => new Set(value).size === value.length, "nodeIds 不能重复，请先去重"),
    names: z.array(nodeId).min(1).max(20).optional(),
    cursor,
    limit: z.number().int().min(1).max(50).default(20),
  }),
  addCanvas: z.strictObject({ name: z.string().trim().min(1).max(120).optional() }),
  switchCanvas: z.strictObject({ canvasId: z.string().min(1).max(4096) }),
  renameCanvas: z.strictObject({ canvasId: z.string().min(1).max(4096).optional(), name: z.string().trim().min(1).max(120) }),
  addNode: z.strictObject({ type: z.string().min(1), position, label: z.string().trim().min(1).max(200).optional() }),
  deleteNodes: z.strictObject({ nodeIds: z.array(nodeId).min(1).max(64) }),
  moveNodes: z.strictObject({ moves: z.array(z.strictObject({ nodeId, position })).min(1).max(64) }),
  renameNodes: z.strictObject({ renames: z.array(z.strictObject({ nodeId, label: z.string().trim().min(1).max(200) })).min(1).max(64) }),
  connectNodes: z.strictObject({
    connections: z.array(z.strictObject({ source: nodeId, sourceHandle: z.string().min(1), target: nodeId, targetHandle: z.string().min(1) })).min(1).max(64),
  }),
  deleteEdges: z.strictObject({ edgeIds: z.array(z.string().min(1).max(256)).min(1).max(64) }),
  selectNodes: z.strictObject({ nodeIds: z.array(nodeId) }),
  arrangeCanvas: z.strictObject({}),
  fitCanvas: z.strictObject({ nodeIds: z.array(nodeId).optional() }),

  duplicateNodes: z.strictObject({ nodeIds: z.array(nodeId).min(1).max(64), withEdges: z.boolean().default(true) }),
  groupNodes: z.strictObject({ nodeIds: z.array(nodeId).min(1).max(64), label: z.string().trim().min(1).max(200).optional() }),
  ungroupNodes: z.strictObject({ nodeIds: z.array(nodeId).min(1).max(64) }),
  mergeGroups: z.strictObject({ nodeIds: z.array(nodeId).min(2).max(64), label: z.string().trim().min(1).max(200).optional() }),
  reparentNodes: z.strictObject({ nodeIds: z.array(nodeId).min(1).max(64), parentId: nodeId.nullable() }),
  resizeGroups: z.strictObject({ sizes: z.array(z.strictObject({ nodeId, width: z.number().finite().min(120).max(10000), height: z.number().finite().min(80).max(10000), position: position.optional() })).min(1).max(64) }),
  arrangeNodes: z.strictObject({ nodeIds: z.array(nodeId).min(2).max(64), mode: z.enum(['horizontal', 'vertical', 'grid']) }),
  undoCanvas: z.strictObject({}),
  redoCanvas: z.strictObject({}),
  setCanvasView: z.strictObject({ viewport: z.strictObject({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().finite().min(0.2).max(8) }).optional(), snapToGrid: z.boolean().optional(), showEdges: z.boolean().optional(), showMap: z.boolean().optional(), showAssets: z.boolean().optional(), handMode: z.boolean().optional() }),
  copyNodes: z.strictObject({ nodeIds: z.array(nodeId).min(1).max(64), writeSystemClipboard: z.boolean().default(false) }),
  pasteNodes: z.strictObject({ position, command: z.string().regex(/^miaoimg:paste-node:[a-f0-9-]+$/i).optional() }),
  importCanvasAssets: z.strictObject({ paths: z.array(z.string().min(1).max(4096)).min(1).max(20), position }),
  createAssetFolder: z.strictObject({ folder: z.string().trim().min(1).max(4096) }),
  createCanvasFolder: z.strictObject({ folder: z.string().trim().min(1).max(200) }),
  moveCanvas: z.strictObject({ canvasId: z.string().min(1).max(4096).optional(), folder: z.string().trim().max(200) }),
  deleteCanvas: z.strictObject({ canvasId: z.string().min(1).max(4096) }),
  duplicateCanvas: z.strictObject({ canvasId: z.string().min(1).max(4096).optional(), target: z.string().min(1).max(500) }),
  switchPanel: z.strictObject({ panel: z.enum(['canvas', 'document']) }),
  getDocument: z.strictObject({}),
  openDocument: z.strictObject({ path: z.string().min(1).max(4096).optional(), canvasPath: z.string().min(1).max(4096).optional(), nodeId: nodeId.optional(), handleId: nodeId.optional() }),
  writeDocument: z.strictObject({
    documentId: z.string().min(1).max(64).describe('原样使用刚读取的 documentId；切换文档、文本输出或重新打开后须重新读取。'),
    text: z.string(), expectedText: z.string(),
  }),
  closeDocument: z.strictObject({ path: z.string().min(1).max(500).optional(), canvasPath: z.string().min(1).max(500).optional(), nodeId: nodeId.optional() }),
  moveDocument: z.strictObject({ path: z.string().min(1).max(500).optional(), target: z.string().min(1).max(500) }),
  nodeTools: z.strictObject({ nodeId, name: z.templateLiteral(["node:", z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/)]), args: z.record(z.string(), z.json()) }),
};

export const canvasOperations = [
  { name: 'duplicateCanvas', label: '复制画布', description: '将 canvasId 指定画布（省略使用当前画布）独立复制到 target 工作区相对 .json 路径；不覆盖现有文件。正文、模型与节点状态独立，保留分组、连线、布局，已有媒体引用不可变原片；正文内相对文件链接保留原目标。不会提交生成，也不改变当前激活画布或系统剪贴板。', parameters: canvasSchemas.duplicateCanvas },
  { name: "getCanvas", label: "画布概览", description: "读取激活画布的 ID、节点数、连线数、选中数量和视口，不返回全部节点、连线或函数。include 按需选择 canvases（画布列表）或 nodeTypes（availableNodeTypes），二者共用 cursor/limit 分页。已知节点 ID 时可直接读取节点。所有读取工具每次最多 64 KiB，返回 hasMore/nextCursor；继续分页须保留原参数，仅替换 cursor。cursor 失效时重新查询。canvasId 可选，用于校验目标仍是当前激活画布。view 返回工具栏开关，history 返回撤销重做状态。include 可选 folders 读取画布文件夹。不要直接修改画布 JSON。", parameters: canvasSchemas.getCanvas },
  { name: "findCanvasNodes", label: "查找画布节点", description: "按 query（节点 ID 或完整名称）、types、selectedOnly 和 parentIds 筛选节点；parentIds=[null] 查顶层，指定分组 ID 查直接子节点，includeDescendants=true 查全部后代。省略筛选时分页列举；返回 nodes 简要信息，其中名称预览最多 512 字符，不返回正文和函数定义。limit 默认 30、最多 100，每次最多扫描 2000 个节点。totalNodes 是画布节点总数而非命中数；selectedOnly 按各页读取时的选择状态筛选，并非冻结快照。即使 nodes 为空，hasMore 为 true 仍须使用 nextCursor 继续扫描。处理全部节点时逐批完成并保留摘要和游标，避免将各页详情不断堆进上下文。", parameters: canvasSchemas.findCanvasNodes },
  { name: "getCanvasNodes", label: "读取节点详情", description: "按已知且不重复的 nodeIds 读取最多 20 个节点，fields 默认 label/type/position（画布绝对坐标）；geometry 返回 parentId、relativePosition、width、height 和可移动/可删除状态；按需指定 ports、data、outputs。dataKeys 仅选择 data 的自身属性。path 可读取投影字段下的嵌套值，如 ['data','promptModel']，仅访问自身属性，ports 对应 data.handles。path 返回 value，数组/对象按 valueOffset/valueLimit 分页（默认 30、最多 100），字符串按 textOffset/textLimit 分段（默认 1000、最多 4000 字符）。textOffset 或 valueOffset 大于 0 时必须提供 path。检查每节点 truncated 的路径、total、nextOffset，沿该路径继续读取，不能把截断当完整。已有文本文件路径应交给文件读取工具。响应受 64 KiB 限制，hasMore 时保留参数用 nextCursor 继续。", parameters: canvasSchemas.getCanvasNodes },
  { name: "getCanvasEdges", label: "读取画布连线", description: "分页读取 nodeIds 相关的局部连线；direction 为 incoming/outgoing/both，默认 both。省略 nodeIds 时分页遍历全图连线，limit 默认 100、最多 200，每次最多扫描 2000 条边。totalEdges 是画布连线总数而非命中数。返回 edges 与分页信息，空 edges 但 hasMore 为 true 时继续 nextCursor。查询上游时逐层限制范围，不一次展开整张图。", parameters: canvasSchemas.getCanvasEdges },
  { name: "getNodeTools", label: "查询节点函数", description: "按最多 20 个不重复的 nodeIds 查询实际注册的函数；names 可筛选完整 node:函数名，limit 默认 20、最多 50。返回 nodeTools，每项含 nodeId/name/description/parameters；函数 schema 保持完整，单项过大时明确报错。根据查询到的 schema 构造参数再调用 nodeTools，不猜测函数名或参数。hasMore 时用 nextCursor 继续。", parameters: canvasSchemas.getNodeTools },
  { name: "addCanvas", label: "新增画布", description: "在当前工作区创建空白画布 JSON 并切换到新画布。name 可选且不含 .json 扩展名；省略时自动使用未占用的画布N，同名文件不会被覆盖。返回新画布状态，本轮后续调用可继续新增节点。", parameters: canvasSchemas.addCanvas },
  { name: "switchCanvas", label: "切换画布", description: "先从 getCanvas({include:['canvases']}) 分页获取 canvasId，再切换激活画布。等待当前修改保存，返回新画布概览，本轮后续操作继续作用于新画布。", parameters: canvasSchemas.switchCanvas },
  { name: "renameCanvas", label: "重命名画布", description: "重命名当前工作区画布，同时修改对应 JSON 文件名。省略 canvasId 时重命名激活画布；name 不含 .json 扩展名。不会覆盖已有文件，返回操作后的激活画布概览。", parameters: canvasSchemas.renameCanvas },
  { name: "addNode", label: "新增节点", description: "在激活画布的画布坐标 position 新增节点，type 必须来自 getCanvas({include:['nodeTypes']}) 的 availableNodeTypes。返回新增节点信息；节点函数通过 getNodeTools 按需查询。", parameters: canvasSchemas.addNode },
  { name: "deleteNodes", label: "删除节点", description: "从激活画布批量删除指定 nodeIds 的节点及其连接边；同一批次内的父子节点可以一起删除，任一节点校验失败则整体不执行。返回 removedEdgeCount、最多 100 项 removedEdgeIds 及 truncated；截断只影响删除回执，不代表仅删除了部分连线。", parameters: canvasSchemas.deleteNodes },
  { name: "moveNodes", label: "移动节点", description: "将激活画布指定节点批量移动到各自的画布绝对坐标 position，包含分组内节点；保持原分组归属，一次可传入多个节点，任一项校验失败则整体不执行。", parameters: canvasSchemas.moveNodes },
  { name: "renameNodes", label: "重命名节点", description: "批量修改激活画布指定节点的显示名称，一次可传入多个节点，任一项校验失败则整体不执行。", parameters: canvasSchemas.renameNodes },
  { name: "connectNodes", label: "连接节点", description: "批量连接激活画布的输出端口 sourceHandle 和输入端口 targetHandle，一次可传入多组连接。先用 getCanvasNodes 的 ports 字段确认目标节点与端口；沿用画布和节点的连接校验，任一项校验失败则整体不执行。", parameters: canvasSchemas.connectNodes },
  { name: "deleteEdges", label: "删除连线", description: "从激活画布批量删除指定 edgeIds 的连线，任一项校验失败则整体不执行。", parameters: canvasSchemas.deleteEdges },
  { name: "selectNodes", label: "选择节点", description: "选择激活画布中指定 nodeIds 的节点；传空数组取消节点选择。", parameters: canvasSchemas.selectNodes },
  { name: "arrangeCanvas", label: "整理画布", description: "根据节点实际尺寸和连线，将激活画布的全部顶层节点从左到右自动排列，并适应视图。子节点保持相对位置，不修改内容、连线或选择，不触发生成。返回 arrangedCount、最多 100 项 arrangedNodeIds、truncated 和 viewport；truncated 仅指 ID 回执缩略，不代表仅整理了部分节点。节点尺寸未就绪或存在不可移动节点时拒绝整理。仅在需要整理整幅画布时调用；局部调整使用 moveNodes，单纯查看使用 fitCanvas。", parameters: canvasSchemas.arrangeCanvas },
  { name: "fitCanvas", label: "适应画布", description: "调整激活画布视口以展示 nodeIds 指定的节点；省略 nodeIds 则展示全部节点。返回 fitted、viewport、nodeCount，传入 nodeIds 时另返回最多 100 项 nodeIds 和 truncated；截断只影响回执。", parameters: canvasSchemas.fitCanvas },
  { name: "nodeTools", label: "调用节点函数", description: "调用激活画布节点注册的 node:functionName。先通过 getNodeTools 读取该节点实际函数的完整 parameters，再按 schema 填写 args。新建节点可在同轮查询和调用；不要通过修改画布 JSON 代替节点函数。返回值由具体业务函数决定，五个画布读取工具的 64 KiB 限制不适用于此执行入口。", parameters: canvasSchemas.nodeTools },
  { name: 'duplicateNodes', label: '创建节点副本', description: '复制指定节点及其分组子树，返回新旧 ID 对照；withEdges 默认 true，复制组内连线与传入连线。不重新生成媒体，沿用节点复制生命周期。', parameters: canvasSchemas.duplicateNodes },
  { name: 'groupNodes', label: '打组', description: '将指定节点放入一个新分组，保留绝对位置、内容与连线，可指定分组 label。选中分组时包含其全部子节点。返回 groupId 与组内节点 ID。', parameters: canvasSchemas.groupNodes },
  { name: 'ungroupNodes', label: '解组', description: '取消指定 canvasGroup 分组，将子节点提升到原父组，保持绝对位置、内容与连线。只移除分组框，不删除组内节点。', parameters: canvasSchemas.ungroupNodes },
  { name: 'mergeGroups', label: '合并分组', description: '合并至少两个分组，保留第一个组的 ID，迁移其余组的子节点并保持绝对位置；可指定 label。', parameters: canvasSchemas.mergeGroups },
  { name: 'reparentNodes', label: '调整分组归属', description: '把节点或子组移入 parentId 指定分组；parentId=null 移出到画布顶层。保持绝对位置，拒绝循环嵌套。', parameters: canvasSchemas.reparentNodes },
  { name: 'resizeGroups', label: '调整分组尺寸', description: '修改 canvasGroup 分组框宽高；position 可同时指定新的画布绝对坐标。调整分组框时保持组内节点的绝对位置，不缩放或修改媒体原件。', parameters: canvasSchemas.resizeGroups },
  { name: 'arrangeNodes', label: '排列选中节点', description: '只整理指定节点，支持 horizontal 水平、vertical 垂直、grid 宫格排列，沿用界面选区整理并贴合原分组。不改变分组归属和连线。', parameters: canvasSchemas.arrangeNodes },
  { name: 'undoCanvas', label: '撤销画布操作', description: '撤销当前画布最近一步结构操作，包括分组、移动、大小、名称、节点与连线增删。不能撤销媒体生成、节点正文或外部文件；无可撤销内容时明确报错。', parameters: canvasSchemas.undoCanvas },
  { name: 'redoCanvas', label: '重做画布操作', description: '重做当前画布上一条撤销的结构操作。getCanvas 的 history 返回 canUndo/canRedo。', parameters: canvasSchemas.redoCanvas },
  { name: 'setCanvasView', label: '设置画布视图', description: '设置画布 viewport 平移与缩放（0.2–8），或网格吸附、连线、小地图、素材库与手形模式开关。省略字段保持现状；不修改媒体。getCanvas 返回当前 view 与 history。', parameters: canvasSchemas.setCanvasView },
  { name: 'copyNodes', label: '复制节点到剪贴板', description: '复制指定节点与组内子树、内部连线到画布剪贴数据，返回可传给 pasteNodes 的 command。默认不改动系统剪贴板；writeSystemClipboard=true 时同时写入系统剪贴板。可在同一项目的其他画布粘贴，不复制完整媒体文件。', parameters: canvasSchemas.copyNodes },
  { name: 'pasteNodes', label: '粘贴节点', description: '在画布 position 粘贴 copyNodes 返回的 command，省略 command 则读取系统剪贴板；保留分组结构与内部连线。系统剪贴板权限不足会明确报错。', parameters: canvasSchemas.pasteNodes },
  { name: 'importCanvasAssets', label: '导入工作区素材', description: '将当前项目已有图片、视频、音频或文本 paths 放到画布 position，沿用界面素材拖放。普通图片、视频、音频建立节点内部副本，已有内部原片继续共享；文本正文独立保存，相对文件链接按来源目录转换并保留原目标。不下载整片到浏览器再上传，不提交生成。外部文件先用有权限的文件工具导入工作区。', parameters: canvasSchemas.importCanvasAssets },
  { name: 'createCanvasFolder', label: '新建画布文件夹', description: '在当前项目创建画布文件夹，folder 可用斜杠嵌套，禁止 agent/assets/settings/skills 保留目录。getCanvas include:folders 可读当前文件夹。', parameters: canvasSchemas.createCanvasFolder },
  { name: 'moveCanvas', label: '移动画布到文件夹', description: '移动当前项目画布并同步保存路径，folder 为空字符串移到根目录；省略 canvasId 使用当前画布，返回激活画布状态。不覆盖同名文件。', parameters: canvasSchemas.moveCanvas },
  { name: 'deleteCanvas', label: '删除画布', description: '删除明确 canvasId 的画布及其独占素材；保留其他画布及 Markdown 文档仍在引用的素材，至少保留一张画布。此操作不可撤销，仅在用户明确要求删除该画布时使用。', parameters: canvasSchemas.deleteCanvas },
  { name: 'switchPanel', label: '切换面板', description: '切换工作台面板 canvas（画布）或 document（文档）。文档保留在后台并尝试保存；保存失败仍保留草稿，退出工作区时会再次检查保存。', parameters: canvasSchemas.switchPanel },
  { name: 'getDocument', label: '读取文档', description: '读取当前文档正文、documentId、canWriteText 和选择状态。canWriteText=false 表示该打开方式不支持文本写入。写回时原样携带 documentId，并将原 text 作为 writeDocument 的 expectedText，防止写错文档或覆盖用户的新输入。供应商配置只能在设置中管理，文档工具不能读取。', parameters: canvasSchemas.getDocument },
  { name: 'openDocument', label: '打开文档', description: '打开工作区文档 path（如 .md/.markdown/.txt），或画布中的文本节点 canvasPath+nodeId，可选 handleId。两种目标只提供一种。供应商配置只能在设置中管理，不能通过文档工具打开。', parameters: canvasSchemas.openDocument },
  { name: 'writeDocument', label: '保存文档', description: '通过文档编辑器保存可编辑文本文件或节点正文；canWriteText=false 的预览不支持本工具。必须携带刚读取的 documentId 和原 text（作为 expectedText），同时校验目标文档与正文，防止切换文档或输出后写错文件、覆盖用户新输入。返回实际写入文档的状态；等待保存时用户切换标签不会把回执换成另一文档。', parameters: canvasSchemas.writeDocument },
  { name: 'closeDocument', label: '关闭文档', description: '先保存，再关闭当前文档的全部视图；也可指定文件 path，或节点 canvasPath+nodeId，两种目标不能混用。不删除文件或节点，不丢弃草稿；保存失败保留标签。未打开时返回 closedViews:0，remainingViews 表示仍打开的视图数。', parameters: canvasSchemas.closeDocument },
  { name: 'moveDocument', label: '移动文档', description: '移动或重命名文档文件或其目录，target 为项目内完整新路径，省略 path 使用当前文件文档。先保存，同步目录内已打开的文档与画布路径，保留 Markdown 图片和附件链接目标，不覆盖已有文件。内部原件保持原位，单张画布使用 moveCanvas/renameCanvas；仍被其他文档或画布引用的原件须先另存副本再整理。', parameters: canvasSchemas.moveDocument },
  { name: 'createAssetFolder', label: '新建素材文件夹', description: '在当前项目创建素材文件夹 folder，可嵌套到 assets 内；禁止 agent/settings/skills 等保留目录，不修改已有素材或画布。', parameters: canvasSchemas.createAssetFolder },

];

export const CANVAS_TOOLS = canvasOperations.map(({ name, description, parameters }: Record<string, any>) => ({ name, description, parameters: z.toJSONSchema(parameters, { io: "input", target: "draft-07" }) }));

export const PANEL_TOOLS = CANVAS_TOOLS.filter(tool => ["switchPanel", "getDocument", "openDocument", "writeDocument", "closeDocument", "moveDocument"].includes(tool.name));
