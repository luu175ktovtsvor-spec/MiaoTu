import type { AgentToolCall, AgentStats, AgentContext, AgentSubAgent, AgentMention, AgentCompaction } from "./agentEvents";

export type AgentAttachment = { name: string; path: string; mimeType: string; file?: File };

export type AgentMessagePart =
  | { id: string; type: "text"; content: string }
  | { id: string; type: "thinking"; content: string; collapsed?: boolean; duration?: number }
  | { id: string; type: "tool"; tool: AgentToolCall; collapsed?: boolean };

export type AgentMessage = {
  id: string;
  entryId?: string;
  submissionId?: number;
  replyTo?: string;
  role: "user" | "assistant";
  content: string;
  attachments?: AgentAttachment[];
  mentions?: AgentMention[];
  parts?: AgentMessagePart[];
  streaming?: boolean;
  error?: string;
  report?: { file: string; name: string };
  mode?: 'steer' | 'followUp';
};

export type AgentPendingInput = { id: string; submissionId?: number; prompt: string; attachments: AgentAttachment[]; mentions: AgentMention[]; status: 'waiting' | 'sending' | 'queued' | 'failed' | 'cancelled'; mode?: 'steer' | 'followUp'; resendFrom?: string; error?: string };
export type AgentAnswerValue = string | number | boolean | (string | number)[];
export type AgentQuestionDraft = { selected: string; text: string; values: Record<string, AgentAnswerValue>; toolId?: string };
export type AgentDraft = {
  content: string; attachments: AgentAttachment[]; mentions: AgentMention[];
  pendingInputs?: AgentPendingInput[]; model?: string; reasoningEffort?: string;
  questionDrafts?: Record<string, AgentQuestionDraft>;
  editing?: { message: AgentMessage; original: { content: string; attachments: AgentAttachment[]; mentions: AgentMention[] } };
};

export type AgentHistory = { file: string; name: string; modified: string; messageCount: number };

export type AgentConversation = {
  engine?: "pi-durable";
  nativeId?: number;
  messageCount?: number;
  historyCursor?: string | null;
  historyRevision?: number;
  compacting?: boolean;
  retrying?: { source: "model" | "compaction"; attempt?: number };
  file: string;
  name: string;
  canvasId?: string;
  messages: AgentMessage[];
  providerId?: string;
  modelId?: string;
  thinkingLevel?: string;
  stats?: AgentStats;
  contextUsage?: AgentContext;
  lastCompaction?: AgentCompaction;
  lastFailure?: { taskId: number; message: string } | null;
  parentFile?: string;
  subAgents?: AgentSubAgent[];
  running?: boolean;
  pendingInputs?: AgentMessage[];
  answeredInputIds?: string[];
};
