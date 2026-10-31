// 生成进度的**框架无关**计算核心：画布节点（Vue）和历史面板（React 外壳）共用这一份，
// 谁也不许再写第二份估算。这里只有纯计算 + 一个可选的峰值跟踪器，没有 Vue / React 依赖。
//
// 三条信号来源，质量不同，界面必须区别对待：
// 1. 上游真报了百分比 —— 直接用真值（视频方舟通道 server/ark-video.ts 的 progressValue()，
//    由 server/video-api.ts 的 pollVideo() 放进响应体回给浏览器；本地 ffmpeg 的 -progress 同理）。
// 2. 上游不报百分比 —— 图片生成就是这一类（server/image_api.ts 的生成记录里没有 progress 字段），
//    只能按「阶段 + 已生成时长 / 该模型典型耗时」估算推进，封顶 ESTIMATE_CAP，成功才到 100。
//    估算值照样显示数字（产品要求 0~100 一路可见），但用 ≈ 前缀和真值区分。
// 3. 排队显示 0%；保存显示带 ≈ 的阶段估算，完整写回才显示 100%。

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
  // 视频请求的片长（秒）；视频耗时随片长增长，估算要用它。「自动」或未知时不传。
  durationSeconds?: number | null;
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
// 上游已完成、本机仍在保存：保留数字反馈，明确这是阶段估算，不是下载字节比例。
const SAVING_PERCENT = 95;

// 每个模型的典型耗时，估算分母。两个消费者必须用同一个分母，所以和计算放在一起。
// 视频的耗时随片长增长，所以写成「固定部分 + 每输出一秒要多少秒」；图片只有固定部分。
//
// 数据来源：生产库 generations 表里成功记录的 started_at → finished_at（不含排队），
// 2026-10-23 采样。服务器上复算：
//   sqlite3 -readonly /opt/miaoimg/.oip/runtime-data/management.sqlite \
//     "SELECT model, json_extract(parameters,'$.duration'), json_extract(parameters,'$.resolution'),
//             (julianday(finished_at)-julianday(started_at))*86400
//      FROM generations WHERE status='succeeded' AND started_at IS NOT NULL ORDER BY model;"
// 样本：gpt-image-2 113 条均值 29.9s；Grok Video 1.5 34 条（6s≈33、8s≈40、10s≈53、15s≈65–141）；
// MiniMax-H3 768P 15 条（4s≈24–62、12s≈85–153、15s≈87–209）；Seedance 2.0 Mini 8 条（4s 片 134–258s，
// 秘塔平台固定开销大）；Grok 经典版 8s 1 条 74s；Grok Image 2.0 2 条约 17s。
// 方舟 Seedance（2.5 / 2.0 Fast）上游会报真实百分比，估算只在真值到达前兜底。
type Timing = { base: number; perSecond?: number };
const TYPICAL: Record<string, Timing> = {
  // 图片
  "gpt-image-2": { base: 30 },
  "gpt-image-2.5-sunburst": { base: 53 },
  "doubao-seedream-5-0-flash": { base: 25 },
  "doubao-seedream-5-0-pro": { base: 97 },
  "doubao-seedream-4-0": { base: 12 },
  "grok-imagine-image": { base: 17 },
  // 视频
  "grok-imagine-video-1.5": { base: 0, perSecond: 5.5 },
  "grok-imagine-video": { base: 0, perSecond: 9 },
  "MiniMax-H3": { base: 10, perSecond: 8 },
  "seedance-2.0-mini": { base: 120, perSecond: 17 },
  // 秘塔 Seedance 2.0 标准版暂无样本：同一平台，先按 Mini 的量级。
  "seedance-2.0": { base: 120, perSecond: 17 },
};
// 没有实测样本的模型用这个兜底；取得偏大，宁可走得慢也不提前顶到 CAP。
const DEFAULT_TIMING: Record<ProgressKind, Timing> = { image: { base: 30 }, video: { base: 30, perSecond: 10 } };
// 片长没给或是「自动」时按 10 秒估。
const DEFAULT_VIDEO_SECONDS = 10;

// 目录里的 ID 带平台前缀和日期后缀（doubao-seedance-2-0-fast-260128、doubao-seedream-5-0-pro-260628），
// 先精确匹配，再按最长前缀匹配，最后把方舟写法归一（2-0 → 2.0，去掉 doubao- 和日期）再找一次。
function timingFor(modelId: string, kind: ProgressKind): Timing {
  const id = String(modelId || "").trim();
  const lookup = (value: string) => TYPICAL[value] ?? TYPICAL[Object.keys(TYPICAL)
    .filter((key) => value.startsWith(key))
    .sort((left, right) => right.length - left.length)[0] ?? ""];
  const normalized = id.replace(/^doubao-/, "").replace(/-\d{6}$/, "").replace(/(\d)-(\d)/g, "$1.$2");
  return lookup(id) ?? lookup(normalized) ?? DEFAULT_TIMING[kind];
}

export function typicalSeconds(modelId: string, kind: ProgressKind, durationSeconds?: number | null): number {
  const timing = timingFor(modelId, kind);
  if (kind !== "video" || !timing.perSecond) return timing.base;
  const seconds = Number(durationSeconds) > 0 ? Number(durationSeconds) : DEFAULT_VIDEO_SECONDS;
  return timing.base + timing.perSecond * seconds;
}

// 无真值通道的估算值，0 → ESTIMATE_CAP 单调递增。
export function estimatedPercent(input: Pick<ProgressInput, "elapsedSeconds" | "modelId" | "kind" | "durationSeconds">): number {
  const typical = Math.max(1, typicalSeconds(input.modelId, input.kind, input.durationSeconds));
  const ratio = (Number.isFinite(input.elapsedSeconds) ? Math.max(0, input.elapsedSeconds) : 0) / typical;
  return Math.min(ESTIMATE_CAP, Math.round(ESTIMATE_CAP * (1 - Math.exp(-ESTIMATE_RATE * ratio))));
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function measuredPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? clampPercent(value) : null;
}

/**
 * 把「阶段 + 真值 + 已生成时长」合成一个可以直接画的百分比。
 *
 * 真值优先，不能用时间估算把平台真实进度顶高。首次收到真值会校正之前的估算，
 * 之后保留真值峰值，缺报或旧轮询不能让时间估算重新接管。
 * 100% 只属于完整成功：平台报满但本机还没写回时最多显示 99%。
 * 保存阶段没有文件字节进度，用带 ≈ 的阶段估算保留数字反馈。
 */
export function progressView(input: ProgressInput): ProgressView {
  const values = [measuredPercent(input.realPeak), measuredPercent(input.realPercent)].filter((value): value is number => value !== null);
  const real = values.length ? Math.max(...values) : null;

  switch (input.phase) {
    case "submitting":
    case "confirming":
    case "queued":
      return { percent: 0, estimated: false, showPercent: true };
    case "saving":
      return { percent: Math.min(99, Math.max(SAVING_PERCENT, real ?? 0)), estimated: true, showPercent: true };
    case "running":
      return { percent: real === null ? estimatedPercent(input) : Math.min(99, real), estimated: real === null, showPercent: true };
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
      const value = measuredPercent(input.realPercent);
      if (value !== null && input.phase === "running") {
        realPeak = Math.max(realPeak ?? 0, value);
      }
      return progressView({ ...input, realPeak });
    },
    peek(): number | null { return realPeak; },
  };
}
