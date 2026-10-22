import type { CanvasToolCall, QuestionRequest, ToolCall } from "@miaoimg/tools-scaffold/runtime";
import type { AgentConversation } from "./agentTypes";

export type AgentToolCall = ToolCall & { question?: QuestionRequest & { callId: string }; outcomeUnknown?: boolean };

export type AgentMention = {
  id: string;
  label: string;
  source:
    | { kind: "canvas"; canvasId: string; canvasName: string; nodeId: string; nodeName: string; outputId: string; outputName: string }
    | { kind: "asset"; path: string };
  dataType: string;
  value: unknown;
};

export type AgentStats = {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  tokensPerSecond?: number;
};

export type AgentContext = { tokens: number | null; contextWindow: number; percent: number | null };
export type AgentCompaction = { status: 'completed' | 'failed' | 'stopped' | 'skipped'; reason: 'manual' | 'threshold' | 'overflow'; tokensBefore?: number; tokensAfter?: number; createdAt?: string };

export type AgentSubAgent = {
  file: string;
  parentFile: string;
  name: string;
  task: string;
  status: "running" | "completed" | "error" | "limited" | "cancelled" | "inputRequired";
  result?: string;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
};

export type AgentEvent =
  | { type: "text" | "thinking"; blockId: string; delta?: string; content?: string; done?: boolean }
  | ({ type: "compaction"; active: boolean; willRetry?: boolean; contextUsage?: AgentContext } & Partial<AgentCompaction>)
  | { type: "retry"; active: boolean; source: 'model' | 'compaction'; attempt?: number; maxAttempts?: number; delayMs?: number }
  | { type: "tool"; blockId: string; tool: AgentToolCall }
  | ({ type: "canvasCall"; callId: string } & CanvasToolCall)
  | ({ type: "question"; callId: string; toolCallId: string } & QuestionRequest)
  | { type: "error"; message: string }
  | { type: "session"; file: string }
  | { type: "sessionSnapshot"; conversation: AgentConversation }
  | { type: "userMessage"; id: string; content?: string; attachments?: { name: string; path: string; mimeType: string }[]; mentions?: AgentMention[] }
  | { type: "subAgent"; agent: AgentSubAgent }
  | { type: "subAgentEvent"; file: string; event: AgentEvent }
  | { type: "report"; parentFile: string; file: string; name: string; content: string; id: string }
  | { type: "accepted" }
  | { type: "heartbeat" }
  | { type: "input"; id: string; status: "applied" }
  | { type: "status"; message: string }
  | { type: "stats"; stats: AgentStats; contextUsage?: AgentContext }
  | { type: "done" };
