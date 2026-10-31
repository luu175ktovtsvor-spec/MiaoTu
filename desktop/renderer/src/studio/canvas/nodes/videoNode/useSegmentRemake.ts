import { computed, inject, onScopeDispose, ref, watch, type Ref } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { ElMessageBox } from "element-plus";
import { translate } from "@miaoimg/i18n/vue";
import { useNodeFiles } from "../../scaffold/workspaceFiles";
import { useNodeFfmpeg } from "../../scaffold/nodeFfmpeg";
import type { useNodeAi, NodeCreditEstimate, NodeVideoRequest, NodeMediaModel } from "../../scaffold/nodeAi";
import { captureWorkspaceScope, assertWorkspaceScope } from "@/lib/workspaceRemote";
import { normalizeSegmentRanges, segmentInstructions, segmentRemakeAdmission, segmentRemakeCharge, type SegmentRemakeData, type SegmentRemakePart, type SegmentRemakeRun } from "./segmentRemake";
import { mergeRemakeClips, prepareRemakeClip } from "./segmentRemakeProcessing";
import { videoEditDefaults, videoEditEligibility } from "./videoEditIntentContract";

type FrozenRun = SegmentRemakeRun & { referenceHistory?: NodeVideoRequest["referenceHistory"]; configurationKey?: string; paidInputKey?: string; assetRevisions?: Record<string, string>; referenceFingerprint?: string; draftSourcePath?: string };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const pendingError = (requestId?: string) => Object.assign(new Error(translate("原任务尚未确认，请继续取回，不会重新生成。")), { generationPending: true, ...(requestId ? { requestId } : {}) });

export function useSegmentRemake(options: { node: GraphNode; ai: ReturnType<typeof useNodeAi>; model: () => NodeMediaModel | undefined; request: () => NodeVideoRequest; busy: Ref<boolean>; applyResult?: (file: { url: string; mimeType: string }) => void; autoEstimate?: () => boolean; onError: (error: unknown) => void }) {
  const flow = useVueFlow(), files = useNodeFiles(), ffmpeg = useNodeFfmpeg();
  const persist = inject<(() => Promise<void>) | undefined>("persistCanvasTaskBinding", undefined);
  const canvasSignal = inject<(() => AbortSignal) | undefined>("canvasOperationSignal", undefined);
  const active = inject<Ref<boolean> | undefined>("canvasUiActive", undefined);
  const data = () => options.node.data as SegmentRemakeData;
  const currentRun = () => data().segmentRemakeRun as FrozenRun | undefined;
  const quote = ref<NodeCreditEstimate | null>(null), error = ref(""), quoting = ref(false), status = ref("");
  const currentTime = ref(0), starting = ref(false);
  let disposed = false, sequence = 0, timer: ReturnType<typeof setTimeout> | undefined, quoteController: AbortController | undefined, controller: AbortController | undefined;
  let activeWork: Promise<unknown> | undefined, startFlight: Promise<void> | undefined, explicitStop = false;
  const admitting = ref(false);
  // True only while the point dialog is open. Refresh must not see this as locked,
  // or the first quote would skip preparing the run.
  const confirming = ref(false);
  // The quote decision admit() already showed or skipped. start() must not turn a
  // resume into a newly charged submission if a later refresh gains a quote.
  let admittedGate: { token: string; fingerprint: string; resumeOnly: boolean; points?: number } | undefined;
  let preparationTail: Promise<unknown> = Promise.resolve();
  const enabled = computed(() => Boolean(data().segmentRemakeDraft));
  const pending = computed(() => Boolean(currentRun()?.parts.some(part => part.taskRequestId && !part.output)));
  const locked = computed(() => confirming.value || options.busy.value || Boolean(currentRun() && currentRun()!.phase !== "complete" && currentRun()!.parts.some(part => part.taskRequestId || part.output)));
  const key = computed(() => enabled.value ? JSON.stringify([data().segmentRemakeDraft, options.request(), data().segmentRemakeAudio || "original"]) : "");
  const autoVisible = () => active?.value !== false && (options.autoEstimate?.() ?? options.node.selected);
  let quotedKey = "", quotedRunKey = "";
  const unsent = (run: FrozenRun) => run.parts.filter(part => !part.output && !part.taskRequestId);
  const configurationKey = (run: FrozenRun) => {
    const paths = [run.source.file.url, ...run.parts.map(part => part.input.url), ...run.references.images.map(file => file.url), ...run.references.audios.map(file => file.url)];
    return JSON.stringify([run.id, run.source, paths.map(path => [path, run.assetRevisions?.[path]]), run.model, run.ratio, run.resolution, run.parameters, run.audio, run.generateAudio, run.references, run.referenceHistory,
      run.parts.map(({ id, start, end, input, prompt }) => ({ id, start, end, input, prompt }))]);
  };
  const runKey = (run: FrozenRun) => JSON.stringify([configurationKey(run), unsent(run).map(part => part.id)]);
  const paidInputKey = (configuration: string | undefined) => {
    try { const values = JSON.parse(configuration || ""); return Array.isArray(values) && values.length === 3 ? JSON.stringify(values.slice(0, 2)) : undefined; }
    catch { return undefined; }
  };
  function archiveResult(run: FrozenRun) {
    const history = Array.isArray(options.node.data.segmentRemakeHistory) ? options.node.data.segmentRemakeHistory : [];
    if (!history.some(item => item?.id === run.id && item.result?.url === run.result?.url)) options.node.data.segmentRemakeHistory = [...history, copy(run)];
  }

  function assertLive(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (disposed || active?.value === false || flow.findNode(options.node.id) !== options.node) throw new Error(translate("画布节点已变化，请重新操作"));
  }
  async function save(signal?: AbortSignal) { assertLive(signal); if (!persist) throw new Error(translate("画布尚未就绪，无法保存生成任务")); await persist(); assertLive(signal); }
  async function assertOriginal(signal: AbortSignal) {
    const draft = data().segmentRemakeDraft!, source = flow.findNode(draft.source.nodeId);
    if (!source || source.data.outputs?.[draft.source.handle]?.value?.url !== draft.source.file.url
      || !flow.getEdges.value.some(edge => edge.source === source.id && edge.target === options.node.id && edge.sourceHandle === draft.source.handle)) throw new Error(translate("原视频已变化，请重新准备片段重拍节点"));
    const workspace = files.getWorkspaceFiles();
    if (!workspace.stat || (await workspace.stat(draft.source.file.url, signal)).revision !== draft.source.revision) throw new Error(translate("原视频已变化，请重新准备片段重拍节点"));
    assertLive(signal);
  }
  async function assertAssets(run: FrozenRun, signal: AbortSignal, paths?: string[]) {
    const workspace = files.getWorkspaceFiles();
    const expected = { ...run.assetRevisions, [run.source.file.url]: run.source.revision };
    for (const path of paths || [run.source.file.url, ...run.parts.map(part => part.input.url), ...run.references.images.map(file => file.url), ...run.references.audios.map(file => file.url)]) {
      const stat = await workspace.stat?.(path, signal); assertLive(signal);
      if (!expected[path] || stat?.revision !== expected[path]) throw new Error(translate("素材已变化，请重新选择后操作"));
    }
  }
  function directory(run: SegmentRemakeRun, part: SegmentRemakePart) { return `assets/${options.node.id}/segment-remake/${run.id}/${part.id}`; }
  function request(run: FrozenRun, part: SegmentRemakePart, workspace: string): NodeVideoRequest {
    const [providerId, modelId] = JSON.parse(run.model), model = options.model();
    if (!model || model.modelId !== modelId || model.providerId !== providerId) throw new Error(translate("当前模型不支持视频编辑"));
    const defaults = videoEditDefaults(model, part.end - part.start);
    return { directory: workspace, providerId, modelId, prompt: part.prompt, mode: "edit", duration: defaults.duration, ratio: run.ratio, resolution: run.resolution,
      generateAudio: run.generateAudio, referenceHistory: run.referenceHistory, ...run.parameters, videos: [{ path: part.input.url, mimeType: part.input.mimeType }],
      images: run.references.images.map(file => ({ path: file.url, mimeType: file.mimeType })), audios: run.references.audios.map(file => ({ path: file.url, mimeType: file.mimeType })), outputDirectory: directory(run, part) };
  }
  async function prepare(signal: AbortSignal) {
    const draft = copy(data().segmentRemakeDraft!), ranges = normalizeSegmentRanges(draft.ranges, draft.source.duration), model = options.model(), input = options.request();
    if (!model || model.modelId !== "seedance-2.5" || !model.mode?.includes("edit")) throw new Error(translate("当前模型不支持片段重拍"));
    if (locked.value) return currentRun()!;
    await assertOriginal(signal);
    const instructions = segmentInstructions(input.prompt, ranges), workspace = files.getWorkspaceFiles(), old = currentRun();
    const sameClips = old?.phase === "ready" && old.assetRevisions && old.draftSourcePath === draft.source.file.url
      && old.source.nodeId === draft.source.nodeId && old.source.handle === draft.source.handle && old.draftSourceRevision === draft.source.revision
      && JSON.stringify(old.parts.map(({ id, start, end }) => ({ id, start, end }))) === JSON.stringify(ranges);
    const run: FrozenRun = sameClips ? copy(old!) : { id: crypto.randomUUID(), source: copy(draft.source), draftSourceRevision: draft.source.revision, draftSourcePath: draft.source.file.url, assetRevisions: {}, parts: [], phase: "ready", model: "", ratio: "", resolution: "", parameters: {}, audio: "original", generateAudio: true, references: { images: [], audios: [] } };
    const root = `assets/${options.node.id}/segment-remake/${run.id}`, newFiles: string[] = [];
    let published = false;
    try {
      if (!sameClips) {
        await workspace.mkdir(root, signal);
        const originalPath = `${root}/original${draft.source.file.url.match(/\.[a-zA-Z0-9]+$/)?.[0] || ".mp4"}`;
        if (!workspace.copy || !await workspace.copy(draft.source.file.url, originalPath, signal, { revision: draft.source.revision })) throw new Error(translate("当前服务尚不支持保留节点原件，请更新后重试"));
        const metadata = await workspace.stat!(originalPath, signal);
        run.source = { ...copy(draft.source), file: { ...draft.source.file, url: originalPath }, revision: metadata.revision };
        run.assetRevisions![originalPath] = metadata.revision;
        const factory = await ffmpeg(signal);
        for (const range of ranges) {
          const output = `${root}/${range.id}/input.mp4`; await workspace.mkdir(`${root}/${range.id}`, signal);
          const clip = await prepareRemakeClip(factory, originalPath, range, output, signal); assertLive(signal);
          const probe = await workspace.stat!(output, signal);
          const invalid = videoEditEligibility(model, { source: { kind: "video", duration: clip.duration, sizeBytes: probe.size, width: clip.width, height: clip.height, fps: clip.fps, format: "mp4", codec: "h264", mimeType: "video/mp4" }, images: [], audios: [] });
          if (invalid) throw new Error(translate(invalid.key, invalid.params));
          run.assetRevisions![output] = probe.revision;
          run.parts.push({ ...range, input: { url: output, mimeType: "video/mp4" }, prompt: "", state: "ready" });
        }
      } else await assertAssets(run, signal, [run.source.file.url, ...run.parts.map(part => part.input.url)]);
      const origins = { images: copy(input.images || []), audios: copy(input.audios || []) };
      const observed = new Map<string, string>();
      for (const file of [...origins.images, ...origins.audios]) {
        const stat = await workspace.stat?.(file.path, signal); assertLive(signal);
        if (!stat?.revision) throw new Error(translate("素材已变化，请重新选择后操作"));
        observed.set(file.path, stat.revision);
      }
      const fingerprint = JSON.stringify([origins, [...observed]]);
      if (run.referenceFingerprint !== fingerprint) {
        const retained = new Map<string, { url: string; mimeType: string }>();
        for (const file of [...origins.images, ...origins.audios]) {
          const identity = JSON.stringify([file.path, file.mimeType]); if (retained.has(identity)) continue;
          const target = `${root}/references/${crypto.randomUUID()}${file.path.match(/\.[a-zA-Z0-9]+$/)?.[0] || ""}`;
          newFiles.push(target);
          if (!workspace.copy || !await workspace.copy(file.path, target, signal, { revision: observed.get(file.path)! })) throw new Error(translate("当前服务尚不支持保留节点原件，请更新后重试"));
          const stat = await workspace.stat!(target, signal); assertLive(signal);
          run.assetRevisions![target] = stat.revision; retained.set(identity, { url: target, mimeType: file.mimeType });
        }
        const map = (file: { path: string; mimeType: string }) => retained.get(JSON.stringify([file.path, file.mimeType]))!;
        run.references = { images: origins.images.map(map), audios: origins.audios.map(map) }; run.referenceFingerprint = fingerprint;
      }
      await assertAssets(run, signal); assertLive(signal);
      run.referenceHistory = input.referenceHistory ? copy(input.referenceHistory) : undefined;
      run.model = JSON.stringify([model.providerId, model.modelId]); run.resolution = input.resolution || ""; run.ratio = input.ratio || "adaptive";
      run.parameters = Object.fromEntries(Object.entries(input).filter(([name]) => ["creativeMode", "cameraFixed", "rawPrompt", "webSearch", "returnLastFrame"].includes(name)));
      run.audio = data().segmentRemakeAudio || "original"; run.generateAudio = input.generateAudio !== false;
      run.parts.forEach((part, index) => { part.prompt = instructions[index]; });
      // Once canvas state owns these files, an interrupted save acknowledgment
      // must not delete potentially persisted originals or clips.
      run.configurationKey = key.value; run.paidInputKey = paidInputKey(run.configurationKey);
      if (old?.phase === "complete" && old.id !== run.id) archiveResult(old);
      published = true; data().segmentRemakeRun = run; await save(signal);
      if (sameClips && old) {
        const retained = new Set([...run.references.images, ...run.references.audios].map(file => file.url));
        await Promise.allSettled([...old.references.images, ...old.references.audios].filter(file => file.url.startsWith(root + "/references/") && !retained.has(file.url)).map(file => workspace.remove(file.url)));
      }
      if (old && old.id !== run.id && !old.parts.some(part => part.taskRequestId || part.output)) await workspace.remove(`assets/${options.node.id}/segment-remake/${old.id}`, true).catch(() => {});
      return currentRun()!;
    } catch (cause) {
      if (!published) {
        if (!sameClips) await workspace.remove(root, true).catch(() => {});
        else await Promise.allSettled(newFiles.map(path => workspace.remove(path)));
      }
      throw cause;
    }
  }
  function prepareExclusive(signal: AbortSignal) {
    const work = preparationTail.catch(() => {}).then(() => { assertLive(signal); return prepare(signal); });
    preparationTail = work.then(() => {}, () => {}); return work;
  }
  async function refresh(automatic = false) {
    if (timer) clearTimeout(timer); timer = undefined;
    quoteController?.abort(); const local = quoteController = new AbortController(), seq = ++sequence, token = key.value;
    quote.value = null; error.value = ""; quotedKey = quotedRunKey = "";
    if (!enabled.value || !data().segmentRemakeDraft?.ranges.length || options.busy.value || active?.value === false || automatic && !autoVisible()) { quoting.value = false; return; }
    const completed = currentRun();
    if (completed?.phase === "complete" && completed.configurationKey === token) {
      quote.value = { points: 0, breakdown: { billingSource: "segment-remake-total" } }; quotedKey = token; quotedRunKey = runKey(completed); quoting.value = false; return;
    }
    quoting.value = true;
    const scope = captureWorkspaceScope(), signal = AbortSignal.any([local.signal, ...(canvasSignal ? [canvasSignal()] : [])]);
    try {
      const retained = currentRun(), paidKey = paidInputKey(token);
      // Audio policy controls local assembly, not the paid model inputs. Keep
      // completed clips and receipts when only this third key item changes.
      if (retained && paidKey && (retained.paidInputKey || paidInputKey(retained.configurationKey)) === paidKey
        && retained.configurationKey !== token && retained.audio !== (data().segmentRemakeAudio || "original")
        && ["complete", "paused"].includes(retained.phase) && retained.parts.length > 0
        && retained.parts.every(part => part.output && !part.taskRequestId)) {
        assertWorkspaceScope(scope); assertLive(signal);
        archiveResult(retained);
        retained.audio = data().segmentRemakeAudio || "original";
        retained.phase = "paused"; retained.configurationKey = token; retained.paidInputKey = paidKey;
        await save(signal);
      }
      const run = locked.value ? currentRun()! : await prepareExclusive(signal), { directory: workspace } = await files.getWorkspaceFiles().list();
      const remaining = unsent(run), fingerprint = runKey(run), values: NodeCreditEstimate[] = [];
      for (const part of remaining) {
        if (part.state === "pending" || part.completedRequestId) throw pendingError(part.completedRequestId);
        await assertAssets(run, signal); values.push(await options.ai.estimateVideo(request(run, part, workspace), signal));
      }
      assertWorkspaceScope(scope); assertLive(signal);
      if (seq !== sequence || token !== key.value || currentRun() !== run || fingerprint !== runKey(run)) return;
      if (values.some(value => !Number.isFinite(value.points) || Number(value.points) < 0)) throw new Error(translate("当前参数报价失败，请稍后重试"));
      quote.value = { ...(values[0] || {}), points: values.reduce((sum, value) => sum + Number(value.points), 0), breakdown: { ...(values[0]?.breakdown || {}), billingSource: "segment-remake-total" } };
      quotedKey = token; quotedRunKey = fingerprint;
    } catch (cause) { if (!signal.aborted && seq === sequence) error.value = cause instanceof Error ? cause.message : String(cause); }
    finally { if (seq === sequence) quoting.value = false; }
  }
  watch([key, autoVisible, () => options.busy.value], ([value], previous) => {
    quoteController?.abort(); quote.value = null; quotedKey = quotedRunKey = "";
    if (previous && value !== previous[0]) controller?.abort();
    if (timer) clearTimeout(timer); timer = undefined;
    if (autoVisible() && !options.busy.value && !starting.value) timer = setTimeout(() => { void refresh(true); }, 400);
  }, { immediate: true, flush: "sync" });
  const ready = computed(() => enabled.value && !admitting.value && !confirming.value && !starting.value && !options.busy.value && !quoting.value && !(currentRun()?.phase === "complete" && currentRun()?.configurationKey === key.value) && Boolean(quote.value && quotedKey === key.value));
  async function admit(interactive: boolean): Promise<"idle" | "cancel" | "start"> {
    if (admitting.value || confirming.value || options.busy.value || starting.value) throw new Error(translate("视频正在生成，请等待完成"));
    admitting.value = true;
    try {
      await refresh();
      const token = key.value, run = currentRun();
      if (!run) throw new Error(error.value || translate("请选择重拍片段并等待报价"));
      const quoted = Boolean(quote.value && quotedKey === token && quotedRunKey === runKey(run) && !quoting.value);
      const resumeOnly = !quoted && run.parts.some(part => part.taskRequestId && !part.output);
      const decision = segmentRemakeAdmission({ complete: run.phase === "complete" && run.configurationKey === token, quoted, resumeOnly, unsent: unsent(run).length, interactive });
      if (decision === "reject") throw new Error(error.value || translate("请选择重拍片段并等待报价"));
      if (decision === "idle") return decision;
      if (decision === "start") { admittedGate = { token, fingerprint: runKey(run), resumeOnly, ...(resumeOnly ? {} : { points: Number(quote.value!.points) }) }; return "start"; }
      const confirmedKey = token, confirmedRun = runKey(run);
      if (timer) clearTimeout(timer); timer = undefined;
      confirming.value = true;
      try {
        await ElMessageBox.confirm(translate("将生成 {0} 个重拍片段，预计共 {1} 积分，完成后拼回原视频。", { 0: unsent(run).length, 1: quote.value!.points }), translate("片段重拍"), { confirmButtonText: translate("生成"), cancelButtonText: translate("取消"), type: "info" });
        const latest = currentRun();
        if (!latest || key.value !== confirmedKey || runKey(latest) !== confirmedRun || quoting.value || !quote.value || quotedKey !== confirmedKey || quotedRunKey !== confirmedRun) throw new Error(translate("片段或参数已变化，请重新确认报价"));
        admittedGate = { token: confirmedKey, fingerprint: confirmedRun, resumeOnly: false, points: Number(quote.value!.points) };
      } catch (cause) { if (cause === "cancel" || cause === "close") return "cancel"; throw cause; }
      return "start";
    } finally { confirming.value = false; admitting.value = false; }
  }
  function discardAdmission() { admittedGate = undefined; }
  function consumePendingStop() {
    if (startFlight || controller || !explicitStop) return false;
    explicitStop = false;
    return true;
  }
  function start(): Promise<void> {
    const gate = admittedGate; admittedGate = undefined;
    if (startFlight) return startFlight;
    if (options.busy.value) return Promise.reject(new Error(translate("视频正在生成，请等待完成")));
    if (explicitStop) { explicitStop = false; return Promise.reject(new DOMException(translate("生成已取消"), "AbortError")); }
    if (!gate || gate.token !== key.value) return Promise.reject(new Error(translate("片段或参数已变化，请重新确认报价")));
    starting.value = true;
    const local = controller = new AbortController(), scope = captureWorkspaceScope(), signal = AbortSignal.any([local.signal, ...(canvasSignal ? [canvasSignal()] : [])]), token = key.value;
    if (explicitStop) local.abort();
    else explicitStop = false;
    let ownedRun: FrozenRun | undefined, ownedConfiguration = "", admitted = false;
    const check = () => { assertWorkspaceScope(scope); assertLive(signal); if (ownedRun && (currentRun() !== ownedRun || configurationKey(ownedRun) !== ownedConfiguration)) throw new Error(translate("片段或参数已变化，请重新确认报价")); if (token !== key.value) throw new Error(translate("片段或参数已变化，请重新确认报价")); };
    const work = Promise.resolve().then(async () => {
      check(); await refresh(); check();
      const run = currentRun(); if (!run) throw new Error(error.value || translate("请选择重拍片段并等待报价"));
      if (run.phase === "complete" && run.configurationKey === token) return;
      if (token !== gate.token) throw new Error(translate("片段或参数已变化，请重新确认报价"));
      const quoted = Boolean(quote.value && quotedKey === token && quotedRunKey === runKey(run) && !quoting.value);
      const charge = segmentRemakeCharge({
        gateResumeOnly: gate.resumeOnly, gateFingerprint: gate.fingerprint, gatePoints: gate.points, runKey: runKey(run),
        quoted, points: quoted ? Number(quote.value!.points) : undefined,
        hasInFlight: run.parts.some(part => part.taskRequestId && !part.output), unsentIds: unsent(run).map(part => part.id),
      });
      if (charge.action === "reject") throw new Error(charge.reason === "reconfirm" ? translate("片段或参数已变化，请重新确认报价") : (error.value || translate("请选择重拍片段并等待报价")));
      const authorized = charge.action === "submit" ? charge.authorized : [], fingerprint = runKey(run);
      ownedRun = run; ownedConfiguration = configurationKey(run);
      check();
      if (currentRun() !== run || fingerprint !== runKey(run)) throw new Error(translate("片段或参数已变化，请重新确认报价"));
      admitted = true; options.busy.value = true; error.value = ""; quoteController?.abort(); run.phase = "generating";
      await save(signal); const workspace = files.getWorkspaceFiles(), { directory: project } = await workspace.list();
      for (const part of run.parts) {
        check(); if (currentRun() !== run) throw new Error(translate("片段或参数已变化，请重新确认报价"));
        if (part.output) continue;
        if (!part.taskRequestId && !authorized.includes(part.id)) continue;
        if (!part.taskRequestId && (part.state === "pending" || part.completedRequestId)) throw pendingError(part.completedRequestId);
        status.value = translate("正在处理片段 {0}/{1}", { 0: run.parts.indexOf(part) + 1, 1: run.parts.length });
        let terminal = false, observedId = part.taskRequestId || "";
        const onStatus: NodeVideoRequest["onStatus"] = value => { terminal = ["failed", "cancelled", "expired"].includes(value); };
        const shouldCancel = () => explicitStop && !disposed;
        try {
          let results;
          if (observedId) results = await options.ai.resumeVideo(observedId, { directory: project, outputDirectory: directory(run, part), onStatus, shouldCancel }, signal);
          else {
            await assertOriginal(signal); await assertAssets(run, signal); check();
            const frozen = runKey(run), base = request(run, part, project);
            results = await options.ai.generateVideo({ ...base, onStatus, shouldCancel,
              onTask: async requestId => {
                // generateVideo signs/stages references before this pre-POST
                // callback; recheck their revisions after that async window.
                if (!observedId) { await assertOriginal(signal); await assertAssets(run, signal); }
                check();
                if (currentRun() !== run || frozen !== runKey(run) && !observedId) throw new Error(translate("片段或参数已变化，请重新确认报价"));
                if (part.completedRequestId === requestId && part.output) { observedId = requestId; return; }
                if (part.taskRequestId && part.taskRequestId !== requestId || observedId && observedId !== requestId) throw pendingError(part.taskRequestId || observedId);
                observedId = requestId; part.taskRequestId = requestId; part.state = "pending"; await save(signal); check();
              } }, signal);
          }
          check();
          if (currentRun() !== run || !observedId || part.taskRequestId && part.taskRequestId !== observedId) throw pendingError(part.taskRequestId || observedId);
          if (results.length !== 1) throw new Error(translate("重拍任务未返回唯一片段，请从生成历史取回结果"));
          if (part.completedRequestId && part.completedRequestId !== observedId) throw pendingError(observedId);
          part.completedRequestId = observedId; part.output = { url: results[0].path, mimeType: results[0].mimeType }; part.state = "complete"; delete part.taskRequestId; delete part.error;
          const metadata = await workspace.stat!(part.output.url, signal); check();
          (run.assetRevisions ??= {})[part.output.url] = metadata.revision; await save(signal);
        } catch (cause) {
          if (!disposed && currentRun() === run && !(part.output && part.completedRequestId === observedId)) {
            const unknown = Number((cause as { status?: number })?.status) === 404 || (cause as { generationPending?: boolean })?.generationPending;
            const ended = terminal && !unknown;
            part.state = ended || !observedId ? "failed" : "pending";
            if (ended && part.taskRequestId === observedId) delete part.taskRequestId;
            part.error = cause instanceof Error ? cause.message : String(cause);
          }
          throw cause;
        }
      }
      check();
      if (run.parts.some(part => !part.output)) { run.phase = "paused"; await save(signal); return; }
      // Only already saved originals participate in merging. A reopened native
      // completion can establish its output baseline without another paid call.
      for (const part of run.parts) if (!run.assetRevisions?.[part.output!.url]) {
        const metadata = await workspace.stat!(part.output!.url, signal); check();
        (run.assetRevisions ??= {})[part.output!.url] = metadata.revision;
      }
      const mergePaths = [run.source.file.url, ...run.parts.map(part => part.output!.url)];
      await assertAssets(run, signal, mergePaths); check(); run.phase = "merging"; status.value = translate("正在拼回原视频"); await save(signal);
      const target = `assets/${options.node.id}/segment-remake/${run.id}/result-${crypto.randomUUID()}.mp4`;
      const result = await mergeRemakeClips(await ffmpeg(signal), run.source.file.url, run.parts.map(part => ({ ...part, path: part.output!.url })), target, run.audio, signal);
      await assertAssets(run, signal, mergePaths); check();
      if (currentRun() !== run) throw new Error(translate("片段或参数已变化，请重新确认报价"));
      run.result = { url: result.path, mimeType: result.mimeType }; run.phase = "complete";
      if (options.applyResult) options.applyResult(run.result);
      else { options.node.data.outputs ??= {}; options.node.data.outputs.video = { dataType: "VIDEO", value: run.result }; }
      await save(signal);
    }).catch(async cause => {
      if (!disposed && currentRun()) { if (admitted && currentRun() === ownedRun) currentRun()!.phase = "paused"; error.value = cause instanceof Error ? cause.message : String(cause); if (!signal.aborted) await save().catch(() => {}); }
      throw cause;
    }).finally(() => {
      if (controller === local) controller = undefined;
      options.busy.value = false; starting.value = false; status.value = "";
      if (startFlight === flight) startFlight = undefined;
      if (activeWork === flight) activeWork = undefined;
      explicitStop = false;
      if (!disposed && autoVisible()) void refresh(true);
    });
    const flight = work; startFlight = flight; activeWork = flight; return flight;
  }
  function cancel() { explicitStop = true; controller?.abort(); }
  onScopeDispose(() => { disposed = true; sequence++; if (timer) clearTimeout(timer); quoteController?.abort(); controller?.abort(); });
  watch(active || ref(true), value => { if (!value) { quoteController?.abort(); controller?.abort(); } }, { flush: "sync" });
  return { enabled, quote, error, quoting, status, pending, locked, admitting, confirming, ready, currentTime, refresh, admit, discardAdmission, consumePendingStop, start, cancel, wait: () => activeWork };
}
