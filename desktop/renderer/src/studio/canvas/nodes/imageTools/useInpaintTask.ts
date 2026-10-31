import { computed, onScopeDispose, ref, type Ref } from "vue";
import { translate } from "@miaoimg/i18n/vue";
import { pendingMediaTaskError, type NodeImageRequest, type NodeInpaintInput, type useNodeAi } from "../../scaffold/nodeAi";
import type { NodeOutputs } from "../../scaffold/values";
import { useNodeGeneration } from "../../scaffold/useNodeGeneration";
import { useGenerationProgress } from "../../scaffold/generationProgress";
import type { useMediaTaskDelivery } from "../../scaffold/useMediaTaskDelivery";

export function useInpaintTask(options: {
  nodeId: string;
  data: Readonly<Ref<{ taskRequestId?: string }>>;
  outputs: Readonly<Ref<NodeOutputs>>;
  ai: ReturnType<typeof useNodeAi>;
  delivery: ReturnType<typeof useMediaTaskDelivery>;
  prepare: (input: NodeInpaintInput, signal: AbortSignal) => Promise<NodeImageRequest>;
  applied: () => void;
}) {
  const status = ref("");
  const message = ref("");
  const upstreamPercent = ref<number | null>(null);
  const modelId = ref("");
  let disposed = false;
  let controller: AbortController | undefined;
  let work: Promise<void> | undefined;
  type LocalStart = { status: "generating" | "recovering" | "ready"; requestId?: string };
  let startup: (ReturnType<typeof Promise.withResolvers<LocalStart>> & { entered: boolean }) | undefined;
  let lastRequestId = options.data.value.taskRequestId;
  const stop = () => controller?.abort();
  const state = useNodeGeneration(options.outputs, stop, undefined, () => ({
    phase: status.value, message: message.value, requestId: options.data.value.taskRequestId,
  }));
  const pending = computed(() => !!options.data.value.taskRequestId || state.outcome.value === "pending");
  const progress = useGenerationProgress({
    generating: state.generating, outcome: state.outcome, cancelled: state.cancelled,
    error: state.error, status, statusMessage: message, realPercent: upstreamPercent, modelId: () => modelId.value, kind: "image",
  });
  onScopeDispose(() => { disposed = true; stop(); });

  function run(input?: NodeInpaintInput, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (disposed || state.generating.value) throw new Error(translate("图片处理中，请稍后重试"));
    const resuming = pending.value;
    if (!resuming && !input) throw new Error(translate("请先配置模型、提示词和选区"));
    const current = controller = new AbortController();
    const launching = startup;
    if (launching) launching.entered = true;
    const abort = () => current.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    let handedOff = false;
    function started(status: "generating" | "recovering", requestId: string) {
      if (!launching || handedOff) return;
      current.signal.throwIfAborted();
      // Pi aborts an invocation signal even after a successful tool return.
      // From this local handoff the node owns its work; Stop and page disposal
      // still abort its controller through the original lifecycle.
      signal?.removeEventListener("abort", abort);
      handedOff = true;
      launching.resolve({ status, requestId });
    }
    status.value = resuming ? "confirming" : "submitting";
    message.value = "";
    upstreamPercent.value = null;
    if (input && !resuming) modelId.value = input.modelId;
    let receivedStatus = false;
    let observedRequestId = options.data.value.taskRequestId || lastRequestId || "";
    const callbacks = {
      outputDirectory: `assets/${options.nodeId}`,
      shouldCancel: () => !disposed,
      onTask: async (requestId: string, existing = false) => {
        observedRequestId = lastRequestId = requestId;
        if (existing) receivedStatus = true;
        await options.delivery.bind(requestId, existing, undefined, current.signal);
        if (!resuming) started("generating", requestId);
      },
      onStatus: (value: string, percent?: number | null, detail = "") => {
        if (disposed) return;
        receivedStatus = true;
        if (percent !== undefined) upstreamPercent.value = percent;
        status.value = value;
        message.value = detail;
        if (["failed", "cancelled", "expired"].includes(value)) {
          options.delivery.clear(observedRequestId);
          if (lastRequestId === observedRequestId) lastRequestId = undefined;
        }
      },
    };
    function missingOriginal() {
      callbacks.onStatus("expired");
      return Object.assign(new Error(translate("未找到可取回的原任务，可以重新配置后生成。")), { status: 410 });
    }
    async function resumeOriginal(requestId: string) {
      try { return await options.ai.resumeImage(requestId, callbacks, current.signal); }
      catch (failure) {
        if (Number((failure as { status?: number })?.status) !== 404) throw failure;
        current.signal.throwIfAborted();
        const binding = options.data.value.taskRequestId;
        if (binding && binding !== requestId) throw pendingMediaTaskError(failure, requestId);
        let found: string;
        try { found = await options.ai.findImageTask(callbacks.outputDirectory, current.signal); }
        catch (error) { throw pendingMediaTaskError(error, requestId); }
        current.signal.throwIfAborted();
        if (disposed || options.data.value.taskRequestId !== binding) throw pendingMediaTaskError(failure, requestId);
        if (!found) {
          // Only a successful scoped read can confirm that this node has no
          // recoverable task. A failed lookup must retain its original ID.
          throw missingOriginal();
        }
        if (found === requestId) throw pendingMediaTaskError(failure, requestId);
        try { await callbacks.onTask(found, true); }
        catch (error) { throw pendingMediaTaskError(error, found); }
        // Reuse the existing observer once; never repeat generation submission.
        return options.ai.resumeImage(found, callbacks, current.signal);
      }
    }
    work = state.run(async () => {
      try {
        let results;
        if (resuming) {
          let requestId = options.data.value.taskRequestId || lastRequestId;
          if (!requestId) {
            const binding = options.data.value.taskRequestId;
            try { requestId = await options.ai.findImageTask(callbacks.outputDirectory, current.signal); }
            catch (error) { throw pendingMediaTaskError(error, observedRequestId); }
            current.signal.throwIfAborted();
            if (disposed || options.data.value.taskRequestId !== binding) throw pendingMediaTaskError(new Error(translate("画布任务已变化，请重新操作")), observedRequestId);
          }
          current.signal.throwIfAborted();
          if (!requestId) throw missingOriginal();
          observedRequestId = lastRequestId = requestId;
          options.delivery.recover(requestId);
          started("recovering", requestId);
          results = await resumeOriginal(requestId);
        } else {
          const request = await options.prepare(input!, current.signal);
          current.signal.throwIfAborted();
          results = await options.ai.generateImage({ ...request, ...callbacks }, current.signal);
        }
        current.signal.throwIfAborted();
        const result = results[0];
        if (!result) throw new Error(translate("生成服务没有返回图片"));
        options.delivery.apply(observedRequestId, results);
        if (lastRequestId === observedRequestId) lastRequestId = undefined;
        options.applied();
      } catch (failure) {
        const error = failure as Error & { status?: number; activeRequestId?: string; generationCancelled?: boolean; generationPending?: boolean };
        // A complete submission rejection is different from a lost response or
        // a failed status read. The latter must retain the original paid task.
        const rejected = !resuming && !receivedStatus && !error?.activeRequestId && !error?.generationPending
          && Number(error?.status) >= 400 && Number(error?.status) < 500 && Number(error?.status) !== 408;
        const expired = resuming && !error?.generationPending && Number(error?.status) === 410;
        if (rejected || expired || error?.generationCancelled) {
          options.delivery.clear(observedRequestId);
          if (lastRequestId === observedRequestId) lastRequestId = undefined;
        }
        const requestId = options.data.value.taskRequestId;
        if (requestId || resuming && !receivedStatus && !rejected && !expired && !error?.generationCancelled) {
          throw Object.assign(new Error(error?.generationPending ? error.message : translate("原任务尚未确认，请继续取回，不会重新生成。"), { cause: failure }), {
            name: error?.name || "Error", generationPending: true, requestId,
          });
        }
        throw failure;
      }
    }).finally(() => {
      signal?.removeEventListener("abort", abort);
      if (controller === current) controller = undefined;
    });
    return work;
  }

  function start(operation: () => Promise<void>): Promise<LocalStart> {
    if (disposed || state.generating.value || startup) throw new Error(translate("图片处理中，请稍后重试"));
    const launching = Object.assign(Promise.withResolvers<LocalStart>(), { entered: false });
    startup = launching;
    let completion: Promise<void>;
    try { completion = operation(); }
    catch (error) { startup = undefined; launching.reject(error); return launching.promise; }
    // Observe the complete UI operation even after the local start is returned.
    // Its eventual failure is already recorded by useNodeGeneration; it must
    // neither reject an acknowledged start nor become an unhandled rejection.
    void completion.then(() => {
      if (launching.entered) launching.resolve({ status: "ready" });
      else launching.reject(new Error(translate("生成任务尚未启动")));
    }, error => launching.reject(error)).finally(() => { if (startup === launching) startup = undefined; });
    return launching.promise;
  }

  return { generating: state.generating, pending, progress, run, start, stop, wait: () => work?.catch(() => {}) };
}
