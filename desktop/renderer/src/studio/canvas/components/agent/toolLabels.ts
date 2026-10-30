import { canvasOperations } from "../../toolRuntimeCompat";
import type { AgentToolCall } from "@miaoimg/server/agent/types";

// 工具的中文动作名：工具卡片和对话里的「正在…」状态共用这一份。
export const toolLabels: Record<string, string> = {
  webSearch: "搜索网页", webFetch: "读取网页", browser: "操作浏览器", read: "读取本地文件", write: "写入本地文件", edit: "修改本地文件",
  ls: "查看文件夹", find: "查找文件", grep: "搜索文件内容", bash: "在电脑上运行命令", powershell: "在电脑上运行命令",
  importLocalFile: "导入本地素材", exportWorkspaceFile: "导出工作区文件", localToolInfo: "检查电脑上的软件",
  listSkills: "查看可用技能", readSkill: "读取创作方法", getCanvas: "查看画布", getCanvasNodes: "查看画布节点", getAppState: "查看工作区",
  nodeTools: "操作画布节点", getNodeTools: "查看节点能力", addNode: "添加节点", deleteNodes: "删除节点", moveNodes: "移动节点", renameNodes: "重命名节点",
  addCanvas: "新建画布", switchCanvas: "切换画布", renameCanvas: "重命名画布", findCanvasNodes: "查找画布节点", getCanvasEdges: "查看画布连线",
  connectNodes: "连接节点", deleteEdges: "删除连线", selectNodes: "选中节点", arrangeCanvas: "整理画布", fitCanvas: "适合屏幕",
  editDocument: "修改文档", readDocument: "读取文档", openDocument: "打开文档", getDocument: "读取文档", writeDocument: "修改文档",
  inspectVideo: "查看视频画面", inspectReference: "查看参考素材", probeMedia: "读取媒体信息", ffmpeg: "处理媒体", ffprobe: "读取媒体信息",
  messageSubAgent: "补充子任务", waitSubAgents: "等待子任务", stopSubAgent: "停止子任务", getSubAgents: "查看子任务", delegate: "委派团队成员", teamResources: "读取团队资料", askUser: "提问", report: "上报进展", subAgent: "执行子任务", listWorkspaceFiles: "查看工作区文件", readWorkspaceFile: "读取工作区文件", writeWorkspaceFile: "写入工作区文件", searchInspirationLibrary: "检索创作精选",
};
Object.assign(toolLabels, Object.fromEntries(canvasOperations.map(tool => [tool.name, tool.label])));
const nodeActions: Record<string, string> = { "node:setText": "写入文本", "node:getConfig": "读取节点配置", "node:setConfig": "更新节点配置", "node:processVideo": "剪辑视频", "node:processAudio": "处理音频", "node:splitImageGrid": "图片宫格切分", "node:editImageMarks": "编辑图片标记", "node:saveOutputAsAsset": "保存素材", "node:prepareImageVariation": "创建图片编辑节点" };
Object.assign(nodeActions, { 'node:setDirectorEditor': '打开或关闭导演台', 'node:addDirectorMannequin': '添加关节人偶', 'node:setDirectorOptions': '设置导演台环境', 'node:selectDirectorPlan': '切换动画方案', 'node:editDirectorAnchors': '编辑镜头关键帧', 'node:exportDirectorImage': '导出关键帧图片', 'node:controlDirectorView': '操作导演台预览', 'node:editDirector': '修改导演场景与动画', 'node:readDirector': '读取导演台' });
Object.assign(nodeActions, { 'node:generateImage': '生成图片', 'node:generateVideo': '生成视频', 'node:generateText': '生成文本', 'node:setPrompt': '写入提示词', 'node:getGenerationStatus': '查看生成进度', 'node:createStoryboard': '生成分镜', 'node:listImagePresets': '查看图片快捷预设', 'node:applyImagePreset': '使用图片快捷预设', 'node:getText': '读取文本' });
Object.assign(nodeActions, { 'node:focusNode': '聚焦节点', 'node:setImagePreview': '查看图片大图', 'node:setTextEditor': '打开或关闭文本编辑器' });

Object.assign(toolLabels, { readCameras:'读取机位', editCameras:'编辑机位草稿', readStage:'读取灯光与环境', editStage:'修改灯光与环境', getStageLibrary: '读取布景库', addStageAsset: '添加布景', applyActorPose: '设置人偶姿势', inspectDocument: '检查场景画面', applyDirectorCandidate: '保存导演台修改' });
Object.assign(nodeActions, { 'node:getDirectorAssets': '读取布景库', 'node:addDirectorAsset': '添加布景与道具', 'node:applyDirectorPose': '设置人偶姿势', 'node:restoreDirectorHistory': '撤销或重做布景', 'node:manageDirectorPlans':'管理导演方案', 'node:editDirectorTimeline':'编辑动画时间轴', 'node:createDirectorCameraMotion': '创建机位运镜', 'node:setDirectorMode': '切换导演助手任务', 'node:stopDirectorTask': '停止导演助手', 'node:inspectScene': '检查场景画面', 'node:exportDirectorVideo': '导出预演视频' });

export function parsedToolArgs(value: unknown): Record<string, any> {
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

// 未翻译的动作名，调用方按界面语言 translate。
export function toolActionLabel(tool: Pick<AgentToolCall, "name" | "args">): string {
  const args = parsedToolArgs(tool.args);
  if (tool.name === 'updateStageAsset' || tool.name === 'nodeTools' && args.name === 'node:updateDirectorAsset') { const action = tool.name === 'nodeTools' ? parsedToolArgs(args.args).action : args.action; return action === 'copy' ? '复制整体道具' : action === 'remove' ? '删除整体道具' : action === 'ungroup' ? '拆开道具' : '调整整体道具'; }
  if (tool.name === 'readDocument' && ['scene', 'plan', 'history', 'schema'].includes(args.section)) return ({ scene: '读取场景', plan: '读取动画方案', history: '读取历史方案', schema: '读取可编辑参数' } as Record<string, string>)[args.section]!;
  if (tool.name === 'editDocument' && Array.isArray(args.operations) && args.operations.some((op: any) => ['scene','plan'].includes(op.section))) return args.operations.every((op: any) => op.section === 'scene') ? '修改场景草稿' : '修改动画草稿';
  if (tool.name === 'addStageAsset') return args.kind === 'actor' ? '添加人偶' : args.kind === 'set' ? '搭建场景' : '添加道具';
  return (tool.name === "nodeTools" && nodeActions[parsedToolArgs(tool.args).name]) || toolLabels[tool.name] || "操作工具";
}
