import type { ProviderModelEntry } from "@/lib/providerModels";

// Provider endpoints, protocols and verified model metadata are adapted from
// CC Switch (MIT) commit e5b04221ff94b15d579281e89f5019b8ff1745ec.
// Source: https://github.com/farion1231/cc-switch
// Copyright (c) 2025 Jason Young. See docs/licenses/CC-SWITCH-PRESETS.txt.
export type ProviderPreset = {
  id: string;
  family: string;
  label: string;
  variant: string;
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages";
  apiUrl: string;
  models: ProviderModelEntry[];
};

const chats = (id: string, label: string, contextWindow: number, maxOutputTokens: number, reasoning = true, image = false, compat?: ProviderModelEntry["compat"]): ProviderModelEntry => ({
  id, label, contextWindow, maxOutputTokens, reasoning, input: image ? ["text", "image"] : ["text"], ...(compat ? { compat } : {}),
});

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai", family: "OpenAI", label: "OpenAI", variant: "API Key", protocol: "openai-responses", apiUrl: "https://api.openai.com/v1",
    models: [],
  },
  {
    id: "anthropic", family: "Anthropic", label: "Anthropic", variant: "API Key", protocol: "anthropic-messages", apiUrl: "https://api.anthropic.com/v1",
    models: [],
  },
  {
    id: "deepseek", family: "DeepSeek", label: "DeepSeek", variant: "按量付费", protocol: "openai-completions", apiUrl: "https://api.deepseek.com/v1",
    models: [
      chats("deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000, 384_000),
      chats("deepseek-flash", "DeepSeek V4.1 Flash", 1_000_000, 384_000, true, true),
    ],
  },
  {
    id: "kimi", family: "Kimi", label: "Kimi", variant: "国内按量付费", protocol: "openai-completions", apiUrl: "https://api.moonshot.cn/v1",
    models: [
      chats("kimi-k2.7-code", "Kimi K2.7 Code", 262_144, 262_144, true, true),
      chats("kimi-k3", "Kimi K3", 1_048_576, 131_072, true, true, { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens", supportsStrictMode: false, thinkingFormat: "openai", requiresReasoningContentOnAssistantMessages: true, deferredToolsMode: "kimi" }),
      chats("kimi-k2.7-code-highspeed", "Kimi K2.7 Code HighSpeed", 262_144, 262_144, true, true),
      chats("kimi-k2.6", "Kimi K2.6", 262_144, 262_144, true, true),
    ],
  },
  {
    id: "kimi-global", family: "Kimi", label: "Kimi Global", variant: "海外按量付费", protocol: "openai-completions", apiUrl: "https://api.moonshot.ai/v1",
    models: [
      chats("kimi-k2.7-code", "Kimi K2.7 Code", 262_144, 262_144, true, true),
      chats("kimi-k3", "Kimi K3", 1_048_576, 131_072, true, true, { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens", supportsStrictMode: false, thinkingFormat: "openai", requiresReasoningContentOnAssistantMessages: true, deferredToolsMode: "kimi" }),
      chats("kimi-k2.7-code-highspeed", "Kimi K2.7 Code HighSpeed", 262_144, 262_144, true, true),
      chats("kimi-k2.6", "Kimi K2.6", 262_144, 262_144, true, true),
    ],
  },
  {
    id: "kimi-coding", family: "Kimi", label: "Kimi For Coding", variant: "国内编程订阅", protocol: "anthropic-messages", apiUrl: "https://api.kimi.com/coding",
    models: [chats("kimi-for-coding", "Kimi For Coding", 262_144, 32_768, true, true)],
  },
  {
    id: "kimi-coding-global", family: "Kimi", label: "Kimi For Coding Global", variant: "海外编程订阅", protocol: "anthropic-messages", apiUrl: "https://api.kimi.ai/coding",
    models: [chats("kimi-for-coding", "Kimi For Coding", 262_144, 32_768, true, true)],
  },
  {
    id: "zhipu", family: "智谱 GLM", label: "Zhipu GLM", variant: "国内 Coding 套餐", protocol: "openai-completions", apiUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    models: [
      chats("glm-5.3", "GLM-5.3", 1_048_576, 131_072),
      chats("glm-5.3-flash", "GLM-5.3 Flash", 1_048_576, 131_072, true, true),
    ],
  },
  {
    id: "zhipu-global", family: "智谱 GLM", label: "Zhipu GLM Global", variant: "海外 Coding 套餐", protocol: "openai-completions", apiUrl: "https://api.z.ai/api/coding/paas/v4",
    models: [
      chats("glm-5.3", "GLM-5.3", 1_048_576, 131_072),
      chats("glm-5.3-flash", "GLM-5.3 Flash", 1_048_576, 131_072, true, true),
    ],
  },
  {
    id: "qwen", family: "通义千问", label: "千问 AI 平台", variant: "国内按量付费", protocol: "openai-completions", apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [chats("qwen3.8-max", "Qwen3.8 Max", 983_616, 131_072, true, true, { thinkingFormat: "qwen", supportsDeveloperRole: false })],
  },
  {
    id: "qwen-token", family: "通义千问", label: "千问 AI 平台", variant: "国内 Token Plan", protocol: "openai-completions", apiUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    models: [
      chats("qwen3.8-max", "Qwen3.8 Max", 983_616, 131_072, true, true, { thinkingFormat: "qwen", supportsDeveloperRole: false }),
      chats("qwen3.8-flash", "Qwen3.8 Flash", 983_616, 131_072, true, true, { thinkingFormat: "qwen", supportsDeveloperRole: false }),
    ],
  },
  {
    id: "qwencloud", family: "QwenCloud", label: "QwenCloud", variant: "海外按量付费", protocol: "openai-completions", apiUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    models: [
      chats("qwen3.8-max", "Qwen3.8 Max", 983_616, 131_072, true, true, { thinkingFormat: "qwen", supportsDeveloperRole: false }),
      chats("qwen3.8-flash", "Qwen3.8 Flash", 983_616, 131_072, true, true, { thinkingFormat: "qwen", supportsDeveloperRole: false }),
      chats("qwen3.7-max", "Qwen3.7 Max", 1_000_000, 131_072, true, false, { thinkingFormat: "qwen", supportsDeveloperRole: false }),
    ],
  },
  {
    id: "qwencloud-coding", family: "QwenCloud", label: "QwenCloud For Coding", variant: "海外编程订阅", protocol: "anthropic-messages", apiUrl: "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic",
    models: [
      chats("qwen3.7-plus", "Qwen3.7 Plus", 1_000_000, 65_536, true, true),
      chats("qwen3-coder-plus", "Qwen3 Coder Plus", 131_072, 65_536, false),
    ],
  },
  {
    id: "volcengine-agent", family: "火山方舟", label: "火山方舟", variant: "Agent Plan", protocol: "openai-completions", apiUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    models: [chats("ark-code-latest", "Ark Code Latest", 128_000, 16_384, false)],
  },
  {
    id: "volcengine-coding", family: "火山方舟", label: "火山方舟", variant: "Coding Plan", protocol: "openai-completions", apiUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    models: [chats("ark-code-latest", "Ark Code Latest", 128_000, 16_384, false)],
  },
  {
    id: "volcengine-doubao", family: "火山方舟", label: "火山方舟 · 豆包", variant: "按量付费", protocol: "openai-completions", apiUrl: "https://ark.cn-beijing.volces.com/api/v3",
    models: [chats("doubao-seed-2-1-pro-260628", "Doubao Seed 2.1 Pro", 128_000, 16_384, true, true)],
  },
  {
    id: "minimax", family: "MiniMax", label: "MiniMax", variant: "国内站", protocol: "openai-completions", apiUrl: "https://api.minimax.cn/v1",
    models: [
      chats("MiniMax-M3.1-Flash", "MiniMax M3.1 Flash", 1_000_000, 131_072, true, true),
      chats("MiniMax-M3", "MiniMax M3", 1_000_000, 131_072, true, true),
    ],
  },
  {
    id: "minimax-global", family: "MiniMax", label: "MiniMax Global", variant: "海外站", protocol: "openai-completions", apiUrl: "https://api.minimax.io/v1",
    models: [
      chats("MiniMax-M3.1-Flash", "MiniMax M3.1 Flash", 1_000_000, 131_072, true, true),
      chats("MiniMax-M3", "MiniMax M3", 1_000_000, 131_072, true, true),
    ],
  },
  {
    id: "openrouter", family: "OpenRouter", label: "OpenRouter", variant: "Anthropic 接口", protocol: "anthropic-messages", apiUrl: "https://openrouter.ai/api",
    models: [
      chats("anthropic/claude-sonnet-5", "Claude Sonnet 5", 1_000_000, 128_000, true, true, { forceAdaptiveThinking: true }),
      chats("anthropic/claude-opus-5", "Claude Opus 5", 1_000_000, 128_000, true, true, { forceAdaptiveThinking: true }),
    ],
  },
  {
    id: "opencode-go", family: "OpenCode", label: "OpenCode Go", variant: "编程订阅", protocol: "openai-completions", apiUrl: "https://opencode.ai/zen/go/v1",
    models: [
      chats("glm-5.2", "GLM 5.2", 1_000_000, 131_072),
      chats("kimi-k2.7-code", "Kimi K2.7 Code", 262_144, 262_144, true, true),
      chats("deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000, 384_000),
      chats("deepseek-v4-flash", "DeepSeek V4 Flash", 1_000_000, 384_000),
      chats("mimo-v2.5-pro", "MiMo V2.5 Pro", 1_048_576, 131_072),
    ],
  },
  {
    id: "ollama", family: "本地模型", label: "Ollama", variant: "本机", protocol: "openai-completions", apiUrl: "http://localhost:11434/v1",
    models: [
      chats("qwen3.5", "Qwen3.5", 262_144, 32_768, true, true),
      chats("gpt-oss:20b", "GPT-OSS 20B", 131_072, 65_536),
    ],
  },
  {
    id: "lmstudio", family: "本地模型", label: "LM Studio", variant: "本机", protocol: "openai-completions", apiUrl: "http://localhost:1234/v1",
    models: [chats("openai/gpt-oss-20b", "GPT-OSS 20B", 131_072, 32_768, true, false, { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" })],
  },
  {
    id: "custom", family: "自定义", label: "自定义配置", variant: "手动填写", protocol: "openai-completions", apiUrl: "",
    models: [],
  },
];
