import { computed, ref, type Ref } from "vue";
import { translate } from "@miaoimg/i18n/vue";
import { nodeTools, z } from "./nodeTools";
import type { NodeOutputs } from "./values";

export type NodeGenerationOutcome = "idle" | "running" | "pending" | "succeeded" | "failed";

export function useNodeGeneration(outputs: Readonly<Ref<NodeOutputs>>, cancel: () => void, projectOutputs?: (value: NodeOutputs) => unknown, progress?: () => { phase: string; message: string; requestId?: string }, initial?: () => { status: NodeGenerationOutcome; phase?: string; message?: string; requestId?: string } | undefined) {
  const status = ref<NodeGenerationOutcome>("idle");
  const error = ref("");
  const pendingRequestId = ref<string>();
  // Paid media cancellation is confirmed by its receipt; stopping observation
  // without that confirmation retains a resumable pending task.
  const cancelled = ref(false);
  const generating = computed(() => status.value === "running");
  const getStatus = () => { const restored = status.value === "idle" ? initial?.() : undefined; if (restored) return { ...restored, outputs: projectOutputs ? projectOutputs(outputs.value) : outputs.value }; return ({ status: status.value, outputs: projectOutputs ? projectOutputs(outputs.value) : outputs.value, ...(generating.value || status.value === "pending" ? progress?.() : {}), ...(status.value === "pending" && pendingRequestId.value ? { requestId: pendingRequestId.value } : {}), ...(cancelled.value ? { cancelled: true } : {}), ...(error.value ? { error: error.value } : {}) }); };

  nodeTools.register({
    name: "getGenerationStatus",
    description: "查询本次打开节点后的生成状态（idle/running/pending/succeeded/failed）、当前输出和最近一次错误。图片/视频另有 phase、message、requestId；saving 表示已生成、正在保存，pending 表示原任务尚未确认或结果尚未取回，调用原节点生成工具只会继续取回原任务，不要新建节点重新生成。cancelled=true 才表示已确认取消或提交前已停止。当前输出可能来自之前的生成；idle 不表示没有历史输出，只有 succeeded 表示本次生成成功",
    parameters: z.strictObject({}),
    execute: getStatus,
  });
  nodeTools.register({
    name: "cancelGeneration",
    description: "请求停止当前后台生成；cancellationRequested 表示已发出停止请求，随后用 getGenerationStatus 查询终止状态。不会删除已有输出，不能保证生成服务撤销任务或费用",
    parameters: z.strictObject({}),
    execute() {
      const cancellationRequested = generating.value;
      if (cancellationRequested) cancel();
      return { ...getStatus(), cancellationRequested };
    },
  });

  async function run<T>(task: () => Promise<T>): Promise<T> {
    if (generating.value) throw new Error("节点正在生成，请等待完成");
    status.value = "running";
    error.value = "";
    pendingRequestId.value = undefined;
    cancelled.value = false;
    try {
      const result = await task();
      status.value = "succeeded";
      return result;
    } catch (failure) {
      const message = (failure as { response?: { data?: { message?: string } } })?.response?.data?.message;
      const aborted = failure instanceof Error && failure.name === "AbortError";
      const explicitlyPending = (failure as { generationPending?: boolean })?.generationPending === true;
      const confirmed = (failure as { generationCancelled?: boolean })?.generationCancelled === true;
      // The node retains this ID until a terminal receipt or applied result.
      // A lost response or detached observer must report the same pending task.
      const retainedRequestId = progress?.().requestId;
      const pending = !confirmed && (explicitlyPending || !!retainedRequestId);
      if (pending) pendingRequestId.value = retainedRequestId || (failure as { requestId?: string })?.requestId;
      // 先写 error 再翻 status：订阅 outcome 的进度条在回调里就能一次读到最终文案。
      error.value = pending && !explicitlyPending
        ? translate("原任务尚未确认，请继续取回，不会重新生成。")
        : aborted && !pending && !confirmed ? translate("生成已取消") : message || (failure instanceof Error ? failure.message : translate("生成失败"));
      cancelled.value = aborted && !pending;
      status.value = pending ? "pending" : "failed";
      throw failure;
    }
  }

  return { generating, outcome: status, error, cancelled, run };
}
