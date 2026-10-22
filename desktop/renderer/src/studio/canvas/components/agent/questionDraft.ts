import type { InjectionKey } from "vue";
import type { AgentConversation, AgentQuestionDraft } from "../../agentTypes";
import type { AgentToolCall } from "../../agentEvents";

export const questionDraftsKey: InjectionKey<Record<string, AgentQuestionDraft>> = Symbol("agentQuestionDrafts");

export function cloneQuestionDraft(draft: AgentQuestionDraft): AgentQuestionDraft {
  return { ...draft, values: Object.fromEntries(Object.entries(draft.values).map(([id, value]) => [id, Array.isArray(value) ? [...value] : value])) };
}

export function clearQuestionToolDrafts(drafts: Record<string, AgentQuestionDraft>, tool: AgentToolCall) {
  if (tool.name !== "askUser" || tool.status === "running") return;
  for (const [callId, draft] of Object.entries(drafts)) {
    if (draft.toolId === tool.id) delete drafts[callId];
  }
}

export function clearEndedQuestionDrafts(drafts: Record<string, AgentQuestionDraft>, conversation: AgentConversation) {
  if (conversation.running === false) {
    for (const callId of Object.keys(drafts)) delete drafts[callId];
    return;
  }
  // History is a bounded window: absence from it does not end a question.
  for (const message of conversation.messages) for (const part of message.parts || []) {
    if (part.type === "tool") clearQuestionToolDrafts(drafts, part.tool);
  }
}
