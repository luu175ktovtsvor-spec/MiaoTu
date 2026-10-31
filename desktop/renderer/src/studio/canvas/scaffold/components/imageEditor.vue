<template>
  <div class="imageEditor" :class="{ editing: mode }">
    <img ref="sourceImage" :src="src" :alt="alt" draggable="false" @load="emit('load', $event)" @error="emit('error', $event)" />
    <canvas
      v-if="mode"
      ref="paintCanvas"
      class="paintCanvas nodrag nopan nowheel"
      :class="{ inpaint: mode === 'inpaint' }"
      :style="{ aspectRatio: `${sourceImage?.naturalWidth} / ${sourceImage?.naturalHeight}`, cursor: tool === 'text' ? 'text' : 'crosshair' }"
      :aria-label="mode === 'inpaint' ? translate('涂抹需要重绘的区域') : translate('图片标记画布')"
      @pointerdown.stop.prevent="startStroke"
      @pointermove.stop.prevent="moveStroke"
      @pointerup.stop.prevent="finishStroke"
      @pointercancel.stop="cancelStroke"
      @lostpointercapture="cancelStroke"
      @mousedown.stop
      @dblclick.stop
      @contextmenu.stop.prevent />
    <textarea
      v-if="textDraft"
      ref="textInput"
      v-model="textDraft.text"
      class="textInput nodrag nopan nowheel"
      :style="textStyle"
      :rows="Math.max(1, textDraft.text.split('\n').length)"
      :aria-label="translate('标记文本')"
      :placeholder="translate('输入文本')"
      wrap="off"
      @pointerdown.stop
      @mousedown.stop
      @dblclick.stop
      @keydown.stop="handleTextKey"
      @blur="commitText" />
  </div>
  <teleport v-if="mode && toolbarTarget" :to="toolbarTarget">
    <div class="paintToolbar" @keydown.esc.stop.prevent="!busy && cancel()">
      <el-button class="exitButton" :icon="IconX" :disabled="busy" text :title="mode === 'mark' ? translate('取消标记') : translate('取消局部重绘')" :aria-label="mode === 'mark' ? translate('取消标记') : translate('取消局部重绘')" @click="cancel">{{ mode === 'mark' ? translate('标注') : translate('重绘') }}</el-button>
      <el-button v-if="showBrush" :icon="IconBrush" :type="tool === 'brush' ? 'primary' : 'default'" :disabled="busy" text :title="translate('画笔')" :aria-label="translate('画笔')" :aria-pressed="tool === 'brush'" @click="tool = 'brush'" />
      <template v-if="mode === 'mark'">
        <el-button :icon="IconSquare" :type="tool === 'rectangle' ? 'primary' : 'default'" :disabled="busy" text :title="translate('矩形')" :aria-label="translate('矩形')" :aria-pressed="tool === 'rectangle'" @click="tool = 'rectangle'" />
        <el-button :icon="IconCircle" :type="tool === 'circle' ? 'primary' : 'default'" :disabled="busy" text :title="translate('圆形')" :aria-label="translate('圆形')" :aria-pressed="tool === 'circle'" @click="tool = 'circle'" />
        <el-button :icon="IconTypography" :type="tool === 'text' ? 'primary' : 'default'" :disabled="busy" text :title="translate('文本')" :aria-label="translate('文本')" :aria-pressed="tool === 'text'" @click="tool = 'text'" />
      </template>
      <el-button v-if="showBox" :icon="IconSquare" :type="tool === 'rectangle' ? 'primary' : 'default'" :disabled="busy" text :title="translate('框选区域')" :aria-label="translate('框选区域')" :aria-pressed="tool === 'rectangle'" @click="tool = 'rectangle'" />
      <el-button v-if="showBrush" :icon="IconEraser" :type="tool === 'eraser' ? 'primary' : 'default'" :disabled="busy" text :title="translate('橡皮擦')" :aria-label="translate('橡皮擦')" :aria-pressed="tool === 'eraser'" @click="tool = 'eraser'" />
      <input v-if="mode === 'mark'" v-model="color" type="color" class="brushColor" :disabled="busy" :title="translate('画笔颜色')" :aria-label="translate('画笔颜色')" />
      <label v-if="tool !== 'rectangle' || mode === 'mark'" class="brushSize">{{ tool === 'text' ? translate('字号') : translate('粗细') }}<input v-model.number="toolSize" type="range" :min="tool === 'text' ? 12 : 2" max="60" :disabled="busy" :aria-label="tool === 'text' ? translate('文本字号') : translate('画笔粗细')" /><span>{{ toolSize }}</span></label>
      <el-button :icon="IconArrowBackUp" :disabled="busy || !strokeCount" text :title="translate('撤销')" :aria-label="translate('撤销')" @click="undo" />
      <el-button :icon="IconArrowForwardUp" :disabled="busy || strokeCount === historyLength" text :title="translate('恢复')" :aria-label="translate('恢复')" @click="redo" />
      <el-button :icon="IconTrash" :disabled="busy || !hasDrawing" :title="translate('清空标记')" :aria-label="translate('清空标记')" @click="clear" />
      <el-button v-if="mode === 'mark'" class="saveButton" :icon="IconCheck" :disabled="!hasDrawing && !textDraft?.text.trim()" :loading="busy" type="primary" @click="saveMark()">{{ translate('保存') }}</el-button>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import { ElButton, ElMessage } from "element-plus";
import { IconBrush, IconEraser, IconSquare, IconCircle, IconTypography, IconArrowBackUp, IconArrowForwardUp, IconTrash, IconCheck, IconX } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { nodeTools, z } from "../nodeTools";
import { uploadNodeFile, useNodeFiles } from "../workspaceFiles";
import type { NodeImageEdit } from "../nodeAi";

const props = defineProps<{ src: string; alt: string; toolbarTarget?: HTMLElement; disabled?: boolean; regionEdit?: "mask" | "annotation" | null }>();
const emit = defineEmits<{ load: [event: Event]; error: [event: Event] }>();
const { node } = useNode();
const { addNodes, findNode, getNodes, nodeTypes } = useVueFlow();
const files = useNodeFiles();
const getCanvas = inject<(() => { id: string } | undefined) | undefined>("canvas", undefined);
const batchHistory = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());
const sourceImage = ref<HTMLImageElement>();
const paintCanvas = ref<HTMLCanvasElement>();
const mode = ref<"inpaint" | "mark">();
const busy = ref(false);
const tool = ref<"brush" | "eraser" | "rectangle" | "circle" | "text">("brush");
const color = ref("#ff4545");
const brushSize = ref(16);
const fontSize = ref(24);
const toolSize = computed({
  get: () => tool.value === "text" ? fontSize.value : brushSize.value,
  set: value => { if (tool.value === "text") fontSize.value = value; else brushSize.value = value; },
});
const strokeCount = ref(0);
const historyLength = ref(0);
const hasDrawing = ref(false);
type Point = { x: number; y: number };
type Stroke = { tool: typeof tool.value | "clear"; color: string; size: number; points: Point[]; text?: string };
const textInput = ref<HTMLTextAreaElement>();
const textDraft = ref<(Stroke & { text: string })>();
const textStyle = computed(() => {
  const canvas = paintCanvas.value;
  const draft = textDraft.value;
  if (!canvas || !draft) return {};
  const scale = canvas.clientWidth / canvas.width;
  const point = draft.points[0]!;
  return { left: `${canvas.offsetLeft + point.x * scale}px`, top: `${canvas.offsetTop + point.y * scale}px`, width: `${Math.max(40, canvas.clientWidth - point.x * scale)}px`, fontSize: `${draft.size * scale}px`, color: draft.color };
});
// 服务端 edit 契约里的蒙版是个 RGBA PNG，且单边不超过 8192、总像素不超过 3600 万；
// 超过就先拦下，不要让人涂完才在提交时被拒。
const MAX_EDIT_EDGE = 8192;
const MAX_EDIT_PIXELS = 36_000_000;
let strokes: Stroke[] = [];
let draftStroke: Stroke | undefined;
let pointerId: number | undefined;
let operation: AbortController | undefined;

// 局部重绘的工具集跟着通道能力走：蒙版通道用涂抹，标注通道只能用框选。
// 标记模式和通道无关，始终保留整套画笔。
const showBrush = computed(() => mode.value === "mark" || (mode.value === "inpaint" && props.regionEdit !== "annotation"));
const showBox = computed(() => mode.value === "inpaint" && props.regionEdit === "annotation");

function cancel() {
  operation?.abort();
  mode.value = undefined;
  strokes = [];
  strokeCount.value = historyLength.value = 0;
  hasDrawing.value = false;
  textDraft.value = undefined;
  cancelStroke();
}
watch(() => props.src, cancel, { flush: "sync" });
watch(() => getCanvas?.()?.id, cancel, { flush: "sync" });
watch(() => props.regionEdit, async (value) => {
  if (mode.value !== "inpaint") return;
  cancel();
  tool.value = value === "annotation" ? "rectangle" : "brush";
  mode.value = "inpaint";
  await nextTick();
  const image = sourceImage.value;
  if (paintCanvas.value && image?.naturalWidth) {
    paintCanvas.value.width = image.naturalWidth;
    paintCanvas.value.height = image.naturalHeight;
  }
});
onBeforeUnmount(cancel);

async function start(value: "inpaint" | "mark") {
  if (props.disabled || busy.value) return;
  const source = props.src;
  // 画布节点展示原图像素。标记和局部重绘也必须在原图上生成蒙版，不能用缩略图。
  const original = new Image();
  original.src = source;
  busy.value = true;
  try { await original.decode(); }
  catch { ElMessage.error(translate("原图无法读取，请下载后重新上传")); return; }
  finally { busy.value = false; }
  if (source !== props.src || props.disabled) return;
  const image = original;
  if (value === "inpaint" && (image.naturalWidth > MAX_EDIT_EDGE || image.naturalHeight > MAX_EDIT_EDGE || image.naturalWidth * image.naturalHeight > MAX_EDIT_PIXELS)) {
    return void ElMessage.error(translate("图片超过局部编辑上限（单边 8192 像素、合计 3600 万像素）"));
  }
  cancel();
  tool.value = value === "inpaint" && props.regionEdit === "annotation" ? "rectangle" : "brush";
  mode.value = value;
  await nextTick();
  try { await sourceImage.value?.decode(); }
  catch { cancel(); return; }
  if (!paintCanvas.value || source !== props.src) return;
  paintCanvas.value.width = image.naturalWidth;
  paintCanvas.value.height = image.naturalHeight;
}

function getPoint(event: PointerEvent): Point {
  const canvas = paintCanvas.value!;
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) / bounds.width * canvas.width)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) / bounds.height * canvas.height)),
  };
}

function drawSegment(stroke: Stroke, point: Point, previous = point) {
  const context = paintCanvas.value?.getContext("2d");
  if (!context) return;
  context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.fillStyle = context.strokeStyle = stroke.color;
  context.lineWidth = stroke.size;
  context.lineCap = context.lineJoin = "round";
  context.beginPath();
  if (point === previous) {
    context.arc(point.x, point.y, stroke.size / 2, 0, Math.PI * 2);
    context.fill();
  } else {
    context.moveTo(previous.x, previous.y);
    context.lineTo(point.x, point.y);
    context.stroke();
  }
}

async function startStroke(event: PointerEvent) {
  const canvas = paintCanvas.value;
  if (!props.toolbarTarget || busy.value || props.disabled || event.button !== 0 || pointerId !== undefined || !canvas) return;
  commitText();
  const stroke: Stroke = { tool: tool.value, color: mode.value === "inpaint" ? "#ff4545" : color.value, size: toolSize.value * canvas.width / canvas.clientWidth, points: [getPoint(event)] };
  if (tool.value === "text") {
    textDraft.value = { ...stroke, text: "" };
    await nextTick();
    textInput.value?.focus();
    return;
  }
  pointerId = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  draftStroke = stroke;
  if (stroke.tool === "brush" || stroke.tool === "eraser") drawSegment(stroke, stroke.points[0]!);
}

function moveStroke(event: PointerEvent) {
  if (event.pointerId !== pointerId || busy.value) return;
  const stroke = draftStroke!;
  const point = getPoint(event);
  if (stroke.tool === "brush" || stroke.tool === "eraser") {
    drawSegment(stroke, point, stroke.points.at(-1));
    stroke.points.push(point);
  } else {
    stroke.points[1] = point;
    redraw();
    drawStroke(stroke);
  }
}

function finishStroke(event: PointerEvent) {
  if (event.pointerId !== pointerId) return;
  moveStroke(event);
  const stroke = draftStroke!;
  draftStroke = undefined;
  pointerId = undefined;
  if (paintCanvas.value?.hasPointerCapture(event.pointerId)) paintCanvas.value.releasePointerCapture(event.pointerId);
  if ((stroke.tool === "rectangle" || stroke.tool === "circle") && (!stroke.points[1] || stroke.points[0]!.x === stroke.points[1].x || stroke.points[0]!.y === stroke.points[1].y)) return void redraw();
  commitStroke(stroke);
}

function cancelStroke() {
  const captured = pointerId;
  pointerId = undefined;
  draftStroke = undefined;
  if (captured !== undefined && paintCanvas.value?.hasPointerCapture(captured)) paintCanvas.value.releasePointerCapture(captured);
  redraw();
}

function drawStroke(stroke: Stroke) {
  const canvas = paintCanvas.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;
  if (stroke.tool === "clear") return context.clearRect(0, 0, canvas.width, canvas.height);
  if (stroke.tool === "brush" || stroke.tool === "eraser") return stroke.points.forEach((point, index) => drawSegment(stroke, point, stroke.points[index - 1]));
  const start = stroke.points[0]!;
  context.globalCompositeOperation = "source-over";
  context.fillStyle = context.strokeStyle = stroke.color;
  context.lineWidth = stroke.size;
  context.lineJoin = "miter";
  context.lineCap = "butt";
  if (stroke.tool === "text") {
    context.font = `${stroke.size}px sans-serif`;
    context.textBaseline = "top";
    stroke.text!.split("\n").forEach((line, index) => context.fillText(line, start.x, start.y + index * stroke.size * 1.25));
    return;
  }
  const end = stroke.points[1];
  if (!end) return;
  context.beginPath();
  if (stroke.tool === "rectangle") context.rect(start.x, start.y, end.x - start.x, end.y - start.y);
  else {
    const radius = Math.min(Math.abs(end.x - start.x), Math.abs(end.y - start.y)) / 2;
    context.arc(start.x + Math.sign(end.x - start.x) * radius, start.y + Math.sign(end.y - start.y) * radius, radius, 0, Math.PI * 2);
  }
  context.stroke();
}

function redraw() {
  const canvas = paintCanvas.value;
  canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  hasDrawing.value = false;
  // ACT: 形状预览和历史切换重放矢量操作；超长标记需要分段快照，普通画笔移动仍只增量绘制。
  for (const stroke of strokes.slice(0, strokeCount.value)) {
    drawStroke(stroke);
    if (stroke.tool === "clear") hasDrawing.value = false;
    else if (stroke.tool !== "eraser") hasDrawing.value = true;
  }
}

function commitStroke(stroke: Stroke) {
  strokes.splice(strokeCount.value, strokes.length - strokeCount.value, stroke);
  strokeCount.value = historyLength.value = strokes.length;
  redraw();
}

function clear() {
  if (!busy.value) commitStroke({ tool: "clear", color: "", size: 0, points: [] });
}

function undo() {
  if (busy.value || !strokeCount.value) return;
  strokeCount.value--;
  redraw();
}

function redo() {
  if (busy.value || strokeCount.value === historyLength.value) return;
  strokeCount.value++;
  redraw();
}

function commitText() {
  const draft = textDraft.value;
  textDraft.value = undefined;
  if (draft?.text.trim() && !busy.value && mode.value === "mark") commitStroke(draft);
}

function handleTextKey(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    event.preventDefault();
    textDraft.value = undefined;
  } else if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    commitText();
  }
}

function createCanvas() {
  const source = sourceImage.value;
  if (!source?.naturalWidth || !paintCanvas.value) throw new Error(translate("图片尚未加载完成"));
  const canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth;
  canvas.height = source.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(translate("无法创建绘画画布"));
  return { canvas, context };
}

function toFile(canvas: HTMLCanvasElement) {
  return new Promise<File>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(new File([blob], "image.png", { type: "image/png" })) : reject(new Error(translate("图片编码失败"))), "image/png"));
}

// 局部重绘提交给服务端的区域参数。蒙版通道要把涂过的地方擦成透明（服务端约定：透明 = 要改），
// 标注通道则把框选换算成 0–1 的归一化坐标。
function buildEdit(): NodeImageEdit {
  const canvas = paintCanvas.value;
  const image = sourceImage.value;
  if (!canvas || !image?.naturalWidth) throw new Error(translate("图片尚未加载完成"));
  if (mode.value !== "inpaint") throw new Error(translate("请先进入局部重绘"));
  const committed = strokes.slice(0, strokeCount.value);
  if (props.regionEdit === "annotation") {
    const boxes = committed.flatMap((stroke) => {
      const end = stroke.points[1];
      if (stroke.tool !== "rectangle" || !end) return [];
      const box: [number, number, number, number] = [
        Math.min(stroke.points[0]!.x, end.x) / canvas.width,
        Math.min(stroke.points[0]!.y, end.y) / canvas.height,
        Math.max(stroke.points[0]!.x, end.x) / canvas.width,
        Math.max(stroke.points[0]!.y, end.y) / canvas.height,
      ];
      return box[2] - box[0] > 0 && box[3] - box[1] > 0 ? [box] : [];
    });
    if (!boxes.length) throw new Error(translate("请先框选需要修改的区域"));
    return { annotations: boxes.map(box => ({ tool: "box" as const, box })) };
  }
  const mask = document.createElement("canvas");
  mask.width = canvas.width;
  mask.height = canvas.height;
  const context = mask.getContext("2d");
  if (!context) throw new Error(translate("无法创建蒙版画布"));
  context.fillStyle = "#000000";
  context.fillRect(0, 0, mask.width, mask.height);
  context.globalCompositeOperation = "destination-out";
  context.drawImage(canvas, 0, 0);
  context.globalCompositeOperation = "source-over";
  const pixels = context.getImageData(0, 0, mask.width, mask.height).data;
  let selected = false;
  let preserved = false;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] === 0) selected = true;
    else if (pixels[index] === 255) preserved = true;
    if (selected && preserved) break;
  }
  if (!selected) throw new Error(translate("请先涂抹需要重绘的区域"));
  if (!preserved) throw new Error(translate("不要涂满整张图片，保留涂抹以外的内容"));
  return { mask: mask.toDataURL("image/png") };
}

async function saveMark(signal?: AbortSignal, toolCall = false) {
  signal?.throwIfAborted();
  if (busy.value) return;
  commitText();
  if (!hasDrawing.value) return;
  if (!nodeTypes?.value?.["remote-imageNode"]) return void ElMessage.error(translate("请先启用图片节点插件"));
  const controller = operation = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  busy.value = true;
  const id = crypto.randomUUID();
  let workspace: ReturnType<typeof files.getWorkspaceFiles> | undefined;
  let committed = false;
  try {
    workspace = files.getWorkspaceFiles();
    const { canvas, context } = createCanvas();
    context.drawImage(sourceImage.value!, 0, 0);
    context.drawImage(paintCanvas.value!, 0, 0);
    const width = canvas.width / canvas.height * 360 + 2;
    const height = 410;
    const file = await toFile(canvas);
    canvas.width = canvas.height = 0;
    controller.signal.throwIfAborted();
    const path = await uploadNodeFile(workspace, id, file, undefined, controller.signal);
    controller.signal.throwIfAborted();
    if (findNode(node.id) !== node || !nodeTypes?.value?.["remote-imageNode"]) throw new Error(translate("画布节点已变化，请重新保存"));
    const x = node.computedPosition.x + Math.max(node.dimensions.width || 0, node.data.mediaExportSize?.width || width) + 80;
    let y = node.computedPosition.y;
    for (const other of [...getNodes.value].sort((left, right) => left.computedPosition.y - right.computedPosition.y)) {
      const reserved = other.data.mediaExportSize || other.data.directorExportSize;
      const otherWidth = Math.max(other.dimensions.width || 0, reserved?.width || 320);
      const otherHeight = Math.max(other.dimensions.height || 0, reserved?.height || 410);
      if (other.computedPosition.x < x + width && other.computedPosition.x + otherWidth > x && other.computedPosition.y < y + height && other.computedPosition.y + otherHeight > y) y = other.computedPosition.y + otherHeight + 40;
    }
    await batchHistory(async () => {
      controller.signal.throwIfAborted();
      // 标记新建节点的名称会写进画布数据，保持中文原文，不随语言切换。
      addNodes([{ id, type: "remote-imageNode", position: { x, y }, data: { label: `${node.data.label || "图片"} · 标记`, mediaExportSize: { width, height }, outputs: { image: { dataType: "IMAGE", value: { url: path, mimeType: "image/png" } } } } }]);
      committed = true;
    });
    mode.value = undefined;
    strokes = []; strokeCount.value = historyLength.value = 0; hasDrawing.value = false;
    return { nodeId: id, path };
  } catch (error) {
    if (toolCall) throw error;
    if (!controller.signal.aborted) ElMessage.error(error instanceof Error ? error.message : translate("标记保存失败"));
  } finally {
    if (!committed && workspace) await workspace.remove(`assets/${id}`, true).catch(error => {
      if (error?.response?.data?.data?.code !== "ENOENT") ElMessage.error(translate("标记临时文件清理失败"));
    });
    signal?.removeEventListener("abort", abort);
    operation = undefined;
    busy.value = false;
  }
}

nodeTools.register({
  name: 'editImageMarks',
  description: '使用原图像素坐标操作图片标记或局部重绘蒙版。mode=mark 支持笔刷、橡皮、矩形、圆形、文字，save 保存新图片节点并保留原图；mode=inpaint 只准备选区，不发起生成。action=set 替换笔画、append 追加、undo/redo/clear/cancel 控制编辑历史。points 是像素坐标，矩形/圆形需两个对角点，文字需一个起点及 text。',
  parameters: z.strictObject({
    mode: z.enum(['mark', 'inpaint']), action: z.enum(['set', 'append', 'undo', 'redo', 'clear', 'save', 'cancel']),
    strokes: z.array(z.strictObject({ tool: z.enum(['brush','eraser','rectangle','circle','text']), color: z.string().regex(/^#[a-f0-9]{6}$/i).default('#ff4545'), size: z.number().min(1).max(500).default(16), points: z.array(z.strictObject({ x: z.number().finite().min(0), y: z.number().finite().min(0) })).min(1).max(2000), text: z.string().max(4000).optional() })).max(100).optional(),
  }),
  async execute(args, { signal }) {
    if (props.disabled || busy.value) throw new Error('图片正在处理，请稍后重试');
    if (args.action === 'cancel') { cancel(); return { editing: false }; }
    if (mode.value !== args.mode) await start(args.mode);
    signal?.throwIfAborted();
    const canvas = paintCanvas.value;
    if (!canvas?.width || !canvas.height || !mode.value) throw new Error('图片编辑器尚未就绪，请确认原图已加载');
    const entries = args.strokes ?? [];
    for (const stroke of entries) {
      if (stroke.points.some(point => point.x > canvas.width || point.y > canvas.height)) throw new Error('标记坐标超出原图范围');
      if (['rectangle','circle'].includes(stroke.tool) && stroke.points.length !== 2) throw new Error('矩形和圆形需要两个对角点');
      if (stroke.tool === 'text' && !stroke.text?.trim()) throw new Error('文字标记需要 text');
      if (args.mode === 'inpaint' && (props.regionEdit === 'annotation' ? stroke.tool !== 'rectangle' : !['brush','eraser','rectangle'].includes(stroke.tool))) throw new Error('当前局部重绘选区不支持该标记工具');
    }
    if (args.action === 'set') clear();
    if (args.action === 'set' || args.action === 'append') entries.forEach(stroke => commitStroke(stroke));
    if (args.action === 'undo') undo();
    if (args.action === 'redo') redo();
    if (args.action === 'clear') clear();
    if (args.action === 'save') {
      if (args.mode !== 'mark' || !hasDrawing.value) throw new Error('请先添加标记，蒙版模式通过节点生成工具另行提交');
      return saveMark(signal, true);
    }
    return { mode: mode.value, width: canvas.width, height: canvas.height, strokeCount: strokeCount.value, historyLength: historyLength.value, regionEdit: props.regionEdit ?? 'mask' };
  },
});

defineExpose({ mode, busy, start, cancel, buildEdit });
</script>

<style scoped lang="scss">
.imageEditor {
  position: relative;
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;

  img { display: block; width: 100%; max-height: 360px; object-fit: contain; border-radius: var(--el-border-radius-base); }
  .paintCanvas { position: absolute; max-width: 100%; max-height: 100%; height: 100%; touch-action: none; cursor: crosshair; }
  .paintCanvas.inpaint { opacity: 0.55; }
  .textInput { position: absolute; z-index: 1; box-sizing: border-box; padding: 0; border: 1px dashed currentColor; outline: none; resize: none; overflow: hidden; background: rgb(255 255 255 / 85%); font-family: sans-serif; line-height: 1.25; }
}
.paintToolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--el-border-color-light);
  border-radius: var(--el-border-radius-base);
  background: var(--el-bg-color-overlay);
  color: var(--el-text-color-primary);
  box-shadow: var(--el-box-shadow-light);
  white-space: nowrap;

  .el-button { margin: 0; padding: 0 8px; min-width: 32px; }
  .exitButton { margin-right: 4px; }
  .saveButton { margin-left: 8px; padding: 0 12px; }
  .brushColor { width: 26px; height: 26px; padding: 2px; border: 1px solid var(--el-border-color); border-radius: 5px; background: transparent; cursor: pointer; }
  .brushSize { display: flex; align-items: center; gap: 6px; padding: 0 8px; font-size: 12px; input { width: 70px; accent-color: var(--el-color-primary); } span { min-width: 18px; } }
}
</style>
