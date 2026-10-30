<template>
  <div class="agentConversation" :class="{ isEmpty }">
    <div class="messageViewport">
      <div ref="messageList" class="messageList" role="region" :aria-label="translate('对话消息')" tabindex="0">
        <div v-if="isEmpty" class="messageBubble agentEmptyState">
          <section class="welcomeMessage" :aria-label="translate('开始新对话')">
            <div class="welcomeHeader">
              <span class="welcomeIcon" aria-hidden="true"><span class="welcomeLogo" :style="{ maskImage: `url(${logoUrl})` }" /></span>
              <div>
                <h3>{{ translate('从一个想法开始') }}</h3>
              </div>
            </div>
            <p class="welcomeDescription">{{ translate('聊聊你的故事、画面或镜头，让我们一起把想法落到画布上。') }}</p>
          </section>
        </div>
        <div class="messageSpace" :style="{ height: `${messageVirtualizer.getTotalSize()}px` }">
          <el-button v-if="historyCursor" class="loadEarlierMessages" text size="small" :loading="olderLoading" @click="loadOlderMessages">{{ translate('加载更早的消息') }}</el-button>
          <div
            v-for="{ item, row } in visibleMessages"
            :key="item.id"
            :ref="measureMessage"
            :data-index="row.index"
            :data-message-id="item.id"
            class="messageRow"
            :style="{ transform: `translateY(${row.start}px)` }"
            :class="{
              userMessage: item.role === 'user',
              editingMessage: editingId === item.id,
              quietMessage: !messageVisible(item),
            }">
            <div class="messageBubble">
              <div class="messageContent">
                <button v-if="processDisclosure(item)" type="button" class="processDisclosure" :aria-expanded="processOpen(item)" @click="toggleProcess(item)">
                  <span>{{ processDisclosure(item) }}</span>
                  <icon-chevron-right :size="13" :class="{ expanded: processOpen(item) }" aria-hidden="true" />
                </button>
                <div v-if="dividerBefore(item)" class="processDivider" aria-hidden="true" />
                <div v-if="item.report" class="reportHeader"><icon-users-group :size="14" />{{ translate('{0} 上报', { 0: item.report.name }) }}</div>
                <template v-for="part in item.parts" :key="part.id">
                  <el-collapse v-if="part.type === 'thinking' && part.content && showProcess(item)" class="messageReasoning" :model-value="(part.collapsed ?? true) ? [] : [part.id]" @change="part.collapsed = !Array.isArray($event) || !$event.includes(part.id)">
                    <el-collapse-item :name="part.id">
                      <template #title>
                        <span class="reasoningHeader">
                          <icon-atom :size="14" />
                          <span>{{ translate('思考') }}</span>
                          <span v-if="part.duration !== undefined" class="thinkingDuration">{{ translate('{0} 秒', { 0: part.duration.toFixed(1) }) }}</span>
                        </span>
                      </template>
                      <messageMarkdown v-if="!(part.collapsed ?? true)" :content="part.content" :streaming="!!item.streaming" :directory="directory" />
                    </el-collapse-item>
                  </el-collapse>
                  <toolMessage v-else-if="part.type === 'tool' && (visibleTool(part.tool) || processOpen(item))" v-model:collapsed="part.collapsed" :tool="part.tool" :directory="directory" :subAgents="currentSubAgents" @copy="copyMessage" @open-child="emit('open-sub-agent', $event)" />
                  <messageMarkdown v-else-if="part.type === 'text' && part.content && (isFinalReply(item) || showProcess(item))" :content="part.content" :streaming="!!item.streaming" :directory="directory" />
                </template>
                <attachmentList v-if="item.attachments?.length" :attachments="item.attachments" :directory="directory" />
                <div v-if="item.role === 'user'" class="messageText"><mentionContent :content="item.content" :mentions="item.mentions" :directory="directory" /></div>
                <div v-if="item.error" class="messageError" role="alert">{{ item.error }}</div>
              </div>
            </div>
            <div v-if="!item.streaming && messageVisible(item) && (item.role === 'user' || item.report || isFinalReply(item))" class="messageActions">
              <template v-if="editingId === item.id">
                <el-button text size="small" :disabled="busy || deletingId !== undefined" @click="cancelEdit"><icon-x :size="14" />{{ translate('取消') }}</el-button>
                <span class="editingHint">{{ translate('正在下方编辑') }}</span>
              </template>
              <template v-else>
                <el-button v-if="item.content" class="messageAction" text circle :aria-label="translate('复制消息')" :title="translate('复制消息')" @click="copyMessage(mentionPlainText(item.content, item.mentions))"><icon-copy :size="14" /></el-button>
                <template v-if="item.role === 'user'">
                  <el-button class="messageAction" text circle :disabled="locked || turnRunning" :aria-label="translate('编辑消息')" :title="translate('编辑消息')" @click="editMessage(item)"><icon-pencil :size="14" /></el-button>
                </template>
                <el-button v-if="!item.report" class="messageAction" text circle :loading="deletingId === item.id" :disabled="locked || turnRunning" :aria-label="translate('删除消息')" :title="translate('删除消息')" @click="deleteMessage(item)"><icon-trash v-if="deletingId !== item.id" :size="14" /></el-button>
              </template>
            </div>
          </div>
        </div>
        <div v-if="queuedMessages.length" class="pendingFollowUps" role="region" :aria-label="translate('待处理的消息')">
          <div v-for="item in queuedMessages" :key="item.id" class="pendingFollowUp" :data-status="item.status">
            <div class="pendingBubble">{{ mentionPlainText(item.prompt, item.mentions) || item.attachments[0]?.name }}</div>
            <div class="pendingMeta">
              <el-icon v-if="item.status === 'sending'" class="is-loading" aria-hidden="true"><icon-loader-2 :size="12" /></el-icon>
              <span :role="item.status === 'failed' ? 'alert' : undefined">{{ pendingStatus(item) }}</span>
              <el-button v-if="item.status === 'failed'" text size="small" :disabled="locked || pendingInputAction === item.id" @click="guidePendingInput(item)">{{ translate('重试') }}</el-button>
              <el-button v-if="item.status === 'cancelled'" text size="small" :disabled="locked || hasDraft || pendingInputAction === item.id" @click="updatePendingInput(item, 'edit')">{{ translate('移回输入框') }}</el-button>
              <el-button v-if="['queued', 'failed'].includes(item.status)" text size="small" :disabled="locked || pendingInputAction === item.id" @click="updatePendingInput(item, 'withdraw')">{{ translate('撤回') }}</el-button>
            </div>
          </div>
        </div>
        <div v-if="turnRunning && !compacting" class="agentWorking" role="status">
          <span class="activityShimmer">{{ workingStatus }}</span>
          <span v-if="workingSeconds >= 3" class="workingTime">{{ formatWorkingTime(workingSeconds) }}</span>
        </div>
      </div>
      <el-button v-if="messages.length && !atLatestMessage" class="scrollBottom" circle :aria-label="translate('回到最新消息')" :title="translate('回到最新消息')" @click="messageVirtualizer.scrollToEnd()"><icon-arrow-down :size="18" /></el-button>
    </div>
    <div v-if="nativeConnection === 'reconnecting'" class="compactionStatus" role="status"><el-icon class="is-loading"><icon-loader-2 :size="14" /></el-icon><span>{{ translate('正在恢复任务状态，已提交的任务仍在后台执行…') }}</span></div>
    <div v-if="compacting || retrying" class="compactionStatus" role="status">
      <el-icon class="is-loading" aria-hidden="true"><icon-loader-2 :size="14" /></el-icon>
      <span>{{ retrying ? translate(retrying.source === 'compaction' ? '上下文整理正在重试（第 {0} 次）…' : '连接恢复中（第 {0} 次）…', { 0: retrying.attempt || 1 }) : translate('正在压缩上下文…') }}</span>
    </div>
    <div v-if="lastCompaction?.status === 'failed' && !compacting" class="compactionStatus" role="alert">
      <span>{{ translate('上下文整理未完成，原始记录已保留，可以重试') }}</span>
    </div>
    <div v-if="lastFailure && !turnRunning" class="compactionStatus" role="alert"><span>{{ translate(lastFailure.message) }}</span></div>
    <div class="messageInput">
      <div v-if="isEmpty" class="composerSuggestions">
        <el-button v-for="item in welcomeSuggestions" :key="item.label" class="composerSuggestion" text :disabled="locked" :aria-label="translate('填入提示：{0}', { 0: item.label })" :title="item.description" @click="fillPrompt(item.prompt)">
          <component :is="item.icon" :size="14" aria-hidden="true" /><span>{{ item.label }}</span>
        </el-button>
      </div>
      <div v-if="editingId" class="editingBanner"><span>{{ translate('编辑消息') }}</span><el-button text size="small" :disabled="busy" @click="cancelEdit">{{ translate('取消') }}</el-button></div>
      <div
        class="senderResizeHandle"
        role="separator"
        aria-orientation="horizontal"
        :aria-label="translate('调整输入框高度')"
        aria-valuemin="64"
        :aria-valuemax="senderMaxHeight"
        :aria-valuenow="senderHeight"
        tabindex="0"
        :title="translate('拖动调整输入框高度')"
        @focus="senderHeight = sender?.chatElement.rollBox.clientHeight ?? 64"
        @pointerdown="startSenderResize"
        @pointermove="moveSenderResize"
        @pointerup="stopSenderResize"
        @pointercancel="stopSenderResize"
        @lostpointercapture="stopSenderResize"
        @keydown.up.prevent="setSenderHeight((sender?.chatElement.rollBox.clientHeight ?? 64) + 16)"
        @keydown.down.prevent="setSenderHeight((sender?.chatElement.rollBox.clientHeight ?? 64) - 16)" />
      <attachmentList v-if="draftAttachments.length" class="draftAttachments" :attachments="draftAttachments" :directory="directory" removable restorable :disabled="locked" @remove="draftAttachments.splice($event, 1)" @restore="restoreTextAttachment" />
      <div ref="senderElement" class="senderEditor" @keydown.capture="handleSenderKeydown"></div>
      <teleport v-for="target in draftMentionTargets" :key="target.key" :to="target.element"><mentionThumbnail v-bind="mentionThumbnailProps(target.mention)" :directory="directory"><icon-photo :size="14" /></mentionThumbnail></teleport>
      <mentionContent ref="draftMentionPreview" :mentions="draftMentions" :directory="directory" removable @remove="removeDraftMention" />
      <div class="senderActions">
        <input ref="attachmentInput" type="file" multiple accept="image/*,video/*,text/plain" hidden :disabled="locked" @change="selectAttachments" />
        <el-button class="attachmentButton" text circle :disabled="locked" :aria-label="translate('添加文件')" :title="translate('添加文件')" @click="attachmentInput?.click()">
          <icon-paperclip :size="16" aria-hidden="true" />
        </el-button>
        <modelPopover :model-value="selectedModel" :reasoningEffort="reasoningEffort" @update:model-value="selectModel" @update:reasoningEffort="selectReasoningEffort" :active="active" :disabled="disabled || turnRunning" />
        <mentionMenu ref="mentionMenuRef" :directory="directory" :active="active" :disabled="locked || !directory" :query="mentionQuery" :editor="senderElement" :currentCanvasId="createCanvasContext?.()?.id" @open="captureMentionPosition" @select="insertMentions" @dismiss="mentionQuery = undefined" />
        <skillMenu ref="skillMenuRef" :directory="directory" :session-file="nativeFile || sessionFile" :active="active" :disabled="locked || !directory" :query="skillQuery" :editor="senderElement" @select="selectSkill" @dismiss="skillQuery = undefined" />
        <el-popover
          v-model:visible="contextMenuVisible"
          trigger="click"
          placement="top"
          :width="280"
          :offset="10"
          :showArrow="false"
          popperClass="agentContextPopover">
          <template #reference>
            <el-button class="contextButton" text circle :aria-label="translate('查看上下文用量')" :title="translate('查看上下文用量')">
              <icon-circle-dashed :size="14" />
            </el-button>
          </template>
          <div class="contextUsage">
            <div class="contextHeader"><span>{{ translate('上下文用量') }}</span><span class="contextHint">{{ translate('估算') }}</span></div>
            <template v-if="contextUsage?.tokens != null">
              <div class="contextTokens">
                <span>{{ contextUsage.tokens.toLocaleString() }} / {{ contextWindow.toLocaleString() }} tok</span>
                <span>{{ contextPercent.toFixed(1) }}%</span>
              </div>
              <el-progress :percentage="Math.min(100, contextPercent)" :showText="false" />
            </template>
            <span v-else class="contextHint">{{ contextUsage ? translate("等待下一次回复更新用量") : translate("尚无用量数据") }}</span>
            <p class="contextHint">{{ translate('接近容量上限时会自动整理，保留任务目标、约束和近期内容。原始对话记录仍会保留。') }}</p>
            <span v-if="lastCompaction?.status === 'completed'" class="contextHint">{{ translate('最近整理：约 {0} → {1} tok', { 0: lastCompaction.tokensBefore?.toLocaleString() ?? '—', 1: lastCompaction.tokensAfter?.toLocaleString() ?? '—' }) }}</span>
            <el-button size="small" :disabled="busy || remoteRunning || locked || !sessionFile || !selectedModelChoice" @click="compactContext">{{ translate('整理上下文') }}</el-button>
            <div v-if="stats" class="contextStats">
              <div class="contextHeader">{{ translate('对话累计用量') }}</div>
              <div class="contextTokens"><span>{{ translate('输入') }}</span><span>{{ inputTokens.toLocaleString() }} tok</span></div>
              <div class="contextTokens"><span>{{ translate('输出') }}</span><span>{{ stats.tokens.output.toLocaleString() }} tok</span></div>
              <div v-if="inputTokens > 0" class="contextTokens"><span>{{ translate('缓存命中') }}</span><span>{{ (stats.tokens.cacheRead / inputTokens * 100).toFixed(1) }}%</span></div>
              <div v-if="stats.tokensPerSecond !== undefined" class="contextTokens"><span>{{ translate('生成速度') }}</span><span>{{ stats.tokensPerSecond.toFixed(1) }} tok/s</span></div>
            </div>
          </div>
        </el-popover>
        <el-button v-if="turnRunning" class="stopButton" text circle :disabled="stopping" :aria-label="translate('停止生成')" :title="translate('停止生成')" @click="stopMessage"><icon-player-stop-filled :size="14" /></el-button>
        <el-button v-if="!turnRunning || hasDraft" class="sendButton" type="primary" circle :disabled="locked || !hasDraft || !createCanvasContext?.()?.id" :aria-label="editingId ? translate('重发消息') : turnRunning ? translate('引导当前任务') : translate('发送消息')" :title="editingId ? translate('重发消息') : turnRunning ? translate('引导当前任务') : translate('发送消息')" @click="submitMessage()">
          <icon-arrow-up :size="16" />
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { locale, t, translate } from "@miaoimg/i18n/vue";
import { computed, inject, nextTick, onBeforeUnmount, onScopeDispose, provide, reactive, ref, shallowRef, watch, type ComponentPublicInstance } from "vue";
import { defaultRangeExtractor, observeElementRect, useVirtualizer } from "@tanstack/vue-virtual";
import axios from "axios";
import {
  IconArrowUp, IconArrowDown, IconAtom, IconCopy, IconChevronRight,
  IconCircleDashed, IconPencil, IconPlayerStopFilled, IconX, IconLoader2,
  IconTrash, IconDots, IconLayoutGrid, IconMovie, IconPhoto, IconUsersGroup, IconPaperclip,
} from "@tabler/icons-vue";
import { ElDropdown, ElDropdownItem, ElDropdownMenu, ElMessage } from "element-plus";
import logoUrl from "@miaoimg/assets/logo.svg";
import modelPopover from "../modelPopover.vue";
import skillMenu from "./skillMenu.vue";
import mentionMenu from "./mentionMenu.vue";
import mentionContent from "./mentionContent.vue";
import mentionThumbnail from "./mentionThumbnail.vue";
import { mentionName, mentionParts, mentionPlainText, mentionThumbnailProps } from "./mentionText";
import toolMessage from "./toolMessage.vue";
import { toolActionLabel } from "./toolLabels";
import attachmentList from "./attachmentList.vue";
import { createPastedTextFile, readTextAttachment } from "./textAttachments";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { assertWorkspaceScope, captureWorkspaceScope } from "@/lib/workspaceRemote";
import { writeClipboardText } from "@/lib/clipboard";
import { modelChoices, textModelSettings, updateTextModelSettings, personalizationSettings } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import type { AgentAttachment, AgentConversation, AgentDraft, AgentMessage, AgentPendingInput } from "./types";
import type { AgentToolCall } from "@miaoimg/server/agent/types";
import type { AgentEvent, AgentMention, AgentCompaction } from "@miaoimg/server/agent/types";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import { createConversationStream } from "./replyStream";
import { clearEndedQuestionDrafts, clearQuestionToolDrafts, questionDraftsKey } from "./questionDraft";
import type { CanvasContext } from "@miaoimg/tool-canvas/runtime";
import { messageMarkdown } from "./messageRenderer";
import xSender, { type AnyTagProps } from "x-sender";
import "x-sender/lib/XSender.css";

const props = defineProps<{ active: boolean; initialSession: AgentConversation | null; initialDraft?: AgentDraft; sessionFile?: string; disabled: boolean }>();
const emit = defineEmits<{ session: [file: string]; "open-sub-agent": [file: string]; draft: [value: AgentDraft]; sent: [prompt: string]; event: [event: AgentEvent]; running: [value: boolean]; admitting: [value: boolean] }>();
const workspaceStore = useWorkspaceStore();
const directory = workspaceStore.project?.directory;
const conversationScope = captureWorkspaceScope();
// Keep the same per-chat record across renderer remounts. A late answer receipt
// can then clear its own question without replacing another question's draft.
const questionDrafts = reactive(props.initialDraft?.questionDrafts ?? {});
let questionDraftOwnerActive = true;
provide(questionDraftsKey, questionDrafts);
if (props.initialSession) clearEndedQuestionDrafts(questionDrafts, props.initialSession);
const pendingMessage = props.initialSession?.parentFile ? undefined : workspaceStore.pendingAgentMessage;
const draftAttachments = ref<AgentAttachment[]>([]);
const createCanvasContext = inject<(() => CanvasContext | undefined) | undefined>("canvas", undefined);
function hydrateMessages(items: AgentMessage[] | undefined) {
  return (items ?? []).map(message => {
    const next = { ...message };
    if (next.role === "assistant" && !next.parts?.length && next.content) {
      next.parts = [{ id: next.id || crypto.randomUUID(), type: "text", content: next.content }];
    }
    return next;
  });
}
const messages = ref<AgentMessage[]>(hydrateMessages(props.initialSession?.messages));
const stream = createConversationStream(messages);
const olderMessages = shallowRef<AgentMessage[]>([]);
const historyCursor = ref(props.initialSession?.historyCursor);
const olderLoading = ref(false);
let historyRevision = props.initialSession?.historyRevision || 0;
const remoteRunning = ref(props.initialSession?.running ?? false);
const currentSubAgents = shallowRef(props.initialSession?.subAgents || []);
const stats = ref(props.initialSession?.stats);
const contextUsage = ref(props.initialSession?.contextUsage);
const busy = ref(false);
const compacting = ref(false);
const turnRunning = computed(() => busy.value || remoteRunning.value || compacting.value);
watch(turnRunning, value => emit('running', value), { immediate: true, flush: 'sync' });
const stopping = ref(false);
const retrying = ref<Extract<AgentEvent, { type: 'retry' }>>();
const lastCompaction = ref<AgentCompaction | undefined>(props.initialSession?.lastCompaction);
const lastFailure = ref(props.initialSession?.lastFailure);
const deletingId = ref<string>();
const restoringAttachment = ref(false);
// 生成期间仍允许编辑；补充交给 pi 的 steering，在安全步骤边界进入同一任务。
const locked = computed(() => props.disabled || deletingId.value !== undefined || restoringAttachment.value || stopping.value);
type QueuedAgentMessage = AgentPendingInput;
const queuedMessages = ref<QueuedAgentMessage[]>((props.initialSession?.pendingInputs || []).map(item => ({ id: item.entryId || item.id, submissionId: item.submissionId, prompt: item.content, attachments: item.attachments || [], mentions: item.mentions || [], status: 'queued', mode: item.mode || 'steer' })));
const isEmpty = computed(() => !messages.value.length && !queuedMessages.value.length && !props.disabled);
for (const item of props.initialDraft?.pendingInputs || []) if (!queuedMessages.value.some(current => current.id === item.id)) queuedMessages.value.push({ ...item, status: item.status === 'sending' ? 'failed' : item.status });
const pendingInputAction = ref<string>();
// Receipts survive removal from the visible queue for this mounted chat. A late
// observer frame must not put an applied or withdrawn input back into the queue.
const acknowledgedInputs = new Map<string, 'queued' | 'applied' | 'cancelled'>();
for (const item of queuedMessages.value) if (item.status === 'cancelled') acknowledgedInputs.set(item.id, 'cancelled');
const draftRevision = ref(0);
const hasDraft = computed(() => { draftRevision.value; return hasDraftToSend(); });
const savedEditing = !pendingMessage ? props.initialDraft?.editing : undefined;
const editingSource = shallowRef<AgentMessage | undefined>(savedEditing?.message);
const editingId = computed(() => editingSource.value?.id);
const draftMentions = ref<AgentMention[]>([]);
const draftMentionTargets = shallowRef<{ key: symbol; element: HTMLElement; mention: AgentMention }[]>([]);
const draftMentionPreview = ref<InstanceType<typeof mentionContent>>();
let editDraft: { content: string; model: AnyTagProps[][]; mentions: AgentMention[]; attachments: AgentAttachment[] } | undefined = savedEditing ? {
  content: savedEditing.original.content,
  model: promptModel(savedEditing.original.content, savedEditing.original.mentions),
  mentions: savedEditing.original.mentions.map(item => ({ ...item })),
  attachments: savedEditing.original.attachments.map(item => ({ ...item })),
} : undefined;
const messageList = ref<HTMLDivElement>();
const atLatestMessage = ref(true);
let messageListInitialized = false;
let messageScrollOffset = 0;
const messageKeys = computed(() => messages.value.map(item => item.id));
const retainedMessages = computed(() => messages.value.flatMap((item, index) => item.streaming || item.id === editingId.value ? [index] : []));
const messageVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>(computed(() => {
  const keys = messageKeys.value;
  const retained = retainedMessages.value;
  return {
    count: keys.length,
    getScrollElement: () => messageList.value ?? null,
    getItemKey: (index: number) => keys[index]!,
    estimateSize: () => 240,
    overscan: 3,
    paddingStart: historyCursor.value ? 52 : 12,
    anchorTo: "end" as const,
    followOnAppend: true,
    scrollEndThreshold: 48,
    useAnimationFrameWithResizeObserver: true,
    useCachedMeasurements: !props.active,
    // ACT: v-show 隐藏时保留视口与行高，避免零尺寸清空正在输入的工具表单。
    observeElementRect: (instance, onChange) => observeElementRect(instance, rect => { if (rect.height) onChange(rect); }),
    rangeExtractor: range => [...new Set([...defaultRangeExtractor(range), ...retained])].sort((left, right) => left - right),
    onChange(instance) {
      if (!messageListInitialized || !props.active || !messageList.value?.clientHeight) return;
      atLatestMessage.value = instance.isAtEnd();
      messageScrollOffset = instance.scrollOffset ?? 0;
    },
  };
}));
const visibleMessages = computed(() => messageVirtualizer.value.getVirtualItems().map(row => ({ row, item: messages.value[row.index]! })));

function measureMessage(element: Element | ComponentPublicInstance | null) {
  messageVirtualizer.value.measureElement(element instanceof HTMLDivElement ? element : null);
}

watch([() => props.active, messageList], async ([active, element]) => {
  if (!active || !element) return;
  await nextTick();
  if (!props.active) return;
  if (!messageListInitialized || atLatestMessage.value) messageVirtualizer.value.scrollToEnd();
  else messageVirtualizer.value.scrollToOffset(messageScrollOffset);
  messageListInitialized = true;
}, { immediate: true, flush: "post" });
let sender: xSender | undefined;
onBeforeUnmount(() => {
  questionDraftOwnerActive = false;
  emit('draft', {
    content: sender ? getDraftContent() : props.initialDraft?.content || '',
    attachments: sender ? draftAttachments.value.map(item => ({ ...item })) : props.initialDraft?.attachments || [],
    mentions: sender ? draftMentions.value.map(item => ({ ...item })) : props.initialDraft?.mentions || [],
    pendingInputs: queuedMessages.value.map(item => ({ ...item })),
    questionDrafts,
    ...(modelSettingsEdited ? { model: selectedModel.value, reasoningEffort: reasoningEffort.value } : {}),
    ...(editingSource.value && editDraft ? { editing: {
      message: { ...editingSource.value },
      original: { content: editDraft.content, attachments: editDraft.attachments.map(item => ({ ...item })), mentions: editDraft.mentions.map(item => ({ ...item })) },
    } } : {}),
  });
});
const senderPlaceholder = () => translate(turnRunning.value ? "继续输入补充要求，不会打断当前任务" : "输入消息，@ 提及节点输出或工作区素材…");
watch(turnRunning, () => sender?.updateConfig({ placeholder: senderPlaceholder() }));
watch(locale, () => {
  if (!sender) return;
  sender.updateConfig({ placeholder: senderPlaceholder() });
  sender.chatElement.richText.setAttribute("aria-label", translate("消息"));
  for (const line of sender.chatEditor.NODES) for (const tag of line.children) {
    if (tag.type === "Mention") tag.$el.setAttribute("aria-label", t`预览 ${tag.name}`);
  }
});
const senderElement = ref<HTMLElement>();
const attachmentInput = ref<HTMLInputElement>();
const skillMenuRef = ref<InstanceType<typeof skillMenu>>();
const skillQuery = ref<string>();
const mentionMenuRef = ref<InstanceType<typeof mentionMenu>>();
const mentionQuery = ref<string>();
let mentionPosition: { node: ReturnType<xSender["getCurrentNode"]>; remove: number } | undefined;
let insertingMentions = false;
const senderHeight = ref(64);
const senderMaxHeight = ref(Math.max(64, window.innerHeight / 2));
let senderResize: { pointerId: number; y: number; height: number } | undefined;
const selectedModel = ref(pendingMessage?.model ?? props.initialDraft?.model ?? (props.initialSession?.providerId && props.initialSession.modelId
  ? JSON.stringify([props.initialSession.providerId, props.initialSession.modelId]) : textModelSettings.value));
const contextMenuVisible = ref(false);
const reasoningEffort = ref(pendingMessage?.reasoningEffort ?? props.initialDraft?.reasoningEffort ?? (props.initialSession?.thinkingLevel === "off" ? "" : props.initialSession?.thinkingLevel ?? ""));
let modelSettingsEdited = pendingMessage?.model !== undefined || pendingMessage?.reasoningEffort !== undefined || props.initialDraft?.model !== undefined || props.initialDraft?.reasoningEffort !== undefined;
function selectModel(value: string) { selectedModel.value = value; modelSettingsEdited = true; }
function selectReasoningEffort(value: string) { reasoningEffort.value = value; modelSettingsEdited = true; }
function reconcileModelSettings(conversation: AgentConversation) {
  const model = conversation.providerId && conversation.modelId ? JSON.stringify([conversation.providerId, conversation.modelId]) : undefined;
  const effort = conversation.thinkingLevel === 'off' ? '' : conversation.thinkingLevel ?? '';
  // Keep a local choice until a matching configuration is actually observed.
  // Otherwise follow the session, including changes made while this chat was hidden.
  if (!modelSettingsEdited) {
    if (model) selectedModel.value = model;
    reasoningEffort.value = effort;
  } else if (model === selectedModel.value && effort === reasoningEffort.value) modelSettingsEdited = false;
}
const selectedModelChoice = computed(() => modelChoices.value.find(item => item.value === selectedModel.value));
const contextWindow = computed(() => selectedModelChoice.value?.contextWindow ?? contextUsage.value?.contextWindow ?? 1000000);
const contextPercent = computed(() => (contextUsage.value?.tokens ?? 0) / contextWindow.value * 100);
const inputTokens = computed(() => stats.value ? stats.value.tokens.input + stats.value.tokens.cacheRead + stats.value.tokens.cacheWrite : 0);
watch(modelChoices, items => {
  // Keep the session choice while the catalog loads; an unavailable model
  // requires an explicit new choice instead of silently changing providers.
  if (!selectedModel.value && items.length) selectedModel.value = items[0]!.value;
}, { immediate: true });
watch(selectedModel, value => { if (value) updateTextModelSettings(value); });
// 对话展示回复、可展开的思考、提问和子任务；读写画布、查资料等工具步骤不单独列出，
// 运行中用一行「正在…」说明当前在做什么。
const interactiveTools = new Set(["askUser", "subAgent"]);
function visibleTool(tool: AgentToolCall) {
  return interactiveTools.has(tool.name) || Boolean(tool.question?.callId);
}
function hasReplyText(item: AgentMessage) {
  return Boolean(item.content?.trim() || item.parts?.some(part => part.type === "text" && part.content.trim()));
}
// 一轮 = 一条用户消息之后的全部助手消息。运行中显示思考与正文、隐藏工具步骤；
// 这一轮结束后，思考、工具步骤和中间说明收进最终回复上方的「处理过程」，点开才显示。
type TurnInfo = { turnId: string; first: boolean; final: boolean; complete: boolean; steps: number; hasProcess: boolean };
const expandedTurns = reactive(new Set<string>());
const turnInfo = computed(() => {
  const info = new Map<string, TurnInfo>();
  let turn: AgentMessage[] = [];
  let turnId = "";
  const flush = () => {
    if (!turn.length) return;
    const complete = !turn.some(item => item.streaming);
    const final = [...turn].reverse().find(item => hasReplyText(item) || item.error) ?? turn.at(-1)!;
    const steps = turn.reduce((count, item) => count + (item.parts?.filter(part => part.type === "tool" && !visibleTool(part.tool)).length ?? 0), 0);
    const hasProcess = steps > 0 || turn.some(item => item !== final && hasReplyText(item))
      || turn.some(item => item.parts?.some(part => part.type === "thinking" && part.content.trim()));
    for (const item of turn) info.set(item.id, { turnId: turnId || turn[0]!.id, first: item === turn[0], final: item === final, complete, steps, hasProcess });
    turn = [];
  };
  for (const item of messages.value) {
    if (item.role === "user") { flush(); turnId = item.id; continue; }
    if (item.report) continue;
    turn.push(item);
  }
  flush();
  return info;
});
function processOpen(item: AgentMessage) {
  const turn = turnInfo.value.get(item.id);
  return Boolean(turn?.complete && expandedTurns.has(turn.turnId));
}
// 运行中照常显示过程；结束后只有展开时显示。
function showProcess(item: AgentMessage) {
  const turn = turnInfo.value.get(item.id);
  return !turn || !turn.complete || expandedTurns.has(turn.turnId);
}
function isFinalReply(item: AgentMessage) {
  return turnInfo.value.get(item.id)?.final ?? true;
}
// 「处理过程」放在这一轮最前面，展开的步骤跟在它下面；分隔线在最终回复之前。
function processDisclosure(item: AgentMessage) {
  const turn = turnInfo.value.get(item.id);
  if (!turn?.complete || !turn.first || !turn.hasProcess) return "";
  if (expandedTurns.has(turn.turnId)) return translate("收起处理过程");
  return turn.steps ? translate("处理过程 · {0} 步", { 0: turn.steps }) : translate("处理过程");
}
function dividerBefore(item: AgentMessage) {
  const turn = turnInfo.value.get(item.id);
  return Boolean(turn?.complete && turn.final && turn.hasProcess);
}
function toggleProcess(item: AgentMessage) {
  const turn = turnInfo.value.get(item.id);
  if (!turn) return;
  if (expandedTurns.has(turn.turnId)) expandedTurns.delete(turn.turnId);
  else expandedTurns.add(turn.turnId);
}
function messageVisible(item: AgentMessage) {
  if (item.role === "user" || item.streaming || item.report) return true;
  const turn = turnInfo.value.get(item.id);
  if (turn?.complete && (turn.final || (turn.first && turn.hasProcess))) return true;
  if (turn?.complete && !expandedTurns.has(turn.turnId)) return false;
  // 运行中（或已展开）：思考内容保留，可以展开查看；只有纯工具步骤的消息不占位置，展开后才显示。
  return hasReplyText(item) || Boolean(item.error || item.attachments?.length)
    || Boolean(item.parts?.some(part => part.type === "thinking" ? part.content.trim() : part.type === "tool" && (visibleTool(part.tool) || processOpen(item))));
}
function messageActivity(item: AgentMessage) {
  const parts = item.parts ?? [];
  const running = [...parts].reverse().find(part => part.type === "tool" && part.tool.status === "running");
  if (running?.type === "tool") return running.tool.name === "askUser" ? "" : translate("正在{0}…", { 0: translate(toolActionLabel(running.tool)) });
  const last = parts.at(-1);
  // 正文正在逐字出现时不再叠一行状态。
  if (last?.type === "text" && last.content) return "";
  return translate(last?.type === "tool" ? "正在整理结果…" : "正在思考…");
}
// 运行计时：从这一轮开始计，结束清零。
const workingSeconds = ref(0);
let workingTimer: number | undefined;
watch(() => turnRunning.value && !compacting.value, running => {
  window.clearInterval(workingTimer);
  workingSeconds.value = 0;
  if (running) workingTimer = window.setInterval(() => { workingSeconds.value++; }, 1000);
}, { immediate: true });
onScopeDispose(() => window.clearInterval(workingTimer));
function formatWorkingTime(seconds: number) {
  // 和 Codex 一样写「已处理 {时间}」。
  return translate('已处理 {0}', { 0: seconds < 60 ? translate('{0} 秒', { 0: seconds }) : translate('{0} 分 {1} 秒', { 0: Math.floor(seconds / 60), 1: seconds % 60 }) });
}
const workingStatus = computed(() => {
  const streaming = [...messages.value].reverse().find(item => item.streaming);
  const activity = streaming ? messageActivity(streaming) : "";
  return activity || translate("处理中…");
});
function pendingStatus(item: QueuedAgentMessage) {
  if (item.error) return item.error;
  switch (item.status) {
    case "sending": return translate(turnRunning.value ? "正在交给助手…" : "发送中…");
    case "queued": return translate(item.mode === "followUp" ? "已加入队列，本轮完成后处理" : "正在引导，当前这一步完成后接着处理");
    case "waiting": return translate("等待发送");
    case "failed": return translate("没有发出去，可以重试");
    default: return translate("这条消息没有被处理，可以移回输入框重新发送");
  }
}
watch(() => [queuedMessages.value.length, turnRunning.value] as const, async ([length, running], previous) => {
  if (length <= (previous?.[0] ?? 0) && !(running && !previous?.[1])) return;
  await nextTick();
  messageList.value?.scrollTo({ top: messageList.value.scrollHeight });
});

// 卡片文案跟着语言切，所以是 computed；prompt 是发给模型的中文指令，保持原样。
const welcomeSuggestions = computed(() => [
  { label: translate("搭建创作画布"), description: translate("把创意串成清晰的节点流程"), icon: IconLayoutGrid, prompt: "帮我搭建一个创作画布，先和我确认需要的节点与流程。" },
  { label: translate("梳理故事分镜"), description: translate("拆解故事，安排画面与镜头"), icon: IconMovie, prompt: "帮我把故事整理成分镜，先和我确认故事内容、时长和画面风格。" },
  { label: translate("生成图片素材"), description: translate("为角色和场景寻找视觉方向"), icon: IconPhoto, prompt: "帮我生成图片素材，先和我确认画面内容、风格和使用的模型。" },
]);
watch([locked, () => props.active], ([locked, active]) => {
  if (!active || locked) sender?.disable();
  else sender?.enable();
});
watch(() => props.active, active => {
  if (!active) contextMenuVisible.value = false;
});

function applyEvent(event: AgentEvent) {
  switch (event.type) {
    case "sessionSnapshot": reconcileConversation(event.conversation); break;
    case "tool":
      if (questionDraftOwnerActive) clearQuestionToolDrafts(questionDrafts, event.tool);
      stream.receive(event);
      break;
    case "subAgent":
    case "subAgentEvent": emit("event", event); break;
    case "report":
      if (event.parentFile !== props.sessionFile) { emit("event", event); break; }
      if (!messages.value.some(message => message.id === event.id)) messages.value.push({
        id: event.id, role: "assistant", content: event.content,
        parts: [{ id: event.id, type: "text", content: event.content }], report: { file: event.file, name: event.name },
      });
      break;
    case "compaction":
      compacting.value = event.active;
      if (!event.active && event.status && event.status !== 'skipped' && event.reason) lastCompaction.value = { status: event.status, reason: event.reason, tokensBefore: event.tokensBefore, tokensAfter: event.tokensAfter, createdAt: event.createdAt };
      if (event.contextUsage) contextUsage.value = event.contextUsage;
      break;
    case "retry": retrying.value = event.active ? event : undefined; break;
    case "session": emit("session", event.file); break;
    case "stats": stats.value = event.stats; contextUsage.value = event.contextUsage; break;
    case "input": queuedMessages.value = queuedMessages.value.filter(item => item.id !== event.id); break;
    case "heartbeat": break;
    default: stream.receive(event);
  }
}

function reconcileConversation(conversation: AgentConversation) {
  if (questionDraftOwnerActive) clearEndedQuestionDrafts(questionDrafts, conversation);
  stream.finish();
  reconcileModelSettings(conversation);
  currentSubAgents.value = conversation.subAgents || [];
  compacting.value = !!conversation.compacting;
  retrying.value = conversation.retrying ? { type: 'retry', active: true, ...conversation.retrying } : undefined;
  for (const agent of conversation.subAgents || []) emit('event', { type: 'subAgent', agent });
  if ((conversation.historyRevision || 0) !== historyRevision) olderMessages.value = [];
  else if (olderMessages.value.length || olderLoading.value) {
    const start = messages.value.findIndex(message => message.id === conversation.messages[0]?.id);
    // Retain the moving window while an earlier page is in flight. If a
    // reconnect skipped the whole window, restart pagination at the new one
    // instead of presenting two disjoint ranges as continuous history.
    olderMessages.value = start >= 0 ? messages.value.slice(0, start) : [];
  }
  historyRevision = conversation.historyRevision || 0;
  const present = new Set(conversation.messages.map(message => message.id));
  olderMessages.value = olderMessages.value.filter(message => !present.has(message.id));
  messages.value = olderMessages.value.length ? [...olderMessages.value, ...conversation.messages] : conversation.messages;
  if (!olderMessages.value.length) historyCursor.value = conversation.historyCursor;
  stats.value = conversation.stats;
  contextUsage.value = conversation.contextUsage;
  lastCompaction.value = conversation.lastCompaction;
  lastFailure.value = conversation.lastFailure;
  remoteRunning.value = !!conversation.running;
  const applied = new Set([...conversation.messages.filter(item => item.role === 'user').flatMap(item => [item.entryId, item.id]), ...(conversation.answeredInputIds || [])]);
  const pendingIds = new Set((conversation.pendingInputs || []).map(item => item.entryId || item.id));
  for (const item of queuedMessages.value) {
    if (applied.has(item.id)) acknowledgedInputs.set(item.id, 'applied');
    else if (pendingIds.has(item.id) && !acknowledgedInputs.has(item.id)) acknowledgedInputs.set(item.id, 'queued');
  }
  queuedMessages.value = queuedMessages.value.filter(item => !applied.has(item.id) && acknowledgedInputs.get(item.id) !== 'applied');
  // An input leaving the inbox may have been cancelled, or may be outside the
  // visible history window. Resolve its native receipt before discarding it.
  for (const item of queuedMessages.value) {
    if (item.status === 'queued' && !pendingIds.has(item.id)) void refreshPendingReceipt(item);
  }
  for (const item of conversation.pendingInputs || []) {
    const id = item.entryId || item.id;
    if (['applied', 'cancelled'].includes(acknowledgedInputs.get(id) || '')) continue;
    const existing = queuedMessages.value.find(input => input.id === id);
    if (existing) { existing.status = 'queued'; existing.error = undefined; existing.mode = item.mode || 'steer'; existing.submissionId = item.submissionId ?? existing.submissionId; }
    else queuedMessages.value.push({ id, submissionId: item.submissionId, prompt: item.content, attachments: item.attachments || [], mentions: item.mentions || [], status: 'queued', mode: item.mode || 'steer' });
  }
  emit('session', conversation.file);
}

const nativeReceiptChecks = new Map<string, AbortController>();
onScopeDispose(() => { for (const request of nativeReceiptChecks.values()) request.abort(); nativeReceiptChecks.clear(); });
async function refreshPendingReceipt(item: QueuedAgentMessage) {
  const file = nativeFile.value;
  if (!file || nativeDisposed || nativeReceiptChecks.has(item.id)) return;
  const request = new AbortController();
  const submissionId = item.submissionId;
  nativeReceiptChecks.set(item.id, request);
  item.status = 'failed'; item.error = translate('消息状态待确认，可重试');
  try {
    assertWorkspaceScope(conversationScope);
    const { data } = await axios.get('/api/agent/native/input', { params: { sessionFile: file, ...(submissionId === undefined ? { inputId: item.id } : { submissionId }) }, headers: { 'x-miaoimg-workspace': '1' }, signal: request.signal, timeout: 15000 });
    if (nativeDisposed || request.signal.aborted || nativeFile.value !== file) return;
    assertWorkspaceScope(conversationScope);
    const receipt = data?.data;
    if (data?.code !== 200 || receipt?.file !== file || (submissionId === undefined ? receipt?.inputId !== item.id : receipt?.submissionId !== submissionId)
      || !['queued', 'applied', 'unanswered'].includes(receipt?.status)
      || (receipt.status === 'queued' && !['steer', 'followUp'].includes(receipt.mode))) {
      throw new Error(translate('消息状态读取失败，原消息已保留，可重试'));
    }
    const current = queuedMessages.value.find(input => input.id === item.id);
    if (!current || ['applied', 'cancelled'].includes(acknowledgedInputs.get(item.id) || '')) return;
    if (receipt.status === 'applied') {
      acknowledgedInputs.set(item.id, 'applied');
      queuedMessages.value = queuedMessages.value.filter(input => input.id !== item.id);
    } else if (receipt.status === 'unanswered') {
      acknowledgedInputs.set(item.id, 'cancelled');
      current.status = 'cancelled'; current.error = translate('这条提交已结束，移回输入框后可重新发送');
    } else {
      acknowledgedInputs.set(item.id, 'queued');
      if (current.status === 'failed') { current.status = 'queued'; current.error = undefined; current.mode = receipt.mode; }
    }
  } catch (error) {
    if (nativeDisposed || request.signal.aborted || nativeFile.value !== file) return;
    const current = queuedMessages.value.find(input => input.id === item.id);
    if (current?.status === 'failed') current.error = (error as any)?.response?.data?.message || translate('消息状态读取失败，原消息已保留，可重试');
  } finally { if (nativeReceiptChecks.get(item.id) === request) nativeReceiptChecks.delete(item.id); }
}

async function loadOlderMessages() {
  const file = nativeFile.value || props.sessionFile;
  const before = historyCursor.value;
  if (!file || !before || olderLoading.value) return;
  olderLoading.value = true;
  const height = messageVirtualizer.value.getTotalSize(), offset = messageList.value?.scrollTop || 0;
  try {
    assertWorkspaceScope(conversationScope);
    const response = await axios.get('/api/agent/history', { params: { sessionFile: file, before }, headers: { 'x-miaoimg-workspace': '1' } });
    assertWorkspaceScope(conversationScope);
    if (response.data.code !== 200) throw new Error(response.data.message || '读取历史失败');
    const page = response.data.data;
    if ((page.historyRevision || 0) !== historyRevision || historyCursor.value !== before || nativeDisposed) return;
    const present = new Set(messages.value.map(message => message.id));
    const additions = hydrateMessages(page.messages).filter(message => !present.has(message.id));
    olderMessages.value = [...additions, ...olderMessages.value];
    messages.value = [...additions, ...messages.value];
    historyCursor.value = page.historyCursor;
    await nextTick();
    messageVirtualizer.value.scrollToOffset(offset + messageVirtualizer.value.getTotalSize() - height);
  } catch (error) { ElMessage.error((error as any)?.response?.data?.message || translate('读取历史未完成，请重试')); }
  finally { olderLoading.value = false; }
}

const nativeFile = ref(props.sessionFile);
let nativeObserver: AbortController | undefined;
let nativeObservation = 0;
let nativeObservedFile = '';
let nativeDisposed = false;
const nativeStaging = new Set<AbortController>();
let nativeObserverReady: { file: string; promise: Promise<string> } | undefined;
const nativeConnection = ref<'connected' | 'reconnecting'>('connected');
const disconnectedError = () => new Error(translate('对话连接已断开，请重新连接后再发送'));
function disconnectNative() {
  nativeObserver?.abort();
  for (const staging of nativeStaging) staging.abort(disconnectedError());
}
const onlineNative = () => { if (props.active && nativeFile.value) void observeNative(nativeFile.value); };
window.addEventListener('offline', disconnectNative);
window.addEventListener('online', onlineNative);
onScopeDispose(() => {
  nativeDisposed = true; nativeObservation++; disconnectNative();
  window.removeEventListener('offline', disconnectNative); window.removeEventListener('online', onlineNative);
});
watch([() => props.active, () => props.sessionFile], ([active, file]) => {
  const changed = nativeFile.value !== file;
  nativeFile.value = file;
  // Adopting the file just created by this send is not a view switch.
  if (!active || changed) { disconnectNative(); nativeObservation++; }
  if (active && file && props.initialSession?.nativeId) void observeNative(file);
}, { immediate: true });
async function connectedNativeObserver(file: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (nativeDisposed || !props.active || navigator.onLine === false) throw disconnectedError();
  void observeNative(file);
  const ready = nativeObserverReady;
  if (!ready || ready.file !== file) throw disconnectedError();
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason || disconnectedError());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const id = await Promise.race([ready.promise, interrupted]);
    signal.throwIfAborted();
    if (nativeDisposed || !props.active || nativeObserverReady !== ready) throw disconnectedError();
    return id;
  } finally { signal.removeEventListener('abort', abort); }
}
async function observeNative(file: string) {
  if (nativeDisposed || !props.active || navigator.onLine === false) return;
  if (nativeObservedFile === file && nativeObserver && !nativeObserver.signal.aborted) return;
  nativeObserver?.abort();
  const observer = new AbortController(), revision = ++nativeObservation;
  nativeObserver = observer;
  nativeObservedFile = file;
  let delay = 500;
  while (!observer.signal.aborted && props.active && revision === nativeObservation) {
    const observerId = crypto.randomUUID();
    let connected!: (id: string) => void, disconnected!: (error: Error) => void;
    const ready = { file, promise: new Promise<string>((resolve, reject) => { connected = resolve; disconnected = reject; }) };
    void ready.promise.catch(() => {});
    nativeObserverReady = ready;
    try {
      assertWorkspaceScope(conversationScope);
      const response = await fetch(`/api/agent/observe?sessionFile=${encodeURIComponent(file)}&observerId=${observerId}`, { headers: { 'x-miaoimg-workspace': '1' }, signal: observer.signal });
      if (!response.ok || !response.body) throw new Error(`读取任务失败（${response.status}）`);
      connected(observerId);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let pending = '', value: AgentConversation | undefined;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          if (nativeDisposed || observer.signal.aborted || revision !== nativeObservation) return;
          pending += chunk.value;
          const lines = pending.split('\n'); pending = lines.pop() || '';
          for (const line of lines) if (line.trim()) {
            const event = JSON.parse(line) as { type: string; conversation?: AgentConversation; ops?: Op[] };
            if (event.type === 'snapshot') value = event.conversation;
            else if (event.type === 'patch') value = applyImmutable<AgentConversation>(value, event.ops!);
            else continue;
            if (value) { reconcileConversation(value); nativeConnection.value = 'connected'; delay = 500; }
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    } catch (error) { if (observer.signal.aborted) return; console.warn('Agent 状态连接正在恢复', error); }
    finally { disconnected(disconnectedError()); if (nativeObserverReady === ready) nativeObserverReady = undefined; }
    if (!observer.signal.aborted) {
      nativeConnection.value = 'reconnecting';
      await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); observer.signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, delay); observer.signal.addEventListener('abort', done, { once: true }); });
      delay = Math.min(5000, delay * 2);
    }
  }
}
let nativeAdmission = Promise.resolve();
let nativeAdmissions = 0;
async function sendNative(input: QueuedAgentMessage, resendFrom = input.resendFrom, action?: 'compact') {
  const model = selectedModelChoice.value;
  if (!directory || !model || locked.value || input.status === 'sending' || input.status === 'cancelled') return;
  if (resendFrom) input.resendFrom = resendFrom;
  const staging = new AbortController();
  nativeStaging.add(staging);
  const canvasId = createCanvasContext?.()?.id;
  if (!canvasId) throw new Error(translate('画布正在打开，请稍候再发送'));
  const thinkingLevel = reasoningEffort.value || 'off', memoryEnabled = personalizationSettings.value.memoryEnabled;
  const previous = nativeAdmission;
  let release!: () => void;
  nativeAdmission = new Promise<void>(resolve => { release = resolve; });
  nativeAdmissions++;
  emit('admitting', true);
  input.status = 'sending'; input.error = undefined; busy.value = true;
  try {
    await previous; staging.signal.throwIfAborted(); assertWorkspaceScope(conversationScope);
    await uploadAttachments(input.attachments, directory, staging.signal);
    staging.signal.throwIfAborted(); assertWorkspaceScope(conversationScope);
    let file = nativeFile.value;
    if (!file) {
      const { data } = await axios.post('/api/agent/create', { directory }, { headers: { 'x-miaoimg-workspace': '1' } });
      if (data?.code !== 200) throw new Error(data?.message || '创建对话失败');
      if (typeof data.data?.file !== 'string' || !data.data.file.trim()) throw new Error(translate('未收到有效的对话回执，消息已保留，请重试'));
      file = data.data.file; nativeFile.value = file; emit('session', file!);
    }
    staging.signal.throwIfAborted(); assertWorkspaceScope(conversationScope);
    // The server must have the observing connection before text admission; a
    // refresh between these steps then rejects or stops this exact submission.
    const observerId = await connectedNativeObserver(file!, staging.signal);
    assertWorkspaceScope(conversationScope);
    const response = await axios.post('/api/agent/submit', { directory, sessionFile: file, observerId, inputId: input.id, prompt: input.prompt, mentions: input.mentions, attachments: input.attachments.map(({ name, path, mimeType }) => ({ name, path, mimeType })), providerId: model.providerId, modelId: model.modelId, thinkingLevel, memoryEnabled, canvas: { id: canvasId }, resendFrom, action }, { headers: { 'x-miaoimg-workspace': '1', 'Accept-Language': locale.value } });
    if (response.data?.code !== 200) throw new Error(response.data?.message || '发送失败');
    const receipt = response.data.data;
    // A successful HTTP response alone does not confirm admission. Keep the
    // original input and request ID until a native receipt or observer proves it.
    const receiptId = action === 'compact' ? receipt?.taskId : receipt?.submissionId;
    if (receipt?.file !== file || !Number.isSafeInteger(receiptId) || receiptId <= 0
      || (!action && (!['queued', 'applied', 'unanswered'].includes(receipt?.status)
        || (receipt.status === 'queued' && !['steer', 'followUp'].includes(receipt.mode))))) {
      throw new Error(translate(action === 'compact' ? '未收到有效的压缩回执，请查看任务状态' : '未收到有效的发送回执，结果待确认，可用原消息重试'));
    }
    const known = acknowledgedInputs.get(input.id);
    if (!action) input.submissionId = receipt.submissionId;
    const status = known === 'applied' || receipt?.status === 'applied' ? 'applied' : known === 'cancelled' || receipt?.status === 'unanswered' ? 'cancelled' : 'queued';
    acknowledgedInputs.set(input.id, status);
    if (status === 'cancelled') {
      input.status = 'cancelled'; input.error = translate('这条提交已结束，移回输入框后可重新发送');
      if (!queuedMessages.value.some(item => item.id === input.id)) queuedMessages.value.push(input);
      return;
    }
    input.status = 'queued';
    if (status === 'applied') {
      queuedMessages.value = queuedMessages.value.filter(item => item.id !== input.id);
    } else if (receipt?.mode) input.mode = receipt.mode;
    void observeNative(file!);
    emit('sent', mentionPlainText(input.prompt, input.mentions) || input.attachments[0]?.name || '新对话');
    if (!action) { await nextTick(); messageVirtualizer.value.scrollToEnd(); }
  } catch (error) {
    const receipt = acknowledgedInputs.get(input.id);
    if (receipt) {
      if (receipt === 'applied') queuedMessages.value = queuedMessages.value.filter(item => item.id !== input.id);
      input.status = receipt === 'cancelled' ? 'cancelled' : 'queued';
      input.error = receipt === 'cancelled' ? translate('这条提交已结束，移回输入框后可重新发送') : undefined;
      return;
    }
    input.status = 'failed'; input.error = (error as any)?.response?.data?.message || (error instanceof Error ? error.message : translate('发送结果待确认，可用同一条消息重试'));
    if (action === 'compact') {
      ElMessage.error(input.error);
      if (nativeFile.value) void observeNative(nativeFile.value);
    } else if (!queuedMessages.value.some(item => item.id === input.id)) queuedMessages.value.push(input);
  } finally { nativeStaging.delete(staging); nativeAdmissions--; busy.value = nativeAdmissions > 0; emit('admitting', nativeAdmissions > 0); release(); }
}

async function guidePendingInput(item: QueuedAgentMessage) {
  if (item.status === 'cancelled') return updatePendingInput(item, 'edit');
  if (item.status === 'queued') return updatePendingInput(item, 'steer');
  if (item.submissionId !== undefined) return refreshPendingReceipt(item);
  return sendNative(item);
}
async function updatePendingInput(item: QueuedAgentMessage, action: 'steer' | 'followUp' | 'withdraw' | 'edit') {
  if (pendingInputAction.value || item.status === 'sending' || locked.value) return;
  if (action === 'edit' && hasDraft.value) return;
  pendingInputAction.value = item.id;
  try {
    if (acknowledgedInputs.get(item.id) === 'applied') {
      queuedMessages.value = queuedMessages.value.filter(input => input.id !== item.id);
      ElMessage.info(translate('这条消息已接入任务，无法再调整')); return;
    }
    if (nativeFile.value && (item.status === 'queued' || item.status === 'failed')) {
      assertWorkspaceScope(conversationScope);
      const { data } = await axios.post('/api/agent/native/input', { directory, sessionFile: nativeFile.value, inputId: item.id, submissionId: item.submissionId, action: action === 'edit' ? 'withdraw' : action }, { headers: { 'x-miaoimg-workspace': '1' } }).catch(error => {
        if (error.response?.status === 404 && (action === 'withdraw' || action === 'edit')) return { data: { code: 200, data: { status: 'aborted' } } };
        throw error;
      });
      if (data.code !== 200) throw new Error(data.message || '补充消息操作未完成');
      if (['already_placed', 'placed', 'done'].includes(data.data.status)) {
        acknowledgedInputs.set(item.id, 'applied');
        queuedMessages.value = queuedMessages.value.filter(input => input.id !== item.id);
        ElMessage.info(translate('这条消息已接入任务，无法再调整')); return;
      }
      if (action === 'steer' || action === 'followUp') {
        if (data.data.status === 'queued') item.mode = data.data.mode || action;
        else ElMessage.info(translate('这条消息已接入任务，无法再调整'));
        return;
      }
      if (data.data.status !== 'aborted') { ElMessage.info(translate('这条消息已接入任务，无法撤回')); return; }
    }
    acknowledgedInputs.set(item.id, 'cancelled');
    if (action === 'edit') {
      item.status = 'cancelled'; item.error = translate('这条提交已结束，移回输入框后可重新发送');
      if (!queuedMessages.value.some(input => input.id === item.id)) queuedMessages.value.push(item);
      // Withdrawal may finish after the user has started a new draft, or after
      // the observer has removed this input. Keep both texts until it can move.
      if (hasDraft.value || locked.value || !sender) {
        ElMessage.info(translate('消息已撤回并保留，请在输入框空闲后移回编辑')); return;
      }
      draftAttachments.value = item.attachments.map(attachment => ({ ...attachment }));
      await fillPrompt(item.prompt, item.mentions);
    }
    queuedMessages.value = queuedMessages.value.filter(input => input.id !== item.id);
  } catch (error) { ElMessage.error((error as any)?.response?.data?.message || (error instanceof Error ? error.message : translate('补充消息操作未完成'))); }
  finally { pendingInputAction.value = undefined; }
}

function receiveEvent(event: AgentEvent) {
  if (event.type === "done" || event.type === "error") {
    remoteRunning.value = false;
    compacting.value = false;
    retrying.value = undefined;
    for (const item of queuedMessages.value) if (item.status === 'queued') { item.status = 'failed'; item.error = translate('本轮已结束，这条补充尚未处理'); }
  } else if (["userMessage", "text", "thinking", "tool"].includes(event.type)) remoteRunning.value = true;
  applyEvent(event);
}

defineExpose({ receiveEvent });

function getDraftContent() {
  return sender?.getModel().map((line, lineIndex) => line.map((tag, tagIndex) => {
    if (tag.type === "Mention") return `{{mention:${tag.id}}}`;
    if (tag.type === "Write") return tag.text;
    return sender?.chatEditor.NODES[lineIndex]?.children[tagIndex]?.$el.textContent ?? "";
  }).join("")).join("\n").replace(/[\ufeff\u200b]/g, "") ?? "";
}

function captureMentionPosition() {
  const node = sender?.getCurrentNode();
  mentionPosition = node?.instance?.$el.isConnected ? { node: { ...node }, remove: mentionQuery.value === undefined ? 0 : mentionQuery.value.length + 1 } : undefined;
  skillQuery.value = undefined;
}

function updateMentionQuery() {
  if (!sender || insertingMentions || sender.chatEditor.isComposition || !sender.chatElement.richText.contains(sender.getSelection().anchorNode)) return;
  const current = sender.getCurrentNode();
  const before = current?.instance?.type === "Write" ? current.instance.text.slice(0, current.offset) : "";
  mentionQuery.value = /(?:^|[^\w@])@([^\s@]*)$/.exec(before)?.[1];
  if (mentionQuery.value !== undefined) captureMentionPosition();
}

function handleSenderKeydown(event: KeyboardEvent) {
  const id = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-agent-mention]")?.dataset.agentMention : undefined;
  if (id && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    draftMentionPreview.value?.preview(id);
    return;
  }
  if (mentionMenuRef.value?.handleKeydown(event)) return;
  skillMenuRef.value?.handleKeydown(event);
}

async function insertMentions(mentions: AgentMention[]) {
  const instance = sender;
  if (!instance || locked.value || !props.active) return;
  const currentIds = new Set(instance.getTagData().mention.map(item => item.id));
  if (currentIds.size + mentions.length > 20) return ElMessage.warning(translate("每条消息最多提及 20 个输出或素材"));
  insertingMentions = true;
  try {
    if (mentionPosition?.node.instance.$el.isConnected) mentionPosition.node.instance.focus(mentionPosition.node.offset);
    else instance.focus("last");
    if (mentionPosition?.remove) await instance.backspace(-mentionPosition.remove);
    for (const mention of mentions) {
      if (sender !== instance || !props.active) break;
      draftMentions.value.push(mention);
      await instance.setMention({ id: mention.id, name: mentionName(mention) });
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("添加提及失败"));
  } finally {
    mentionQuery.value = undefined;
    mentionPosition = undefined;
    insertingMentions = false;
  }
}

async function removeDraftMention(id: string) {
  if (!locked.value) await sender?.removeMention([id]);
}

function submitMessage() {
  if (editingSource.value) return sendMessage(messages.value.find(item => item.id === editingId.value) || editingSource.value);
  if (turnRunning.value) {
    queueDraftMessage();
    return;
  }
  return sendMessage();
}

function hasDraftToSend() {
  return Boolean(getDraftContent().trim() || draftAttachments.value.length);
}

function queueDraftMessage() {
  const instance = sender;
  if (!instance || !props.active || locked.value) return;
  const prompt = getDraftContent().trim();
  const attachments = draftAttachments.value.map(item => ({ ...item }));
  const mentionedIds = instance.getTagData().mention.map(mention => mention.id);
  const mentions = draftMentions.value.filter(mention => mentionedIds.includes(mention.id)).map(mention => ({ ...mention }));
  if (mentionedIds.some(id => !mentions.some(mention => mention.id === id))) return ElMessage.warning(translate("存在无法读取的提及，请删除后重新选择"));
  if (!prompt && !attachments.length) return;
  const input: QueuedAgentMessage = { id: crypto.randomUUID(), prompt, attachments, mentions, status: 'waiting' };
  queuedMessages.value.push(input);
  draftAttachments.value = [];
  draftMentions.value = [];
  void instance.reset();
  void sendNative(queuedMessages.value[queuedMessages.value.length - 1]!);
}

async function compactContext() {
  contextMenuVisible.value = false;
  return sendNative({ id: crypto.randomUUID(), prompt: '', attachments: [], mentions: [], status: 'waiting' }, undefined, 'compact');
}

watch(() => props.sessionFile, () => { if (busy.value) for (const item of queuedMessages.value) if (item.status === 'waiting') void sendNative(item); });

async function selectSkill(name: string) {
  const instance = sender;
  if (!instance || locked.value) return;
  const model = instance.getModel();
  const first = model[0]?.[0];
  if (first?.type === "Write") first.text = `/skill:${name} ${first.text.replace(skillQuery.value !== undefined ? /^\/\S*/ : /^\s*\/skill:\S+(?:\s+|$)/, "")}`;
  if (!model.length) model.push([]);
  if (first?.type !== "Write") model[0]!.unshift({ type: "Write", text: `/skill:${name} ` });
  skillQuery.value = undefined;
  mentionMenuRef.value?.closeMenu();
  await instance.reset({ clearHistory: false, chatNode: model });
  if (sender === instance) instance.focus("last");
}

function promptModel(prompt: string, mentions: AgentMention[] = []): AnyTagProps[][] {
  return prompt.split("\n").map(line => mentionParts(line, mentions).map(part => part.mention
    ? { type: "Mention", id: part.mention.id, name: mentionName(part.mention) } : { type: "Write", text: part.text }));
}

async function fillPrompt(prompt: string, mentions: AgentMention[] = []) {
  const instance = sender;
  if (!instance || locked.value) return;
  draftMentions.value = mentions.map(mention => ({ ...mention }));
  await instance.reset({ clearHistory: false, chatNode: promptModel(prompt, mentions) });
  if (sender === instance) instance.focus("last");
}

async function copyMessage(content: string) {
  try {
    await writeClipboardText(content);
    ElMessage.success(translate("已复制"));
  } catch {
    ElMessage.error(translate("复制失败，请重试"));
  }
}

async function editMessage(item: AgentMessage) {
  const instance = sender;
  if (!instance || locked.value || turnRunning.value || item.role !== "user") return;
  if (!editingId.value) editDraft = { content: getDraftContent(), model: instance.getModel(), mentions: [...draftMentions.value], attachments: [...draftAttachments.value] };
  editingSource.value = item;
  draftMentions.value = [...item.mentions ?? []];
  draftAttachments.value = [...item.attachments ?? []];
  mentionMenuRef.value?.closeMenu();
  await instance.reset({ chatNode: promptModel(item.content, item.mentions) });
  if (sender === instance) instance.focus("last");
}

async function restoreEditingDraft() {
  const draft = editDraft;
  editDraft = undefined;
  editingSource.value = undefined;
  draftMentions.value = draft?.mentions ?? [];
  draftAttachments.value = draft?.attachments ?? [];
  await sender?.reset({ chatNode: draft?.model });
}

async function cancelEdit() {
  if (busy.value || deletingId.value !== undefined) return;
  await restoreEditingDraft();
}

async function deleteMessage(item: AgentMessage) {
  if (locked.value || turnRunning.value || item.streaming || item.report) return;
  deletingId.value = item.id;
  try {
    if (item.entryId || item.replyTo) {
      if (!directory || !props.sessionFile) throw new Error(translate("请重新打开对话后再删除"));
      const { data } = await axios.delete<{ code: number; data: AgentConversation; message?: string }>("/api/agent/message", {
        data: {
          directory, sessionFile: props.sessionFile,
          ...(item.replyTo ? { replyTo: item.replyTo } : { entryIds: [item.entryId!] }),
        },
        headers: { "x-miaoimg-workspace": "1" },
      });
      if (data.code !== 200) throw new Error(data.message || "删除消息失败");
      reconcileConversation(data.data); void observeNative(props.sessionFile!);
    }
    messages.value = messages.value.filter(message => message.id !== item.id);
  } catch (error) {
    const message = axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message : undefined;
    ElMessage.error(message || (error instanceof Error ? error.message : translate("删除消息失败")));
  } finally {
    deletingId.value = undefined;
  }
}

function setSenderHeight(height: number) {
  if (!sender) return;
  senderMaxHeight.value = Math.max(64, window.innerHeight / 2);
  senderHeight.value = Math.max(64, Math.min(senderMaxHeight.value, Math.round(height)));
  sender.chatElement.rollBox.style.height = `${senderHeight.value}px`;
}

function startSenderResize(event: PointerEvent) {
  if (event.button !== 0 || senderResize || !sender) return;
  event.preventDefault();
  senderResize = { pointerId: event.pointerId, y: event.clientY, height: sender.chatElement.rollBox.getBoundingClientRect().height };
  senderHeight.value = senderResize.height;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function moveSenderResize(event: PointerEvent) {
  if (senderResize?.pointerId !== event.pointerId) return;
  setSenderHeight(senderResize.height + senderResize.y - event.clientY);
}

function stopSenderResize(event: PointerEvent) {
  if (senderResize?.pointerId === event.pointerId) senderResize = undefined;
}

async function stopMessage() {
  if (stopping.value) return;
  stopping.value = true;
  // Cancel uploads and sends which have not reached admission. An already
  // submitted request keeps its receipt; stop it after admission settles so
  // a late acknowledgement cannot start work after the Stop response.
  for (const staging of nativeStaging) staging.abort(new Error(translate('发送已取消，可重试或撤回')));
  try {
    await nativeAdmission;
    if (!nativeFile.value) return;
    assertWorkspaceScope(conversationScope);
    await axios.post('/api/agent/native/stop', { directory, sessionFile: nativeFile.value }, { headers: { 'x-miaoimg-workspace': '1' } });
  }
  catch (error) { ElMessage.error((error as any)?.response?.data?.message || translate('停止未完成，请重试')); }
  finally { stopping.value = false; }
}

async function uploadAttachments(attachments: AgentAttachment[], directory: string, signal: AbortSignal) {
  if (!attachments.some(item => item.file)) return;
  const files = useWorkspaceFiles(directory);
  for (const path of ["assets", "assets/chat"]) {
    await files.mkdir(path).catch(error => {
      if (error?.response?.data?.data?.code !== "EEXIST") throw error;
    });
    signal.throwIfAborted();
  }
  for (const attachment of attachments) {
    if (!attachment.file) continue;
    const extension = attachment.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0].toLowerCase() ?? "";
    const path = `assets/chat/${crypto.randomUUID()}${extension}`;
    await files.write(path, attachment.file, true, signal);
    attachment.path = path;
    attachment.file = undefined;
    signal.throwIfAborted();
  }
}

async function sendMessage(source?: AgentMessage, queued?: QueuedAgentMessage) {
  const instance = sender;
  const editing = source && editingId.value === source.id;
  const prompt = (queued?.prompt ?? (source && !editing ? source.content : getDraftContent())).trim();
  const attachments = reactive((queued?.attachments ?? (source && !editing ? source.attachments ?? [] : draftAttachments.value)).map(item => ({ ...item })));
  const mentionedIds = queued ? queued.mentions.map(mention => mention.id) : source && !editing ? (source.mentions ?? []).filter(mention => prompt.includes(`{{mention:${mention.id}}}`)).map(mention => mention.id)
    : instance?.getTagData().mention.map(mention => mention.id) ?? [];
  const references = queued ? queued.mentions : source && !editing ? source.mentions ?? [] : draftMentions.value;
  const mentions = queued ? queued.mentions.map(mention => ({ ...mention })) : references.filter(mention => mentionedIds.includes(mention.id)).map(mention => ({ ...mention }));
  if (mentionedIds.some(id => !mentions.some(mention => mention.id === id))) return ElMessage.warning(translate("存在无法读取的提及，请删除后重新选择"));
  if (!source && editingId.value !== undefined) return;
  const resendIndex = source ? messages.value.findIndex(item => item.id === source.id) : -1;
  if (source && (source.role !== "user" || resendIndex < 0 && !(editing && source === editingSource.value))) return;
  if (source && turnRunning.value) return ElMessage.warning(translate("当前任务仍在执行，请先停止再重发编辑内容"));
  if (locked.value || busy.value || !instance || (!prompt && !attachments.length)) return;
  if (!directory) return ElMessage.warning(translate("请先打开项目"));
  if (!selectedModelChoice.value) return ElMessage.warning(translate("请先选择模型"));
  if (!createCanvasContext?.()?.id) return ElMessage.warning(translate("画布正在打开，请稍候再发送"));
  const input: QueuedAgentMessage = { id: queued?.id || crypto.randomUUID(), prompt, attachments, mentions, status: 'waiting', ...(source ? { resendFrom: source.entryId || source.id } : {}) };
  if (!queuedMessages.value.some(item => item.id === input.id)) queuedMessages.value.push(input);
  const pending = sendNative(input);
  if (!source) { draftAttachments.value = []; draftMentions.value = []; await instance.reset(); }
  else await restoreEditingDraft();
  return pending;
}

async function restoreTextAttachment(index: number) {
  const instance = sender;
  const attachment = draftAttachments.value[index];
  if (!instance || locked.value || !props.active || attachment?.mimeType !== "text/plain") return;
  restoringAttachment.value = true;
  try {
    const text = await readTextAttachment(attachment, directory);
    if (sender !== instance || !props.active || props.disabled || !draftAttachments.value.includes(attachment)) return;
    instance.focus("last");
    await instance.setText(`${instance.isEmpty(false) ? "" : "\n"}${text}`);
    if (sender === instance) draftAttachments.value = draftAttachments.value.filter(item => item !== attachment);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("还原文本附件失败，请重试"));
  } finally {
    restoringAttachment.value = false;
  }
}

function appendAttachments(files: File[]) {
  if (locked.value) return;
  for (const file of files) {
    if (!/^(image|video)\//.test(file.type) && file.type !== "text/plain") {
      ElMessage.warning(translate("只支持图片、视频和纯文本文件"));
      continue;
    }
    if (!file.size || file.size > 100 * 1024 * 1024) {
      ElMessage.warning(translate("附件不能为空且不能超过 100 MB"));
      continue;
    }
    if (file.type === "text/plain" && file.size > 400000) {
      ElMessage.warning(translate("文本附件不能超过 400000 字节"));
      continue;
    }
    if (draftAttachments.value.length >= 20) {
      ElMessage.warning(translate("每条消息最多添加 20 个附件"));
      break;
    }
    draftAttachments.value.push({ name: file.name, path: "", mimeType: file.type, file });
  }
}

function selectAttachments(event: Event) {
  const input = event.target as HTMLInputElement;
  appendAttachments(Array.from(input.files ?? []));
  input.value = "";
}

function pasteAttachments(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (!files.length) {
    try {
      const file = createPastedTextFile(event.clipboardData?.getData("text/plain") ?? "");
      if (file) files.push(file);
    } catch (error) {
      event.preventDefault();
      event.stopImmediatePropagation();
      ElMessage.warning(error instanceof Error ? error.message : translate("无法添加文本附件"));
      return;
    }
  }
  if (!files.length) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  appendAttachments(files);
}

watch(senderElement, (element, _previous, onCleanup) => {
  if (!element) return;
  const instance = new xSender(element, {
    autoFocus: false,
    placeholder: senderPlaceholder(),
    chatStyle: { minHeight: "64px", maxHeight: "50vh", fontSize: "14px", lineHeight: "24px" },
    keyboardSendFun: event => event.key === "Enter" && !event.shiftKey && !event.isComposing,
    keyboardWrapFun: event => event.key === "Enter" && event.shiftKey && !event.isComposing,
  });
  sender = instance;
  if (!props.active || locked.value) instance.disable();
  // 构造器的自动聚焦早于 getSelection 初始化；等实例就绪再设置光标。
  void instance.nextTick(async () => {
    if (sender !== instance) return;
    const draft = props.initialDraft;
    if (draft && !pendingMessage) {
      draftAttachments.value = draft.attachments.map(item => ({ ...item }));
      draftMentions.value = draft.mentions.map(item => ({ ...item }));
      await instance.reset({ clearHistory: false, chatNode: promptModel(draft.content, draft.mentions) });
    }
    if (sender === instance && props.active && !locked.value) instance.focus("last");
  });
  instance.bus.on("agentConversation", xSender.EventSet.EVENT_COMMON_SEND, () => void submitMessage());
  instance.bus.on("agentConversation", xSender.EventSet.EVENT_COMMON_CHANGE, () => {
    draftRevision.value += 1;
    skillQuery.value = /^\/([^\s/]*)$/.exec(instance.getText())?.[1];
    const targets: typeof draftMentionTargets.value = [];
    for (const line of instance.chatEditor.NODES) for (const tag of line.children) {
      if (tag.type !== "Mention") continue;
      tag.$el.dataset.agentMention = tag.id;
      tag.$el.setAttribute("role", "button");
      tag.$el.setAttribute("tabindex", "0");
      tag.$el.setAttribute("aria-label", t`预览 ${tag.name}`);
      const mention = draftMentions.value.find(item => item.id === tag.id);
      if (!mention || !mentionThumbnailProps(mention).thumbnail) continue;
      const content = tag.$el.querySelector<HTMLElement>(".chat-tag-mention");
      if (!content) continue;
      let element = content.querySelector<HTMLElement>(".agentMentionThumbnail");
      if (!element) {
        element = document.createElement("span");
        element.className = "agentMentionThumbnail";
        const label = document.createElement("span");
        label.className = "agentMentionLabel";
        label.textContent = content.textContent;
        content.replaceChildren(element, label);
      }
      targets.push({ key: draftMentionTargets.value.find(target => target.element === element)?.key ?? Symbol(), element, mention });
    }
    draftMentionTargets.value = targets;
    void instance.nextTick(() => { if (sender === instance) updateMentionQuery(); });
  });
  instance.bus.on("agentConversation", xSender.EventSet.EVENT_COMMON_TAG_CLICK, (tag: { type: string; id?: string }) => {
    if (tag.type === "Mention" && tag.id) draftMentionPreview.value?.preview(tag.id);
  });
  const editor = instance.chatElement.richText;
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", translate("消息"));
  editor.setAttribute("aria-multiline", "true");
  element.addEventListener("paste", pasteAttachments, true);
  const updateCursor = (event: Event) => { if (!(event instanceof KeyboardEvent) || event.key !== "Escape") updateMentionQuery(); };
  editor.addEventListener("keyup", updateCursor);
  editor.addEventListener("compositionend", updateCursor);
  onCleanup(() => {
    draftMentionTargets.value = [];
    sender = undefined;
    senderResize = undefined;
    element.removeEventListener("paste", pasteAttachments, true);
    editor.removeEventListener("keyup", updateCursor);
    editor.removeEventListener("compositionend", updateCursor);
    instance.destroy();
  });
});

watch(() => !props.initialSession?.parentFile && !!workspaceStore.pendingAgentMessage && props.active && !locked.value && !busy.value && !!senderElement.value && !!createCanvasContext?.(), async ready => {
  const message = workspaceStore.pendingAgentMessage;
  const instance = sender;
  if (!ready || !message || !instance || message.directory !== directory) return;
  workspaceStore.pendingAgentMessage = null;
  draftAttachments.value = [...message.attachments ?? []];
  await fillPrompt(message.prompt);
  if (sender === instance && props.active) void sendMessage();
}, { flush: "post" });
</script>

<style lang="scss">
.agentConversation .loadEarlierMessages { position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:1; }
.agentConversation .pendingInputs { display:flex;flex-direction:column;gap:7px;padding:10px 12px 0;max-height:180px;overflow:auto;overscroll-behavior:contain; }
.agentConversation .pendingInput { display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;align-items:center;gap:3px 4px;padding:7px 10px;border:1px solid var(--el-border-color-lighter);border-radius:10px;background:var(--el-fill-color-extra-light); }
.agentConversation .pendingInputCopy { min-width:0; }
.agentConversation .pendingInputText { display:block;overflow:hidden;text-overflow:ellipsis;font-size:12px;line-height:1.6;white-space:nowrap; }
.agentConversation .pendingInput .el-button+.el-button { margin-left:0; }
.agentConversation .pendingInputStatus { grid-column:1/-1;min-width:0;overflow-wrap:anywhere;font-size:11px;line-height:1.5;color:var(--el-text-color-secondary); }
.agentConversation .stopButton { width:32px;height:32px;flex:none;color:var(--el-text-color-primary);background:var(--el-fill-color); }
.agentConversation {
  --agent-content-width: 760px;
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  container-type: inline-size;

  .messageMarkdown [data-stream-markdown="table-wrapper"],
  .messageMarkdown [data-stream-markdown="code-block"] {
    min-width: 0;
    max-width: 100%;
  }

  .messageMarkdown table {
    width: max-content;
    min-width: 100%;
    max-width: none;
  }
  .messageMarkdown th, .messageMarkdown td {
    min-width: 6em;
    max-width: 24em;
    white-space: normal;
    word-break: normal;
    overflow-wrap: break-word;
  }

  .messageViewport {
    display: flex;
    flex-direction: column;
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    width: 100%;

    .messageList {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      overflow-anchor: none;
      scrollbar-gutter: stable;
    }

    .messageSpace {
      position: relative;
      width: 100%;
    }

    .scrollBottom {
      position: absolute;
      right: 16px;
      bottom: 12px;
      z-index: 1;
    }

    .welcomeMessage {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      max-width: 560px;
      margin: 0 auto;
      padding: 24px 16px 20px;
      box-sizing: border-box;
      text-align: center;
      color: var(--el-text-color-primary);
      .welcomeHeader { display: flex; flex-direction: column; align-items: center; gap: 16px; }
      .welcomeIcon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--el-fill-color-light); color: var(--el-text-color-primary); }
      .welcomeLogo { width: 24px; height: 24px; background: currentColor; mask-size: contain; mask-position: center; mask-repeat: no-repeat; }
      h3 { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; }
      .welcomeDescription { margin: 0; max-width: 30em; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
    }

    .messageRow {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      width: 100%;
      max-width: calc(var(--agent-content-width) + 40px);
      margin: 0 auto;
      box-sizing: border-box;
      padding: 8px 16px 20px;

      .messageActions {
        display: flex;
        align-items: center;
        gap: 4px;
        max-width: var(--agent-content-width);
        margin: 6px auto 0;

        .el-button {
          margin: 0;

          .tabler-icon {
            flex-shrink: 0;
          }
        }

        .messageAction {
          width: 24px;
          height: 24px;
          padding: 0;
          color: var(--el-text-color-secondary);
        }
      }

      &.userMessage .messageActions {
        justify-content: flex-end;
      }

      &.userMessage .messageBubble {
        width: fit-content;
        max-width: min(88%, var(--agent-content-width));
        margin-left: auto;
        margin-right: 0;
        padding: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
      }

      &.userMessage .messageContent {
        align-items: flex-end;
      }

      &.userMessage .messageText {
        text-align: left;
      }

      &.editingMessage .messageBubble {
        width: 100%;
        max-width: 100%;
        padding: 0;
        background: transparent;
      }

      &.toolOnlyMessage {
        padding: 4px 44px 8px 20px;

        .messageContent { gap: 6px; }

        .messageActions {
          position: absolute;
          top: 8px;
          right: 12px;
          margin: 0;
          opacity: 0;
          pointer-events: none;
        }

        &:hover .messageActions, &:focus-within .messageActions {
          opacity: 1;
          pointer-events: auto;
        }

        @media (hover: none) {
          .messageActions { opacity: 1; pointer-events: auto; }
        }
      }
    }

    .messageBubble {
      width: 100%;
      min-width: 0;
      max-width: var(--agent-content-width);
      margin: 0 auto;
      box-sizing: border-box;
    }

    .messageLoading {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
      color: var(--el-text-color-secondary);
      font-size: 13px;
    }

    .messageContent {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
      max-width: 100%;
      overflow-wrap: anywhere;
      color: var(--el-text-color-primary);

      .messageReasoning {
        --el-collapse-border-color: transparent;
        --el-collapse-header-bg-color: transparent;
        --el-collapse-content-bg-color: transparent;
        border: none;

        .el-collapse-item__header {
          height: auto;
          min-height: 24px;
          padding: 2px 0;
          gap: 6px;
          border: none;
          font-size: 13px;
          line-height: 20px;
        }

        .el-collapse-item__arrow {
          order: -1;
          width: 16px;
          margin: 0;
        }

        .el-collapse-item__wrap { border: none; }

        .el-collapse-item__content {
          padding: 4px 0 4px 22px;
          color: var(--el-text-color-secondary);
        }
      }

      .reasoningHeader {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--el-text-color-secondary);

        .thinkingDuration {
          font-variant-numeric: tabular-nums;
        }
      }

      .messageText {
        white-space: pre-wrap;
        font-size: 14px;
        line-height: 25px;
      }

      .messageError {
        color: var(--el-color-danger);
        padding: 10px 12px;
        border: 1px solid var(--el-color-danger-light-7);
        border-radius: 10px;
        background: var(--el-color-danger-light-9);
        font-size: 13px;
        line-height: 1.65;
      }

      .reportHeader {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--el-text-color-secondary);
        font-size: 12px;
      }

      .messageMarkdown {
        display: block;
        min-width: 0;
        max-width: 100%;
        font-size: 14px;
        line-height: 1.75;
      }
    }
  }

  .compactionStatus {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 6px;
    min-width: 0;
    width: calc(100% - 32px);
    max-width: var(--agent-content-width);
    margin: 0 auto 10px;
    overflow-wrap: anywhere;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .messageInput {
    --chat-text: var(--el-text-color-primary);
    --chat-text-placeholder: var(--el-text-color-placeholder);
    --chat-rect-padding: 10px;
    --chat-mention-text: var(--el-color-primary);
    position: relative;
    flex-shrink: 0;
    min-width: 0;
    width: calc(100% - 32px);
    max-width: var(--agent-content-width);
    margin: 0 auto 10px;
    box-sizing: border-box;
    border: 1px solid var(--el-border-color-light);
    border-radius: 20px;
    background: var(--el-bg-color);
    box-shadow: 0 3px 14px rgb(0 0 0 / 3%);

    &:focus-within {
      border-color: var(--el-color-primary-light-5);
      outline: none;
    }

    .senderResizeHandle {
      position: absolute;
      z-index: 12;
      top: -4px;
      right: 12px;
      left: 12px;
      height: 8px;
      border-radius: 4px;
      cursor: ns-resize;
      touch-action: none;
      user-select: none;

      &:focus-visible {
        outline: 2px solid var(--el-color-primary);
        outline-offset: 2px;
      }
    }

    .draftAttachments {
      padding: 12px 12px 0;
    }

    .composerSuggestions { display: flex; flex-wrap: wrap; gap: 5px; padding: 9px 9px 0; }
    .composerSuggestion.el-button { height: 27px; margin: 0; padding: 0 8px; border: 0; border-radius: 999px; background: var(--el-fill-color-light); color: var(--el-text-color-regular); font-size: 11px; }
    .composerSuggestion.el-button > span { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
    .composerSuggestion.el-button:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }

    .senderEditor {
      min-width: 0;
      max-width: 100%;
      overflow-wrap: anywhere;
    }

    .senderEditor .chat-placeholder-wrap {
      font-size: 14px;
      font-style: normal;
      line-height: 24px;
    }

    .editingBanner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 3px 12px;
      border-bottom: 0;
      color: var(--el-text-color-secondary);
      font-size: 12px;
    }

    .senderEditor .chat-tag-mention {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 100%;
      vertical-align: middle;
      border-radius: var(--el-border-radius-small);
      background: var(--el-color-primary-light-9);
      color: var(--el-color-primary);
      white-space: normal;
      overflow-wrap: anywhere;
      cursor: pointer;

      .agentMentionThumbnail {
        display: inline-flex;
        flex-shrink: 0;

        .mentionThumbnail { width: 24px; height: 24px; border-radius: 3px; }
      }
      .agentMentionLabel { min-width: 0; }
    }

    .senderActions {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 6px;
      min-width: 0;
      padding: 2px 8px 8px;

      > * { flex-shrink: 0; }

      > .el-button {
        margin-left: 0;
      }

      .attachmentButton {
        width: 28px;
        height: 28px;
        margin-right: 2px;
        padding: 0;
      }

      .modelPopover {
        flex: 1 1 0;
        min-width: 0;
        margin-right: auto;
      }

      .contextButton {
        width: 24px;
        height: 24px;
        margin: 0;
        padding: 0;

        &.is-text {
          background-color: transparent;
        }
      }

      .sendButton {
        width: 32px;
        height: 32px;
        border: none;
        flex: none;
      }
    }
  }

  @container (max-width: 360px) {
    .messageViewport .messageRow { padding: 6px 12px 20px; }
    .messageViewport .messageRow.toolOnlyMessage { padding: 4px 40px 8px 12px; }
    .messageViewport .messageRow.toolOnlyMessage .messageActions { right: 8px; }
    .messageViewport .messageRow.userMessage .messageBubble { max-width: 94%; }
    .messageInput, .compactionStatus { width: calc(100% - 20px); }
    .messageInput .senderActions { gap: 4px; padding-right: 8px; padding-left: 8px; }
  }
}
.agentContextPopover {
  .contextUsage {
    display: flex;
    flex-direction: column;
    gap: 12px;

    .contextStats {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .contextHeader,
    .contextTokens {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }

    .contextHeader {
      color: var(--el-text-color-primary);
    }

    .contextTokens {
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }

    .contextHint {
      color: var(--el-text-color-secondary);
      font-size: 12px;
    }
  }
}

/* 对话的常见形态：自己的消息是浅色气泡，助手的回复是正文；运行中只留一行状态。 */
.agentConversation {
  .messageViewport .messageRow {
    &.quietMessage {
      height: 0;
      padding: 0;
      overflow: hidden;
    }

    &.userMessage .messageBubble {
      padding: 9px 14px;
      border-radius: 12px;
      background: var(--el-fill-color);
    }

    &.userMessage .messageActions { opacity: 0; transition: opacity .15s; }
    &.userMessage:hover .messageActions, &.userMessage:focus-within .messageActions { opacity: 1; }
    @media (hover: none) { &.userMessage .messageActions { opacity: 1; } }
  }

  .agentActivity, .agentWorking {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: var(--el-text-color-secondary);
    font-size: 13px;
    line-height: 1.5;

    > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  }

  .agentActivity { padding: 2px 0; }

  .agentWorking {
    max-width: var(--agent-content-width);
    margin: 0 auto;
    padding: 0 20px 20px;
    box-sizing: border-box;
  }

  .activityPulse {
    display: inline-flex;
    flex-shrink: 0;
    gap: 3px;

    i {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
      opacity: .3;
      animation: agentPulse 1.2s ease-in-out infinite;

      &:nth-child(2) { animation-delay: .15s; }
      &:nth-child(3) { animation-delay: .3s; }
    }

    @media (prefers-reduced-motion: reduce) { i { animation: none; opacity: .6; } }
  }

  .pendingFollowUps {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: var(--agent-content-width);
    margin: 0 auto;
    padding: 0 20px 20px;
  }

  .pendingFollowUp {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;

    .pendingBubble {
      max-width: 88%;
      padding: 9px 14px;
      border: 1px dashed var(--el-border-color);
      border-radius: 16px 16px 4px 16px;
      color: var(--el-text-color-regular);
      font-size: 14px;
      line-height: 1.6;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .pendingMeta {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      align-items: center;
      gap: 2px 6px;
      color: var(--el-text-color-secondary);
      font-size: 12px;

      .el-button { height: 20px; margin: 0; padding: 0 4px; font-size: 12px; }
    }

    &[data-status="failed"] .pendingMeta > span { color: var(--el-color-danger); }
    &[data-status="cancelled"] .pendingBubble { opacity: .6; }
  }
}


.agentConversation.isEmpty {
  .messageList { display: flex; flex-direction: column; justify-content: flex-end; scrollbar-gutter: auto; }
  .agentEmptyState { flex: 0 0 auto; }
  .messageSpace { flex-shrink: 0; }
}

.agentConversation {
  .activityShimmer {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: linear-gradient(90deg, var(--el-text-color-secondary) 0%, var(--el-text-color-secondary) 40%, var(--el-text-color-primary) 50%, var(--el-text-color-secondary) 60%, var(--el-text-color-secondary) 100%);
    background-size: 300% 100%;
    background-clip: text;
    -webkit-background-clip: text;
    color: transparent;
    animation: agentShimmer 2.2s linear infinite;
    @media (prefers-reduced-motion: reduce) { animation: none; color: var(--el-text-color-secondary); }
  }
  .agentWorking .workingTime { flex-shrink: 0; color: var(--el-text-color-placeholder); font-variant-numeric: tabular-nums; }
}

.agentConversation .processDisclosure {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 4px;
  height: 24px;
  margin: 0 0 2px -6px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--el-text-color-secondary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;

  svg { transition: transform .15s; &.expanded { transform: rotate(90deg); } }
  &:hover { background: var(--el-fill-color-light); color: var(--el-text-color-regular); }
  &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
}
.agentConversation .processDivider { width: 100%; margin: 2px 0 8px; border-top: 1px solid var(--el-border-color-lighter); }

@keyframes agentShimmer {
  from { background-position: 100% 0; }
  to { background-position: 0 0; }
}

@keyframes agentPulse {
  0%, 80%, 100% { opacity: .25; transform: translateY(0); }
  40% { opacity: .9; transform: translateY(-2px); }
}
</style>
