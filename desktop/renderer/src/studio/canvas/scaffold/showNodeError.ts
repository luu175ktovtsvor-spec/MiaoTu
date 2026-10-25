import { h } from "vue";
import { ElMessage } from "element-plus";
import nodeError from "./components/nodeError.vue";
import { userFacingError, explainUserError } from "../../../../../../server/user-errors.ts";

export function showNodeError(error: unknown, title: string) {
  if (error instanceof Error && error.name === "AbortError") return;
  const typed = error as { response?: { data?: { message?: unknown; errorExplanation?: unknown } }; errorExplanation?: unknown; csrf?: string };
  const detail = typed?.response?.data?.message;
  const rawMessage = typeof detail === "string" && detail.trim() ? detail
    : error instanceof Error ? error.message : typeof error === "string" ? error : title;
  const status = Number((typed?.response as { status?: number } | undefined)?.status || (typed as { status?: number })?.status || 0);
  const message = userFacingError(rawMessage, { status });
  const supplied = typed?.errorExplanation || typed?.response?.data?.errorExplanation;
  const fallback = explainUserError(rawMessage, { status });
  const toExplanation = (value: unknown) => {
    if (!value || typeof value !== "object") return fallback;
    const source = value as Record<string, unknown>;
    if (source.version !== 1) return fallback;
    return { ...fallback, ...Object.fromEntries(["summary", "reason", "action", "billing", "requestId", "source", "aiToken"].map(key => [key, typeof source[key] === "string" ? String(source[key]).slice(0, 1000) : ""])) } as typeof fallback & { source?: string; aiToken?: string };
  };
  const initial = toExplanation(supplied);
  const show = (explanation: ReturnType<typeof toExplanation>) => {
    const controller = new AbortController();
    return ElMessage({
      type: "info",
      duration: 0,
      offset: 64,
      showClose: true,
      customClass: "nodeErrorMessage",
      message: h(nodeError, { message: explanation.summary || message || title, explanation, signal: controller.signal }),
      onClose: () => controller.abort(),
    });
  };
  const notice = show(initial);
  const token = typeof (initial as { aiToken?: string }).aiToken === "string" ? (initial as { aiToken?: string }).aiToken : "";
  const csrf = typeof typed?.csrf === "string" ? typed.csrf : "";
  if (!token || !csrf || (initial as { source?: string }).source === "ai") return;
  void fetch("./api/imagine/error-explanation", {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    credentials: "same-origin",
    body: JSON.stringify({ token }),
  }).then(async response => {
    const data = await response.json().catch(() => ({})) as { errorExplanation?: unknown };
    if (!response.ok || !data.errorExplanation) return;
    const explanation = toExplanation(data.errorExplanation);
    if ((explanation as { source?: string }).source !== "ai") return;
    notice.close();
    show(explanation);
  }).catch(() => {});
}

/** 未登录或登录失效时读不到模型列表：不弹错误，由选择框提示登录。 */
export function isSignInRequired(error: unknown) {
  const typed = error as { status?: number; response?: { status?: number } } | undefined;
  return Number(typed?.response?.status || typed?.status) === 401;
}
