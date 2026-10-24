import { computed, onScopeDispose, reactive, ref, watch, type Ref } from "vue";
import { translate } from "@miaoimg/i18n/vue";
import { createProgressTracker, isLocalPlatformWaiting, progressView, type ProgressKind, type ProgressPhase } from "@/studio/generationProgressCore";
import type { NodeGenerationOutcome } from "./useNodeGeneration";

// 画布节点这一侧的进度：只管生命周期（时钟、阶段机、文案、什么时候收起），
// **所有百分比计算都在 @/studio/generationProgressCore**，和历史面板（React 外壳）共用一份。
export type { ProgressPhase } from "@/studio/generationProgressCore";

// 完成/失败/取消的环留一会儿，让用户看见状态变化，然后自动收起。
const LINGER_MS = { succeeded: 2600, cancelled: 2600, failed: 8000 } as const;

export type GenerationProgressOptions = {
  // 本轮生成是否在跑（useNodeGeneration 的 generating）。
  generating: Ref<boolean>;
  // 本轮生成的终态，用来区分「完成 / 失败 / 已取消」。
  outcome: Ref<NodeGenerationOutcome>;
  cancelled: Ref<boolean>;
  error: Ref<string>;
  // onStatus 回传的上游状态：queued / running / saving / succeeded …
  status: Ref<string>;
  statusMessage?: Ref<string>;
  // 上游真报的百分比；没有真值的通道一直传 null。
  realPercent?: Ref<number | null>;
  modelId: () => string;
  kind: ProgressKind;
  // 视频请求的片长（秒）；「自动」或未知时返回 null。视频耗时随片长增长，估算要用它。
  durationSeconds?: () => number | null | undefined;
};

export function useGenerationProgress(options: GenerationProgressOptions) {
  const startedAt = ref(0);
  const now = ref(Date.now());
  // 结束后要显示的终态；null 表示没有要显示的结果。
  const settled = ref<"succeeded" | "failed" | "cancelled" | "pending" | null>(null);
  let clockTimer: number | undefined;
  let lingerTimer: number | undefined;

  // 估算分母是「真正在生成」的时长，不含排队：典型耗时来自生产库的 started_at → finished_at。
  // elapsedSeconds 是用户真正等的时间（含排队），界面上显示的就是它。
  const activeSince = ref(0);
  const elapsedSeconds = computed(() => (startedAt.value ? Math.max(0, Math.floor((now.value - startedAt.value) / 1000)) : 0));
  const activeSeconds = computed(() => (activeSince.value ? Math.max(0, (now.value - activeSince.value) / 1000) : 0));
  const localWaiting = computed(() => isLocalPlatformWaiting(options.modelId(), options.status.value, options.statusMessage?.value));

  // 核心那侧负责记住真值峰值 —— 这里不要自己再 max 一遍。
  const tracker = createProgressTracker();

  // 服务端从 queued 翻到 running 的那一刻才开始计估算时间。
  watch([() => options.status.value, localWaiting], ([value, waiting]) => {
    if (!options.generating.value) return;
    if (waiting || ["queued", "submitting", "confirming"].includes(value)) { activeSince.value = 0; return; }
    if (!activeSince.value) activeSince.value = Date.now();
  }, { immediate: true, flush: "sync" });

  watch(options.generating, (value) => {
    if (lingerTimer) { window.clearTimeout(lingerTimer); lingerTimer = undefined; }
    if (value) {
      startedAt.value = Date.now();
      now.value = Date.now();
      settled.value = null;
      tracker.reset();
      activeSince.value = localWaiting.value || ["queued", "submitting", "confirming"].includes(options.status.value) ? 0 : Date.now();
      if (!clockTimer) clockTimer = window.setInterval(() => { now.value = Date.now(); }, 1000);
      return;
    }
    if (clockTimer) { window.clearInterval(clockTimer); clockTimer = undefined; }
    // 「取消」和「真失败」在 useNodeGeneration 里都是 failed，靠 cancelled 标记区分，
    // 别让用户点停止后看到一条红色的失败态。
    const finished = options.outcome.value === "pending" ? "pending" : options.outcome.value === "succeeded" ? "succeeded" : options.cancelled.value ? "cancelled" : "failed";
    settled.value = finished;
    if (finished === "pending") return;
    lingerTimer = window.setTimeout(() => { settled.value = null; lingerTimer = undefined; }, LINGER_MS[finished]);
  }, { flush: "sync" });

  onScopeDispose(() => {
    if (clockTimer) window.clearInterval(clockTimer);
    if (lingerTimer) window.clearTimeout(lingerTimer);
  });

  const phase = computed<ProgressPhase>(() => {
    if (!options.generating.value) return settled.value ?? "idle";
    if (localWaiting.value) return "confirming";
    if (options.status.value === "submitting" || options.status.value === "confirming") return options.status.value;
    if (options.status.value === "queued") return "queued";
    if (options.status.value === "saving") return "saving";
    return "running";
  });

  // 用 watcher 而不是 computed 驱动核心：tracker 要记住真值峰值，那是状态，不该写在 computed 里。
  const view = ref(progressView({ phase: "idle", realPercent: null, elapsedSeconds: 0, modelId: "", kind: options.kind }));
  watch([phase, activeSeconds, () => options.realPercent?.value ?? null], () => {
    view.value = tracker.view({
      phase: phase.value,
      realPercent: options.realPercent?.value ?? null,
      elapsedSeconds: activeSeconds.value,
      modelId: options.modelId(),
      kind: options.kind,
      durationSeconds: options.durationSeconds?.() ?? null,
    });
  }, { immediate: true, flush: "sync" });

  const shownPercent = computed(() => view.value.percent);
  const estimated = computed(() => view.value.estimated);
  const showPercent = computed(() => view.value.showPercent);

  const label = computed(() => {
    switch (phase.value) {
      case "submitting": return translate("正在提交…");
      case "confirming": return translate(localWaiting.value ? "等待平台处理" : "提交结果待确认");
      case "queued": return translate("排队等待中");
      case "saving": return translate(options.statusMessage?.value ? "保存暂未完成" : "正在保存…");
      case "pending": return translate("已停止等待");
      case "succeeded": return translate("完成");
      case "cancelled": return translate("已取消");
      case "failed": return options.kind === "image" ? translate("图片生成失败") : translate("视频生成失败");
      default: return translate("正在生成");
    }
  });
  // 生成中沿用节点原来那行文案：状态 · 已等待 N 秒 · 取消提示。
  const detail = computed(() => (options.generating.value ? translate("已等待 {0} 秒", { 0: elapsedSeconds.value }) : ""));
  const hint = computed(() => (/^(doubao|dola)-local-/.test(options.modelId()) ? "" : phase.value === "queued" ? translate("排队中取消会退回积分")
    : phase.value === "running" || phase.value === "saving" ? translate("已发出的请求取消不退积分")
      : ""));
  const message = computed(() => localWaiting.value || phase.value === "saving" ? translate(options.statusMessage?.value || "") : ["failed", "pending", "cancelled"].includes(phase.value) ? options.error.value : "");
  const visible = computed(() => phase.value !== "idle");

  // 返回 reactive 而不是普通对象：模板里 `progress.percent` 才会自动解包。
  return reactive({
    visible, phase, percent: shownPercent, estimated, showPercent, label, detail, hint, message, elapsedSeconds,
    text: computed(() => [label.value, showPercent.value ? `${estimated.value ? "≈" : ""}${shownPercent.value}%` : "", detail.value, message.value, hint.value]
      .filter(Boolean).join(" · ")),
  });
}

// 供不认识 generationProgressCore 的调用方（比如只想要一个数）直接取纯函数。
export { progressView };
