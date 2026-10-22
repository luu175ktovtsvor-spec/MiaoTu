// 生成进度的**框架无关**计算核心：画布节点（Vue）和历史面板（React 外壳）共用这一份，
// 谁也不许再写第二份估算。这里只有纯计算 + 一个可选的峰值跟踪器，没有 Vue / React 依赖。
//
// 三条信号来源，质量不同，界面必须区别对待：
// 1. 上游真报了百分比 —— 直接用真值（视频方舟通道 server/ark-video.ts 的 progressValue()，
//    由 server/video-api.ts 的 pollVideo() 放进响应体回给浏览器；本地 ffmpeg 的 -progress 同理）。
// 2. 上游不报百分比 —— 图片生成就是这一类（server/image_api.ts 的生成记录里没有 progress 字段），
//    只能按「阶段 + 已生成时长 / 该模型典型耗时」估算推进，封顶 ESTIMATE_CAP，成功才到 100。
//    估算值照样显示数字（产品要求 0~100 一路可见），但用 ≈ 前缀和真值区分。
// 3. 排队 —— 停在 0%，等真正开跑才起算估算钟。

export type ProgressKind = "image" | "video";
export type ProgressPhase = "idle" | "submitting" | "confirming" | "queued" | "running" | "saving" | "pending" | "succeeded" | "failed" | "cancelled";

// Platform confirmation, login and read failures are waiting states. Their
// existing detail message must not be presented as measured generation work.
export function isLocalPlatformWaiting(modelId: string, status: string, message?: string): boolean {
  return /^(doubao|dola)-local-/.test(modelId || "") && status === "running" && !!message?.trim();
}

export type ProgressInput = {
  phase: ProgressPhase;
  // 上游本轮真报的百分比；通道不报就是 null。
  realPercent: number | null;
  // 各消费者自己计时。约定：只算「真正在生成」的那段，不含排队 —— 典型耗时表来自
  // 生产库的 started_at → finished_at，本来就不含排队，拿排队时间去除它会虚高。
  elapsedSeconds: number;
  modelId: string;
  kind: ProgressKind;
  // 本轮已见过的真值峰值。不传就退回 realPercent；给了就用它兜底，避免上游偶尔回一次
  // null 让数字倒退。createProgressTracker 会替你维护这个值。
  realPeak?: number | null;
};

export type ProgressView = {
  // 0–100，已经合并好的最终值，直接拿去画环/条；失败/取消按规则清为 0。
  percent: number;
  // true = 当前这个数来自估算，界面加 ≈ 前缀；false = 上游真实测量。
  estimated: boolean;
  // 提交未确认、失败/取消没有可用的完成比例。
  showPercent: boolean;
};

// 估算推进的天花板。留 10% 给「落盘 / 写回画布」和完成，别让估算先把条跑到头。
export const ESTIMATE_CAP = 90;
// 估算曲线 percent = CAP * (1 - e^(-RATE * 已生成时长/典型耗时))：起步快、越接近典型耗时越慢，
// 永远不会越过 CAP。RATE=1.5 时，走满一个典型耗时约到 CAP 的 78%，两倍典型耗时约 95%。
const ESTIMATE_RATE = 1.5;
// 上游已经出图/出片、正在写回画布时停在 95%（只有估算通道需要这个占位）。
const SAVING_PERCENT = 95;

// 每个模型的典型耗时（秒），估算分母。两个消费者必须用同一个分母，所以和计算放在一起。
//
// 数据来源：生产库 generations 表的真实结算记录（服务器挂载 /opt/miaoimg/.oip/runtime-data/
// management.sqlite，容器内是 /app/data/management.sqlite）。口径：
//   SELECT model, (julianday(finished_at) - julianday(started_at)) * 86400 AS seconds
//   FROM generations WHERE status='succeeded' AND finished_at IS NOT NULL;
// 按模型分组取中位数（偶数个样本取中间两条的均值后四舍五入）；样本只有 1 条的模型直接取
// 那一条。采样时间 2026-10-06，样本量很小（每个模型 1–8 条），只当作量级参考。
// 复算（在服务器上跑）：
//   sqlite3 /opt/miaoimg/.oip/runtime-data/management.sqlite \
//     "SELECT model, (julianday(finished_at)-julianday(started_at))*86400 s FROM generations
//      WHERE status='succeeded' AND finished_at IS NOT NULL ORDER BY model, s;"
const TYPICAL_SECONDS: Record<string, number> = {
  // 图片：seedream-flash 8 条中位数 22.8s，gpt-image-2 5 条中位数 25.9s，
  // seedream-5-pro / sunburst / seedream-4-0 各只有 1 条实测（96.8s / 52.8s / 11.8s）。
  "doubao-seedream-5-0-flash": 23,
  "doubao-seedream-5-0-pro": 97,
  "doubao-seedream-4-0": 12,
  "gpt-image-2": 26,
  "gpt-image-2.5-sunburst": 53,
  // 视频：MiniMax-H3 8 条中位数 39.0s，seedance mini / fast 各 1 条（102.7s / 145.9s）。
  "MiniMax-H3": 39,
  "seedance-2.0-mini": 103,
  "seedance-2.0-fast": 146,
};
// 没有实测样本的模型用这个兜底；取得比上面大多数样本略大，宁可走得慢也不提前顶到 CAP。
const DEFAULT_SECONDS: Record<ProgressKind, number> = { image: 30, video: 90 };

export function typicalSeconds(modelId: string, kind: ProgressKind): number {
  const id = String(modelId || "").trim();
  // 目录里的 id 可能带版本后缀（内部出现过 doubao-seedream-5-0-pro-260628 这种），
  // 先精确匹配，再退回最长前缀匹配。
  const exact = TYPICAL_SECONDS[id];
  if (exact) return exact;
  const match = Object.keys(TYPICAL_SECONDS)
    .filter((key) => id.startsWith(key))
    .sort((left, right) => right.length - left.length)[0];
  return match ? TYPICAL_SECONDS[match]! : DEFAULT_SECONDS[kind];
}

// 无真值通道的估算值，0 → ESTIMATE_CAP 单调递增。
export function estimatedPercent(input: Pick<ProgressInput, "elapsedSeconds" | "modelId" | "kind">): number {
  const typical = Math.max(1, typicalSeconds(input.modelId, input.kind));
  const ratio = Math.max(0, input.elapsedSeconds) / typical;
  return Math.min(ESTIMATE_CAP, Math.round(ESTIMATE_CAP * (1 - Math.exp(-ESTIMATE_RATE * ratio))));
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * 把「阶段 + 真值 + 已生成时长」合成一个可以直接画的百分比。
 *
 * 合并规则在核心内完成，消费者不要自己再 max 一遍：`percent = max(真值峰值, 估算)`。
 * 为什么必须合并：真值可能比估算低（估算已经 70%、上游第一次才报 42%），直接切真值会让
 * 数字倒退；两边各自 max 又会写出两份逻辑。
 * `estimated` 描述的是**当前显示的这个数**的来源：估算领先时为 true（界面显示 ≈70%），
 * 真值追上来之后才变 false。
 */
export function progressView(input: ProgressInput): ProgressView {
  const real = input.realPeak ?? input.realPercent ?? null;
  const realPeak = real === null ? null : clampPercent(real);
  const estimate = estimatedPercent(input);
  const merged = Math.max(realPeak ?? 0, estimate);
  const estimated = estimate > (realPeak ?? 0);

  switch (input.phase) {
    case "submitting":
    case "confirming":
      return { percent: 0, estimated: false, showPercent: false };
    case "queued":
      // 排队有数字 0%，但没有真值也没有估算依据，不算「估算」。
      return { percent: 0, estimated: false, showPercent: true };
    case "running":
      return { percent: clampPercent(merged), estimated, showPercent: true };
    case "saving":
      // 有真值的通道继续用真值（别把上游的 72% 忽然说成 95%）；只有估算通道才需要占位。
      return realPeak === null
        ? { percent: clampPercent(Math.max(SAVING_PERCENT, estimate)), estimated: true, showPercent: true }
        : { percent: clampPercent(merged), estimated, showPercent: true };
    case "succeeded":
      return { percent: 100, estimated: false, showPercent: true };
    case "failed":
      // 失败/取消不表达完成比例：环不填数、中心不显示数字、无障碍只读状态词。
      return { percent: 0, estimated: false, showPercent: false };
    case "cancelled":
      return { percent: 0, estimated: false, showPercent: false };
    default:
      return { percent: 0, estimated: false, showPercent: false };
  }
}

/**
 * 会自己记住真值峰值的包装：轮询类消费者用它，就不用各自写 Math.max。
 * 一轮生成开始（或结束）时调用 reset()。
 */
export function createProgressTracker() {
  let realPeak: number | null = null;
  return {
    reset() { realPeak = null; },
    view(input: Omit<ProgressInput, "realPeak">): ProgressView {
      if (input.realPercent !== null && input.realPercent !== undefined) {
        const value = clampPercent(input.realPercent);
        realPeak = Math.max(realPeak ?? 0, value);
      }
      return progressView({ ...input, realPeak });
    },
    peek(): number | null { return realPeak; },
  };
}
