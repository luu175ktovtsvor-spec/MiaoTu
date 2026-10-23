import {
  sectionEnglish,
  sectionDescriptionEnglish,
  adminText,
  opsStatusText,
  statusLabel,
  auditLabels,
  time,
  number,
  paymentTypeLabel,
  snapshotConclusionText,
} from "./i18n";
import { useAdminTheme, ThemeControl } from "./theme";
import { Modal, Badge, Empty } from "./components";
import { useAdminSession, isDiscardedAdminRequest } from "./useAdminSession";
import { useEffect, useRef, useState } from "react";
import {
  ChartBar,
  Users,
  SlidersHorizontal,
  Images,
  ListChecks,
  Receipt,
  ChatCircleText,
  SignOut,
  ArrowClockwise,
  Plus,
  MagnifyingGlass,
  DownloadSimple,
  ShieldCheck,
  Copy,
  Check,
  Database,
  List,
  CaretDoubleLeft,
  CaretDoubleRight,
  CaretDown,
  SquaresFour,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import { useLang } from "../i18n";
import LanguageControl from "../LanguageControl";
import "./admin.css";
import { version as APP_VERSION } from "../../../package.json";
import AdminGenerationDetail from "./AdminGenerationDetail";
import AdminTextCharges, { TextChargeSummary } from "./AdminTextCharges";
import AdminFeedback from "./AdminFeedback";
import AdminModelsSection from "./AdminModelsSection";
import AdminPricingEditor from "./AdminPricingEditor";
import { buildPricingDraft, type AdminModelRow } from "./modelPricing";
const sections = [
  ["overview", "运营概览", ChartBar],
  ["operations", "系统运维", Database],
  ["users", "用户管理", Users],
  ["models", "模型与价格", SlidersHorizontal],
  ["upstream", "上游用量", Database],
  ["generations", "生成记录", Images],
  ["payments", "充值管理", Receipt],
  ["feedback", "用户反馈", ChatCircleText],
  ["audit", "操作记录", ListChecks],
];
const externalDestinations = [
  {
    id: "site",
    zh: "妙图官网",
    en: "MiaoImg website",
    host: "miaoimg.cn",
    href: "https://miaoimg.cn",
  },
  {
    id: "changelog",
    zh: "更新日志",
    en: "Changelog",
    host: "miaoimg.cn/changelog",
    href: "https://miaoimg.cn/changelog",
  },
  {
    id: "update-feed",
    zh: "桌面更新源",
    en: "Desktop update feed",
    host: "miaoimg.cn/desktop-downloads/updates",
    href: "https://miaoimg.cn/desktop-downloads/updates/latest-mac.yml",
  },
  {
    id: "api",
    zh: "云枢 API",
    en: "Yunshu API",
    host: "api.zzyppz.cn",
    href: "https://api.zzyppz.cn",
  },
  {
    id: "yunshu-admin",
    zh: "云枢管理",
    en: "Yunshu admin",
    host: "admin.zzyppz.cn",
    href: "https://admin.zzyppz.cn",
  },
  {
    id: "dola-admin",
    zh: "Dola 管理",
    en: "Dola admin",
    host: "admin.zzyppz.cn/custom/yunshu-dola",
    href: "https://admin.zzyppz.cn/custom/yunshu-dola",
  },
  {
    id: "source",
    zh: "代码仓库",
    en: "Source repository",
    host: "github.com/luu175ktovtsvor-spec/miaoimg",
    href: "https://github.com/luu175ktovtsvor-spec/miaoimg",
  },
];
function readSection() {
  const key = window.location.hash.slice(1);
  return sections.some(([id]) => id === key) ? key : "overview";
}
function hasVideoExpenses(p: Record<string, unknown> = {}) {
  const known = (k) =>
    p[k] !== null &&
    p[k] !== undefined &&
    p[k] !== "" &&
    Number.isFinite(Number(p[k]));
  return (
    known("paymentFeePercent") &&
    known("otherRmbPerSecond") &&
    (p.serverAllocationMode === "all_media_requests"
      ? known("monthlyMediaRequests") && Number(p.monthlyMediaRequests) > 0
      : known("monthlyBillableVideoSeconds") &&
        Number(p.monthlyBillableVideoSeconds) > 0) &&
    (known("serverMonthlyRmb") ||
      (known("serverAnnualUsd") && known("usdToRmb") && Number(p.usdToRmb) > 0))
  );
}
export default function AdminPage() {
  const { lang } = useLang();
  const { choice, theme, choose } = useAdminTheme();
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [section, setSection] = useState(readSection);
  const [overview, setOverview] = useState(null),
    [operations, setOperations] = useState(null),
    [users, setUsers] = useState({ items: [], total: 0, page: 1, limit: 20 }),
    [records, setRecords] = useState<{
      items: any[];
      total: number;
      page: number;
      limit: number;
      summary?: Record<string, any>;
      reconciliation?: Record<string, any>;
    }>({ items: [], total: 0, page: 1, limit: 30 }),
    [paymentOrders, setPaymentOrders] = useState({
      items: [],
      total: 0,
      page: 1,
      limit: 30,
    }),
    [audits, setAudits] = useState({ items: [], total: 0, page: 1, limit: 30 });
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState(""),
    [userFilter, setUserFilter] = useState(""),
    [page, setPage] = useState(1),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [modal, setModal] = useState(null);
  const [kindFilter, setKindFilter] = useState(""),
    [modelFilter, setModelFilter] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false),
    [mobileNav, setMobileNav] = useState(false),
    [quickLinksOpen, setQuickLinksOpen] = useState(false),
    [listLoading, setListLoading] = useState(false);
  const quickLinksRef = useRef<HTMLDivElement>(null);
  const navigationGroups = [
    {
      label: lang === "en" ? "Workspace" : "业务管理",
      keys: ["overview", "users", "feedback", "generations", "payments"],
    },
    {
      label: lang === "en" ? "Configuration" : "配置与运维",
      keys: ["models", "upstream", "operations", "audit"],
    },
  ];
  function navigate(key) {
    setSection(key);
    setSearch("");
    setFilter("");
    setUserFilter("");
    setKindFilter("");
    setModelFilter("");
    setPage(1);
    setError("");
    setNotice("");
    setMobileNav(false);
    setQuickLinksOpen(false);
    setModal(null);
    setForm({});
    setCopied(false);
  }
  useEffect(() => {
    if (!quickLinksOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!quickLinksRef.current?.contains(event.target as Node))
        setQuickLinksOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setQuickLinksOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [quickLinksOpen]);
  useEffect(() => {
    const change = () => navigate(readSection());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  function selectSection(key) {
    if (window.location.hash === `#${key}`) navigate(key);
    else window.location.hash = key;
  }
  const priceBaseline = useRef(null);
  const [form, setForm] = useState<Record<string, any>>({}),
    [copied, setCopied] = useState(false),
    [upstream, setUpstream] = useState(null);
  const [pricingFocus, setPricingFocus] = useState("");
  const actionSequence = useRef(0);
  const { session, ready, api, signIn, signOut, capture, isCurrent } =
    useAdminSession({
      lang,
      onError: setError,
      onInvalidated: () => {
        actionSequence.current++;
        priceBaseline.current = null;
        setOverview(null);
        setOperations(null);
        setUpstream(null);
        setUsers({ items: [], total: 0, page: 1, limit: 20 });
        setRecords({ items: [], total: 0, page: 1, limit: 30 });
        setPaymentOrders({ items: [], total: 0, page: 1, limit: 30 });
        setAudits({ items: [], total: 0, page: 1, limit: 30 });
        setModal(null);
        setForm({});
        setPassword("");
        setCopied(false);
        setNotice("");
        setError("");
        setSearch("");
        setFilter("");
        setUserFilter("");
        setKindFilter("");
        setModelFilter("");
        setPage(1);
        setMobileNav(false);
        setListLoading(false);
        setBusy(false);
      },
    });
  useEffect(() => {
    const title = lang === "en" ? "MiaoImg · Admin" : "妙图 · 管理后台";
    document.title = title;
    const frame = requestAnimationFrame(() => {
      document.title = title;
    });
    return () => cancelAnimationFrame(frame);
  }, [lang]);
  async function readUpstream() {
    const [d, c, r] = await Promise.all([
      api("derived-prices"),
      api(
        `upstream-calls?limit=30&page=${page}&search=${encodeURIComponent(search)}`,
      ),
      api("upstream-reconciliation?provider=metaso&limit=30"),
    ]);
    return {
      derived: d.items || [],
      calls: c.items || [],
      total: c.total,
      page: c.page,
      limit: c.limit,
      reconciliation: r.items || [],
      snapshots: r.snapshots || [],
      models: r.models || [],
    };
  }
  useEffect(() => {
    if (!session || section !== "upstream") return;
    let cancelled = false;
    readUpstream()
      .then((d) => {
        if (!cancelled) setUpstream(d);
      })
      .catch((e) => {
        if (!cancelled && !isDiscardedAdminRequest(e)) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [session, section, page, search]);
  useEffect(() => {
    if (!session || section !== "operations") return;
    let cancelled = false;
    api("operations")
      .then((d) => {
        if (!cancelled) setOperations(d);
      })
      .catch((e) => {
        if (!cancelled && !isDiscardedAdminRequest(e)) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [session, section]);
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    api("overview")
      .then((d) => {
        if (!cancelled) setOverview(d);
      })
      .catch((e) => {
        if (!cancelled && !isDiscardedAdminRequest(e)) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [session, api]);
  useEffect(() => {
    if (!session) {
      setListLoading(false);
      return;
    }
    const params = new URLSearchParams({ page: String(page), search });
    let endpoint = {
      users: "users",
      audit: "audit",
      generations: "reconciliation",
      payments: "payment-orders",
    }[section];
    if (!endpoint) {
      setListLoading(false);
      return;
    }
    if (section === "generations") {
      params.set("status", filter);
      params.set("kind", kindFilter);
      params.set("model", modelFilter);
      if (userFilter) params.set("userId", userFilter);
    }
    if (section === "payments") {
      params.set("status", filter);
      if (userFilter) params.set("userId", userFilter);
    }
    const controller = new AbortController();
    setListLoading(true);
    setError("");
    api(`${endpoint}?${params}`, "GET", undefined, controller.signal)
      .then((d) => {
        if (controller.signal.aborted) return;
        ({
          users: setUsers,
          audit: setAudits,
          generations: setRecords,
          payments: setPaymentOrders,
        })[section](d);
      })
      .catch((e) => {
        if (!controller.signal.aborted && !isDiscardedAdminRequest(e))
          setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setListLoading(false);
      });
    return () => controller.abort();
  }, [
    session,
    section,
    page,
    search,
    filter,
    userFilter,
    kindFilter,
    modelFilter,
  ]);

  async function refresh() {
    const token = capture();
    setError("");
    const d = await api("overview");
    if (!isCurrent(token)) return;
    setOverview(d);
    let next;
    if (section === "operations") next = await api("operations");
    if (section === "upstream") next = await readUpstream();
    if (section === "users")
      next = await api(
        `users?page=${page}&search=${encodeURIComponent(search)}`,
      );
    if (section === "audit")
      next = await api(
        `audit?page=${page}&search=${encodeURIComponent(search)}`,
      );
    if (section === "generations")
      next = await api(
        `reconciliation?page=${page}&search=${encodeURIComponent(search)}&status=${filter}&kind=${kindFilter}&model=${encodeURIComponent(modelFilter)}${userFilter ? `&userId=${encodeURIComponent(userFilter)}` : ""}`,
      );
    if (section === "payments")
      next = await api(
        `payment-orders?page=${page}&search=${encodeURIComponent(search)}&status=${filter}${userFilter ? `&userId=${encodeURIComponent(userFilter)}` : ""}`,
      );
    if (next && isCurrent(token))
      ({
        operations: setOperations,
        upstream: setUpstream,
        users: setUsers,
        audit: setAudits,
        generations: setRecords,
        payments: setPaymentOrders,
      })[section](next);
  }
  async function act(fn, success, refreshAfter = true) {
    const token = capture(),
      action = ++actionSequence.current;
    const active = () => isCurrent(token) && actionSequence.current === action;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      if (!active()) return;
      if (refreshAfter) await refresh();
      if (active() && success) setNotice(success);
    } catch (e) {
      if (active() && !isDiscardedAdminRequest(e)) setError(e.message);
    } finally {
      if (active()) setBusy(false);
    }
  }
  async function login(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const pending = signIn(email, password),
      token = capture();
    try {
      await pending;
      if (isCurrent(token)) setPassword("");
    } catch (e) {
      if (isCurrent(token) && !isDiscardedAdminRequest(e))
        setError(adminText(e.message, lang));
    } finally {
      if (isCurrent(token)) setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setError("");
    setNotice("");
    const pending = signOut(),
      token = capture();
    try {
      await pending;
    } catch (e) {
      if (isCurrent(token) && !isDiscardedAdminRequest(e)) setError(e.message);
    } finally {
      if (isCurrent(token)) setBusy(false);
    }
  }
  function open(type, data: Record<string, any> = {}) {
    setForm(
      type === "create"
        ? { name: "", email: "", password: "", points: 100, models: [] }
        : type === "points"
          ? { delta: 100, reason: "" }
          : type === "permissions"
            ? { models: data.models || [], status: data.status }
            : { ...data },
    );
    setModal({ type, data });
    setCopied(false);
  }
  const close = () => {
    if (!busy) {
      setModal(null);
      setForm({});
      setCopied(false);
    }
  };
  async function submit(e) {
    e.preventDefault();
    await act(
      async () => {
        const { type, data } = modal;
        if (type === "create") {
          const oneTimePassword = String(form.password || "");
          await api("users", "POST", { ...form, points: Number(form.points) });
          setModal({
            type: "passwordResult",
            data: {
              name: form.name || form.email,
              email: form.email,
              password: oneTimePassword,
              created: true,
            },
          });
          return;
        }
        if (type === "points")
          await api(`users/${data.id}/points`, "POST", {
            delta: Number(form.delta),
            reason: form.reason,
          });
        if (type === "permissions")
          await api(`users/${data.id}`, "PATCH", form);
        if (type === "rotate") {
          const r = await api(`users/${data.id}/code`, "POST", {});
          setModal({
            type: "code",
            data: { name: data.name, accessCode: r.accessCode },
          });
          return;
        }
        if (type === "password") {
          const oneTimePassword = String(form.password || "");
          await api(`users/${data.id}/password`, "POST", {
            password: form.password,
          });
          setModal({
            type: "passwordResult",
            data: {
              name: data.name,
              email: data.email,
              password: oneTimePassword,
              created: false,
            },
          });
          return;
        }
        if (type === "settings") {
          const {
            enabled,
            videoEnabled,
            registrationEnabled,
            defaultModel,
            defaultTextModel,
          } = form;
          await api("settings", "PATCH", {
            enabled,
            videoEnabled,
            registrationEnabled,
            defaultModel,
            defaultTextModel,
          });
        }
        if (type === "prices") {
          const baseline = priceBaseline.current || {};
          const prices = {},
            textPrices = {};
          for (const [id, entry] of Object.entries(form.prices || {})) {
            const changed = {};
            for (const kind of ["image", "video"])
              for (const [tier, value] of Object.entries(entry[kind] || {})) {
                if (value === "" || value == null) continue;
                if (!Number.isFinite(Number(value)))
                  throw new Error(
                    lang === "en" ? "Enter a valid price" : "请输入有效价格",
                  );
                if (
                  Number(value) !==
                  Number(baseline.prices?.[id]?.[kind]?.[tier])
                ) {
                  changed[kind] ||= {};
                  changed[kind][tier] = Number(value);
                }
              }
            if (Object.keys(changed).length) prices[id] = changed;
          }
          for (const [id, entry] of Object.entries(form.textPrices || {}))
            for (const [key, value] of Object.entries(entry)) {
              if (Number(value) !== Number(baseline.textPrices?.[id]?.[key])) {
                textPrices[id] ||= {};
                textPrices[id][key] = Number(value);
              }
            }
          const videoPricing = {};
          for (const [key, value] of Object.entries(form.videoPricing || {}))
            if (
              String(value ?? "") !== String(baseline.videoPricing?.[key] ?? "")
            )
              videoPricing[key] = value;
          const patch = {
            ...(Object.keys(prices).length ? { prices } : {}),
            ...(Object.keys(textPrices).length ? { textPrices } : {}),
            ...(Object.keys(videoPricing).length ? { videoPricing } : {}),
          };
          if (Object.keys(patch).length) await api("settings", "PATCH", patch);
        }
        setModal(null);
      },
      adminText("修改已保存", lang),
    );
  }
  async function openRecord(r) {
    await act(
      async () => {
        const d = await api(
          `generations/${encodeURIComponent(r.requestId || r.request_id)}`,
        );
        setModal({ type: "record", data: d });
      },
      null,
      false,
    );
  }
  async function openLedger(u, ledgerPage = 1, textPage = 1) {
    await act(
      async () => {
        const d = await api(
          `users/${u.id}/ledger?page=${ledgerPage}&textPage=${textPage}&limit=30`,
        );
        setModal({
          type: "ledger",
          data: {
            ...u,
            ledger: d.items,
            ledgerTotal: d.total,
            ledgerPage: d.page,
            ledgerLimit: d.limit,
            reasonSummary: d.reasonSummary || [],
            textCharges: d.textCharges,
          },
        });
      },
      null,
      false,
    );
  }
  async function openUserStats(u) {
    await act(
      async () => {
        const d = await api(`users/${u.id}/stats`);
        setModal({ type: "stats", data: { ...u, stats: d } });
      },
      null,
      false,
    );
  }
  async function copySecret() {
    const token = capture();
    try {
      await navigator.clipboard.writeText(
        modal.data.password || modal.data.accessCode,
      );
      if (isCurrent(token)) setCopied(true);
    } catch {
      if (isCurrent(token))
        setError(
          adminText(
            modal.data.password
              ? "复制失败，请选中密码手动复制"
              : "复制失败，请选中登录码手动复制",
            lang,
          ),
        );
    }
  }
  function exportPage() {
    const body = JSON.stringify(records.items, null, 2);
    const url = URL.createObjectURL(
      new Blob([body], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download =
      lang === "en" ? "miaoimg-generations.json" : "妙图生成记录.json";
    a.click();
    URL.revokeObjectURL(url);
  }
  if (!ready)
    return (
      <div className="admin-login" data-theme={theme}>
        <p>{adminText("正在连接管理后台…", lang)}</p>
      </div>
    );
  if (!session)
    return (
      <div className="admin-login" data-theme={theme}>
        <div className="admin-login-shell">
          <aside className="admin-login-intro">
            <div className="admin-login-brand">
              <img src="/miaoimg-logo.png" alt="" />
              <span>
                {adminText("妙图", lang)}
                <small>MIAOIMG · ADMIN</small>
              </span>
            </div>
            <div>
              <span className="admin-breadcrumb">OPERATIONS CONSOLE</span>
              <h2>{adminText("把每一次生成、积分和订单都看清楚。", lang)}</h2>
              <p>
                {adminText(
                  "面向妙图日常运营的独立管理台，集中处理账号、模型、生成服务与账单。",
                  lang,
                )}
              </p>
            </div>
            <div className="admin-login-index" aria-hidden="true">
              <span>01 <b>ACCOUNTS</b></span>
              <span>02 <b>MODELS</b></span>
              <span>03 <b>OPERATIONS</b></span>
            </div>
          </aside>
          <form onSubmit={login}>
            <LanguageControl compact />
            <h1>{adminText("登录管理后台", lang)}</h1>
            <p>{adminText("使用管理员账号继续。", lang)}</p>
            <label>
              {adminText("管理员邮箱", lang)}
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label>
              {adminText("管理员密码", lang)}
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {error && (
              <p role="alert" className="admin-error">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy}>
              {busy ? adminText("正在登录…", lang) : adminText("登录后台", lang)}
            </button>
            <p className="admin-version">
              {adminText("应用版本", lang)} v{APP_VERSION}
            </p>
            <ThemeControl choice={choice} onChange={choose} />
          </form>
        </div>
      </div>
    );
  const stats = overview?.stats || {},
    modelList = overview?.models || [],
    videoList = overview?.videoModels || [],
    textModels = overview?.textModels || [],
    allModelRows = [
      ...modelList.map((model) => ({ ...model, kind: "image" })),
      ...videoList.map((model) => ({ ...model, kind: "video" })),
      ...textModels.map((model) => ({ ...model, kind: "text" })),
    ],
    current = sections.find((s) => s[0] === section),
    visibleUsers = users.items || [];
  function openPricing(modelId = "") {
    if (!overview) return;
    const values = buildPricingDraft(
      allModelRows as AdminModelRow[],
      overview.costPolicy || {},
      overview.settings || {},
    );
    priceBaseline.current = structuredClone(values);
    setPricingFocus(modelId);
    setForm(values);
    setModal({ type: "prices" });
  }
  // 价格设置：按模型列出每个档位（视频=每个分辨率，图片=每个尺寸），初始值取当前有效价。
  const priceSections = [...modelList, ...videoList].map((m) => {
    const sizes = (m.sizes || []).map((x) => x.value);
    const list = sizes.length ? sizes : ["default"];
    return {
      id: m.id,
      label: m.label,
      kind: m.video ? "video" : "image",
      tiers: list.map((v) => ({ key: v, label: v })),
    };
  });
  function buildPriceForm() {
    const policy: Record<
      string,
      {
        creditsPerSecond?: Record<string, number | string>;
        creditsPerImageBySize?: Record<string, number | string>;
        creditsPerImage?: number | string;
      }
    > = overview?.costPolicy?.models || {};
    const next = {};
    for (const section of priceSections) {
      const tiers = {};
      for (const tier of section.tiers) tiers[tier.key] = "";
      next[section.id] = { [section.kind]: tiers };
    }
    for (const [id, rate] of Object.entries(policy)) {
      const entry = next[id];
      if (!entry) continue;
      if (entry.video)
        for (const [res, value] of Object.entries(rate.creditsPerSecond || {}))
          if (entry.video[res] !== undefined) entry.video[res] = value;
      if (entry.image) {
        const bySize = rate.creditsPerImageBySize || {};
        for (const size of Object.keys(entry.image))
          entry.image[size] = bySize[size] ?? rate.creditsPerImage ?? "";
      }
    }
    return next;
  }
  function buildTextPriceForm() {
    const policy = overview?.costPolicy?.textModels || {};
    return Object.fromEntries(
      textModels.map((model) => {
        const rate = policy[model.id] || {};
        return [
          model.id,
          {
            inputCreditsPerMillionTokens:
              rate.inputCreditsPerMillionTokens ?? 0,
            outputCreditsPerMillionTokens:
              rate.outputCreditsPerMillionTokens ?? 0,
            minimumCredits: rate.minimumCredits ?? 0,
          },
        ];
      }),
    );
  }
  function textPriceSummary(model) {
    const rate = overview?.costPolicy?.textModels?.[model.id];
    if (!rate) return "—";
    return `${adminText("输入", lang)} ${displayNumber(rate.inputCreditsPerMillionTokens ?? 0)} · ${adminText("输出", lang)} ${displayNumber(rate.outputCreditsPerMillionTokens ?? 0)} · ${adminText("最低", lang)} ${displayNumber(rate.minimumCredits ?? 0)}`;
  }
  function textPriceEditor() {
    return (
      <fieldset className="admin-price-group">
        <legend>{adminText("大语言模型文本价格", lang)}</legend>
        <p className="admin-footnote">
          {adminText(
            "文本价格按输入与输出 token 分开设置，保存后立即生效。",
            lang,
          )}{" "}
          {adminText(
            "价格为 0 表示免费；设置价格后按实际 token 扣积分。",
            lang,
          )}
        </p>
        {textModels.map((model) => (
          <fieldset key={model.id} className="admin-price-group">
            <legend>{model.label}</legend>
            <label className="admin-price-row">
              <span>{adminText("输入 token 价格（每百万）", lang)}</span>
              <input
                type="number"
                required
                min="0"
                max="1000000"
                step="0.0001"
                value={
                  form.textPrices?.[model.id]?.inputCreditsPerMillionTokens ?? 0
                }
                onChange={(e) =>
                  setForm({
                    ...form,
                    textPrices: {
                      ...form.textPrices,
                      [model.id]: {
                        ...form.textPrices?.[model.id],
                        inputCreditsPerMillionTokens: e.target.value,
                      },
                    },
                  })
                }
              />
              <em>{adminText("积分/百万 token", lang)}</em>
            </label>
            <label className="admin-price-row">
              <span>{adminText("输出 token 价格（每百万）", lang)}</span>
              <input
                type="number"
                required
                min="0"
                max="1000000"
                step="0.0001"
                value={
                  form.textPrices?.[model.id]?.outputCreditsPerMillionTokens ??
                  0
                }
                onChange={(e) =>
                  setForm({
                    ...form,
                    textPrices: {
                      ...form.textPrices,
                      [model.id]: {
                        ...form.textPrices?.[model.id],
                        outputCreditsPerMillionTokens: e.target.value,
                      },
                    },
                  })
                }
              />
              <em>{adminText("积分/百万 token", lang)}</em>
            </label>
            <label className="admin-price-row">
              <span>{adminText("每次最低积分", lang)}</span>
              <input
                type="number"
                required
                min="0"
                max="1000000"
                step="0.0001"
                value={form.textPrices?.[model.id]?.minimumCredits ?? 0}
                onChange={(e) =>
                  setForm({
                    ...form,
                    textPrices: {
                      ...form.textPrices,
                      [model.id]: {
                        ...form.textPrices?.[model.id],
                        minimumCredits: e.target.value,
                      },
                    },
                  })
                }
              />
              <em>{adminText("积分", lang)}</em>
            </label>
          </fieldset>
        ))}
      </fieldset>
    );
  }
  function updatePrice(id, kind, tier, value) {
    setForm((prev) => ({
      ...prev,
      prices: {
        ...prev.prices,
        [id]: {
          ...(prev.prices?.[id] || {}),
          [kind]: {
            ...(prev.prices?.[id]?.[kind] || {}),
            [tier]: value,
          },
        },
      },
    }));
  }

  const displayTime = (value) => time(value, lang),
    displayNumber = (value) => number(value, lang),
    displayBytes = (value) => {
      if (value == null) return adminText("未知", lang);
      const n = Number(value);
      if (n < 1024) return `${n} B`;
      if (n < 1048576) return `${(n / 1024).toFixed(1)} KiB`;
      if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MiB`;
      return `${(n / 1073741824).toFixed(2)} GiB`;
    };
  const displayOpsNumber = (value) =>
      value == null ? adminText("未知", lang) : displayNumber(value),
    displayOpsBytes = (value) =>
      value == null ? adminText("未知", lang) : displayBytes(value);
  const providerDescription = {
    ark: adminText("火山方舟图片与视频通道", lang),
    metaso: adminText("秘塔视频通道", lang),
    yunshu: adminText("云枢图片通道", lang),
    grok: adminText("云枢 Grok 图片与视频通道", lang),
  };
  return (
    <div
      className={`admin-app ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${mobileNav ? "mobile-nav-open" : ""}`}
      data-theme={theme}
    >
      {mobileNav && (
        <button
          className="admin-nav-backdrop"
          aria-label={lang === "en" ? "Close navigation" : "关闭导航"}
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className="admin-sidebar" id="admin-navigation">
        <a className="admin-brand" href="#overview">
          <img src="/miaoimg-logo.png" alt="" />
          <span>
            {adminText("妙图", lang)}
            <small>MIAOIMG · ADMIN</small>
          </span>
        </a>
        <nav
          aria-label={
            lang === "en" ? "Admin navigation" : adminText("管理导航", lang)
          }
        >
          {navigationGroups.map((group) => (
            <div className="admin-nav-group" key={group.keys[0]}>
              <span className="admin-nav-group-label">{group.label}</span>
              {group.keys.map((key) => {
                const [, label, Icon] = sections.find((row) => row[0] === key);
                return (
                  <button
                    key={key}
                    title={lang === "en" ? sectionEnglish[key] : label}
                    aria-label={lang === "en" ? sectionEnglish[key] : label}
                    aria-current={section === key ? "page" : undefined}
                    onClick={() => selectSection(key)}
                  >
                    <Icon size={20} />
                    <span>{lang === "en" ? sectionEnglish[key] : label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="admin-sidebar-bottom">
          <p className="admin-version">v{APP_VERSION}</p>
          <ThemeControl choice={choice} onChange={choose} />
          <button
            disabled={busy}
            onClick={logout}
            title={lang === "en" ? "Sign out" : "退出登录"}
            aria-label={lang === "en" ? "Sign out" : "退出登录"}
          >
            <SignOut size={18} />
            <span>
              {lang === "en" ? "Sign out" : adminText("退出登录", lang)}
            </span>
          </button>
          <button
            className="admin-collapse"
            aria-label={
              sidebarCollapsed
                ? lang === "en"
                  ? "Expand sidebar"
                  : "展开侧栏"
                : lang === "en"
                  ? "Collapse sidebar"
                  : "收起侧栏"
            }
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            {sidebarCollapsed ? (
              <CaretDoubleRight size={18} />
            ) : (
              <CaretDoubleLeft size={18} />
            )}
            <span>{lang === "en" ? "Collapse sidebar" : "收起侧栏"}</span>
          </button>
        </div>
      </aside>
      <main className="admin-main">
        <header className="admin-top">
          <button
            className="admin-mobile-menu"
            aria-label={lang === "en" ? "Open navigation" : "打开导航"}
            aria-expanded={mobileNav}
            aria-controls="admin-navigation"
            onClick={() => setMobileNav(!mobileNav)}
          >
            <List size={22} />
          </button>
          <div className="admin-top-copy">
            <span className="admin-breadcrumb">
              {lang === "en" ? "Admin console" : "管理控制台"} /{" "}
              {lang === "en" ? sectionEnglish[section] : current[1]}
            </span>
            <h1>{lang === "en" ? sectionEnglish[section] : current[1]}</h1>
            <p>
              {lang === "en"
                ? sectionDescriptionEnglish[section]
                : section === "overview"
                  ? adminText("查看账号、生成与费用概况。", lang)
                  : section === "operations"
                    ? adminText("查看存储、数据同步和服务配置。", lang)
                    : section === "users"
                      ? adminText("管理账号、权限与积分。", lang)
                      : section === "models"
                        ? adminText("管理模型开关、参数价格与成本分摊。", lang)
                        : section === "generations"
                          ? adminText(
                              "查看生成结果、任务状态与积分消耗。",
                              lang,
                            )
                          : section === "payments"
                            ? adminText(
                                "查看订单和支付状态，支付成功后积分到账。",
                                lang,
                              )
                            : section === "upstream"
                              ? adminText(
                                  "查看上游调用、成本估算与余额记录。",
                                  lang,
                                )
                              : section === "feedback"
                                ? "查看并回复桌面端用户提交的问题和建议。"
                                : adminText("查看账号、支付与管理操作。", lang)}
            </p>
            <span className="admin-timezone-note">
              {adminText("时间按本地时区显示；统计范围按 UTC。", lang)}
            </span>
          </div>
          <div className="admin-top-actions">
            <LanguageControl compact />
            <div className="admin-quick-links" ref={quickLinksRef}>
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={quickLinksOpen}
                aria-controls="admin-quick-links-menu"
                onClick={() => setQuickLinksOpen((value) => !value)}
              >
                <SquaresFour size={17} />
                {lang === "en" ? "Shortcuts" : adminText("快捷入口", lang)}
                <CaretDown size={14} aria-hidden="true" />
              </button>
              {quickLinksOpen && (
                <div
                  id="admin-quick-links-menu"
                  className="admin-quick-links-menu"
                  role="menu"
                >
                  <span className="admin-quick-links-heading">
                    {lang === "en" ? "Open in a new tab" : "在新标签页打开"}
                  </span>
                  {externalDestinations.map((destination) => (
                    <a
                      key={destination.id}
                      href={destination.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      role="menuitem"
                      onClick={() => setQuickLinksOpen(false)}
                    >
                      <span>
                        <strong>
                          {lang === "en" ? destination.en : destination.zh}
                        </strong>
                        <small>{destination.host}</small>
                      </span>
                      <ArrowSquareOut size={16} aria-hidden="true" />
                    </a>
                  ))}
                </div>
              )}
            </div>
            <button
              disabled={busy}
              onClick={() =>
                act(
                  async () => {},
                  lang === "en"
                    ? "Status refreshed"
                    : adminText("状态已刷新", lang),
                )
              }
            >
              <ArrowClockwise size={17} />
              {lang === "en" ? "Refresh" : adminText("刷新", lang)}
            </button>
          </div>
        </header>
        {listLoading && (
          <div className="admin-loading" role="status">
            {lang === "en" ? "Loading current results…" : "正在读取当前结果…"}
          </div>
        )}
        {error && (
          <div role="alert" className="admin-message error">
            {error}
          </div>
        )}
        {notice && (
          <div role="status" className="admin-message">
            <Check size={16} />
            {notice}
          </div>
        )}
        {section === "overview" &&
          (!overview ? (
            <Empty>{adminText("正在读取运营数据…", lang)}</Empty>
          ) : (
            <>
              <section
                className="admin-metrics"
                aria-label={adminText("运营统计", lang)}
              >
                {[
                  [adminText("用户", lang), stats.users],
                  [
                    adminText("正常 / 停用账号", lang),
                    `${displayNumber(stats.activeUsers)} / ${displayNumber(stats.disabledUsers)}`,
                  ],
                  [
                    adminText("排队 / 生成中", lang),
                    `${displayNumber(stats.queued)} / ${displayNumber(stats.running)}`,
                  ],
                  [
                    adminText("失败 / 取消 / 过期", lang),
                    `${displayNumber(stats.failed)} / ${displayNumber(stats.cancelled)} / ${displayNumber(stats.expired)}`,
                  ],
                  [adminText("生成请求", lang), stats.requests],
                  [adminText("已完成", lang), stats.succeeded],
                  [
                    adminText("账本净消耗（积分）", lang),
                    stats.ledgerConsumedPoints,
                  ],
                  [
                    adminText("待结算预扣（积分）", lang),
                    stats.reservedUserPoints,
                  ],
                  [
                    adminText("预扣不足：请求 / 积分", lang),
                    displayNumber(stats.shortfallRows) +
                      " / " +
                      displayNumber(stats.shortfallPoints),
                  ],
                  [adminText("实扣积分（现存记录）", lang), stats.points],
                  [
                    adminText("成功实扣（现存记录）", lang),
                    stats.succeededChargedPointsRmb,
                  ],
                  [
                    adminText("成本估算（元）", lang),
                    `¥${displayNumber(stats.upstreamCostRmb)}`,
                  ],
                  [
                    adminText("估算差额（有成本记录）", lang),
                    `¥${displayNumber(stats.marginRmb)}`,
                  ],
                  [adminText("成功但缺成本记录", lang), stats.missingCostRows],
                ].map(([k, v]) => (
                  <div key={k}>
                    <span>{k}</span>
                    <strong>
                      {typeof v === "string" ? v : displayNumber(v)}
                    </strong>
                  </div>
                ))}
              </section>
              <details className="admin-explainer">
                <summary>{adminText("统计说明", lang)}</summary>
                <p className="admin-footnote">
                  {adminText(
                    "账本净消耗含已删除生成索引的历史流水，扣除关联退款与待结算预扣，不含管理员调整。",
                    lang,
                  )}{" "}
                  {adminText(
                    "成本按价目与实测单价推算；差额仅包含有成本留档的同批请求，积分按当前充值兑换价折元；赠送积分不是收入，缺成本及文本成本未纳入，不代表支付收入或账单毛利。",
                    lang,
                  )}{" "}
                  {adminText(
                    "实扣按全部请求与成功请求分别统计，均不含未结算预扣。",
                    lang,
                  )}{" "}
                  · {adminText("有成本留档", lang)}：
                  {displayNumber(stats.costMatchedRows)} /{" "}
                  {displayNumber(stats.requests)} ·{" "}
                  {adminText("当前每积分兑换价（元）", lang)}：
                  {displayNumber(stats.pointPriceRmb)}
                  <br />
                  <TextChargeSummary summary={stats.textCharges} lang={lang} />
                </p>
              </details>
              <section className="admin-panel admin-balance-panel">
                <header>
                  <h2>{adminText("积分余额与账本核对", lang)}</h2>
                  <span
                    className={`admin-badge ${stats.balanceAudit?.mismatches?.length ? "failed" : "active"}`}
                  >
                    {displayNumber(stats.balanceAudit?.matching || 0)} /{" "}
                    {displayNumber(stats.balanceAudit?.checked || 0)}{" "}
                    {adminText("个账号一致", lang)}
                  </span>
                </header>
                <p className="admin-footnote">
                  {adminText(
                    "逐账号比较存储余额与账本累计；差额绝对值不超过 0.0001 积分视为一致。",
                    lang,
                  )}
                </p>
                <p>
                  {adminText("账本累计", lang)}：
                  {displayNumber(stats.balanceAudit?.ledgerTotal || 0)}{" "}
                  {adminText("积分", lang)} · {adminText("存储余额合计", lang)}
                  ：{displayNumber(stats.balanceAudit?.storedTotal || 0)}{" "}
                  {adminText("积分", lang)}
                </p>
                {stats.balanceAudit?.mismatches?.length ? (
                  <div className="admin-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>{adminText("用户", lang)}</th>
                          <th>{adminText("存储余额（积分）", lang)}</th>
                          <th>{adminText("账本累计", lang)}</th>
                          <th>{adminText("余额减账本（积分）", lang)}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.balanceAudit.mismatches.map((row) => (
                          <tr key={row.id}>
                            <td>{row.name}</td>
                            <td>{row.storedPoints}</td>
                            <td>{row.ledgerPoints}</td>
                            <td>{row.difference}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="admin-muted">
                    {displayNumber(stats.balanceAudit?.matching || 0)} /{" "}
                    {displayNumber(stats.balanceAudit?.checked || 0)}{" "}
                    {adminText("个账号一致", lang)}
                  </p>
                )}
              </section>
              <div className="admin-overview-grid">
                <section className="admin-panel">
                  <header>
                    <h2>{adminText("生成服务", lang)}</h2>
                    <button
                      onClick={() => open("settings", { ...overview.settings })}
                      disabled={!overview}
                    >
                      {adminText("运行设置", lang)}
                    </button>
                  </header>
                  <div className="admin-service">
                    <div>
                      <span
                        className={`admin-dot ${overview?.settings.enabled ? "on" : ""}`}
                      />
                      <strong>
                        {overview?.settings.enabled
                          ? adminText("生成已开启", lang)
                          : adminText("生成已暂停", lang)}
                      </strong>
                      <small>{adminText("登录后可生成", lang)}</small>
                    </div>
                    <dl>
                      <div>
                        <dt>{adminText("默认图片模型", lang)}</dt>
                        <dd>
                          {modelList.find(
                            (m) => m.id === overview?.settings.defaultModel,
                          )?.label || "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("默认文本模型", lang)}</dt>
                        <dd>
                          {textModels.find(
                            (m) => m.id === overview?.settings.defaultTextModel,
                          )?.label || "—"}
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("每账号同时生成", lang)}</dt>
                        <dd>{adminText("不设数量上限", lang)}</dd>
                      </div>
                      <div>
                        <dt>{adminText("正在生成", lang)}</dt>
                        <dd>
                          {adminText("{n} 个请求", lang, {
                            n: stats.running || 0,
                          })}
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("索引容量（MiB）", lang)}</dt>
                        <dd>
                          {(Number(stats.storageBytes || 0) / 1048576).toFixed(
                            1,
                          )}{" "}
                          MiB
                          <small>
                            {adminText(
                              "存储统计加总工作区与生成结果索引 size/bytes；不等于磁盘实际占用，可能重复引用同一文件。",
                              lang,
                            )}
                          </small>
                        </dd>
                      </div>
                    </dl>
                  </div>
                </section>
                <section className="admin-panel">
                  <header>
                    <h2>{adminText("上游通道", lang)}</h2>
                  </header>
                  {overview?.providers.map((p) => (
                    <div className="admin-provider" key={p.id}>
                      <div>
                        <strong>{adminText(p.label, lang)}</strong>
                        <small>{providerDescription[p.id] || p.label}</small>
                      </div>
                      <div>
                        <Badge value={p.configured ? "已配置" : "未配置"} />
                        <small>
                          {adminText("最近媒体调用", lang)}：
                          {p.latestCall ? (
                            <>
                              <Badge value={p.latestCall.status} />
                              {displayTime(p.latestCall.created_at)}
                            </>
                          ) : (
                            adminText("无留档", lang)
                          )}
                        </small>
                        {p.latestCall?.error && (
                          <small className="admin-error">
                            {p.latestCall.error}
                          </small>
                        )}
                      </div>
                    </div>
                  ))}
                  <p className="admin-footnote">
                    {adminText(
                      "管理端只显示凭据配置状态，不显示 API 密钥；已配置不代表当前通道可用。",
                      lang,
                    )}
                  </p>
                </section>
              </div>
              <section className="admin-panel">
                <header>
                  <h2>{adminText("近 7 天生成情况（UTC）", lang)}</h2>
                </header>
                {stats.daily?.length ? (
                  <div className="admin-days">
                    {stats.daily.map((d) => (
                      <div key={d.date}>
                        <time>{d.date.slice(5)}</time>
                        <span
                          className="admin-bar"
                          style={{
                            width: `${Math.max(3, (d.requests / Math.max(...stats.daily.map((x) => x.requests))) * 70)}%`,
                          }}
                        />
                        <strong>{`${d.requests} ${adminText("次", lang)}`}</strong>
                        <small>{`${displayNumber(d.points)} ${adminText("积分", lang)}`}</small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty>
                    {adminText(
                      "近 168 小时没有生成请求；此处按创建时间汇总全部状态的请求与实扣积分。",
                      lang,
                    )}
                  </Empty>
                )}
              </section>
            </>
          ))}
        {section === "operations" && (
          <>
            {!operations ? (
              <Empty>{adminText("正在读取运维状态…", lang)}</Empty>
            ) : (
              <>
                <div className="admin-overview-grid">
                  <section className="admin-panel">
                    <header>
                      <h2>{adminText("项目迁移", lang)}</h2>
                      <span
                        className={`admin-badge ${operations.migration.projectLayout === "mixed" ? "failed" : "active"}`}
                      >
                        {adminText(
                          operations.migration.projectLayoutLabel,
                          lang,
                        )}
                      </span>
                    </header>
                    <div className="admin-ops-grid">
                      <div>
                        <span>{adminText("项目表行数", lang)}</span>
                        <strong>
                          {operations.migration.hasProjectsTable
                            ? displayNumber(operations.migration.projectCount)
                            : adminText("无项目表（老布局）", lang)}
                        </strong>
                      </div>
                      <div>
                        <span>{adminText("工作区索引", lang)}</span>
                        <strong>
                          {displayNumber(operations.migration.workspaceRows)}
                        </strong>
                        <small>
                          {displayBytes(
                            operations.migration.workspaceBytesInNewOnly,
                          )}{" "}
                          {adminText("仅新路径存在", lang)}
                        </small>
                      </div>
                      <div>
                        <span>{adminText("仅旧路径存在", lang)}</span>
                        <strong>
                          {displayNumber(
                            operations.migration.workspaceRowsAtOldOnly,
                          )}
                        </strong>
                      </div>
                      <div>
                        <span>{adminText("新旧路径均存在", lang)}</span>
                        <strong>
                          {displayNumber(
                            operations.migration.workspaceRowsAtBoth,
                          )}
                        </strong>
                      </div>
                      <div>
                        <span>{adminText("新旧路径均缺文件", lang)}</span>
                        <strong>
                          {displayNumber(
                            operations.migration.workspaceRowsAtNeither,
                          )}
                        </strong>
                      </div>
                    </div>
                    <dl className="admin-ops-dl">
                      <div>
                        <dt>{adminText("内容寻址迁移", lang)}</dt>
                        <dd>
                          {operations.migration.mediaLayout === "blob"
                            ? adminText("内容寻址（blob）", lang)
                            : adminText("路径布局（path）", lang)}
                          {operations.migration.mediaLayoutUpdatedAt && (
                            <small>
                              {displayTime(
                                operations.migration.mediaLayoutUpdatedAt,
                              )}
                            </small>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("工作区 blob 登记数", lang)}</dt>
                        <dd>
                          {displayNumber(
                            operations.migration.workspaceBlobRows,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("生成结果 blob 登记数", lang)}</dt>
                        <dd>
                          {displayNumber(operations.migration.artifactBlobRows)}
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("workspace_files.bytes 非空", lang)}</dt>
                        <dd>
                          {displayNumber(
                            operations.migration.workspaceBytesRows,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("artifacts.bytes 非空", lang)}</dt>
                        <dd>
                          {displayNumber(
                            operations.migration.artifactBytesRows,
                          )}
                        </dd>
                      </div>
                    </dl>
                    <p className="admin-footnote">
                      {adminText(
                        "运维字段：blob 列不存在时登记数也返回 0；0 不代表已完成迁移。",
                        lang,
                      )}
                    </p>
                  </section>
                  <section className="admin-panel">
                    <header>
                      <h2>{adminText("运维配置（只读）", lang)}</h2>
                    </header>
                    <dl className="admin-ops-dl">
                      {operations.runtime.textModels?.length ? (
                        operations.runtime.textModels.map((model) => (
                          <div key={model.id}>
                            <dt>{model.label}</dt>
                            <dd>
                              {adminText("运行上下文配置", lang)}：
                              {displayNumber(model.contextWindow)} tokens ·{" "}
                              {adminText("模型输出配置", lang)}：
                              {displayNumber(model.maxOutputTokens)} tokens
                              <small>
                                {adminText("配置来源", lang)}：
                                {adminText(model.sources.contextWindow, lang)} /{" "}
                                {adminText(model.sources.maxOutputTokens, lang)}
                              </small>
                            </dd>
                          </div>
                        ))
                      ) : (
                        <>
                          <div>
                            <dt>{adminText("文本窗口配置参考", lang)}</dt>
                            <dd>
                              {displayNumber(
                                operations.runtime.textContextWindow,
                              )}{" "}
                              tokens
                              <small>
                                {adminText(
                                  "仅环境配置参考，非模型实际上下文容量。",
                                  lang,
                                )}
                              </small>
                            </dd>
                          </div>
                          <div>
                            <dt>{adminText("来源", lang)}</dt>
                            <dd>
                              {adminText(
                                operations.runtime.textContextWindowSource,
                                lang,
                              )}
                            </dd>
                          </div>
                        </>
                      )}
                      <div>
                        <dt>{adminText("应用版本", lang)}</dt>
                        <dd>v{APP_VERSION}</dd>
                      </div>
                      <div>
                        <dt>{adminText("运行镜像", lang)}</dt>
                        <dd>
                          {operations.runtime.image || adminText("未知", lang)}
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("运行源码版本", lang)}</dt>
                        <dd className="id-cell">
                          {operations.runtime.revision ||
                            adminText("未知", lang)}
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("媒体模式", lang)}</dt>
                        <dd>{operations.runtime.mediaMode}</dd>
                      </div>
                      <div>
                        <dt>{adminText("媒体目录", lang)}</dt>
                        <dd className="id-cell">
                          {operations.runtime.mediaRoot}
                        </dd>
                      </div>
                    </dl>
                    <p className="admin-footnote">
                      {adminText(
                        "文本参数来自模型与 Agent 的运行配置；实际输出上限以模型已公布配置和成功调用为准。",
                        lang,
                      )}
                    </p>
                  </section>
                </div>
                <div className="admin-overview-grid">
                  <section className="admin-panel">
                    <header>
                      <h2>{adminText("媒体目录与备份", lang)}</h2>
                    </header>
                    <dl className="admin-ops-dl">
                      <div>
                        <dt>{adminText("媒体目录（宿主快照）", lang)}</dt>
                        <dd>
                          {displayOpsBytes(operations.storage.mediaBytes)} ·{" "}
                          {displayOpsNumber(operations.storage.mediaFiles)}{" "}
                          {adminText("文件数", lang)}
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("宿主快照采集时间", lang)}</dt>
                        <dd>{displayTime(operations.storage.capturedAt)}</dd>
                      </div>
                      <div>
                        <dt>{adminText("磁盘实时读取时间", lang)}</dt>
                        <dd>
                          {displayTime(operations.storage.disk.observedAt)}
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("磁盘余量（实时文件系统）", lang)}</dt>
                        <dd>
                          {displayOpsBytes(operations.storage.disk.freeBytes)}
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("磁盘使用率", lang)}</dt>
                        <dd>
                          {operations.storage.disk.usagePercent == null
                            ? adminText("未知", lang)
                            : `${operations.storage.disk.usagePercent}%`}
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("最近快照", lang)}</dt>
                        <dd>
                          {operations.storage.snapshots.latestAt
                            ? displayTime(operations.storage.snapshots.latestAt)
                            : adminText("快照时间未知", lang)}
                          <small>
                            {operations.storage.snapshots.status === "stale"
                              ? adminText("状态文件已过期", lang)
                              : opsStatusText(
                                  operations.storage.snapshots.status,
                                  lang,
                                )}
                          </small>
                        </dd>
                      </div>
                    </dl>
                    <div className="admin-snapshot-list">
                      {operations.storage.snapshots.items.map((item) => (
                        <div key={item.name}>
                          <code>{item.name}</code>
                          <small>
                            {adminText("目录修改时间（非备份创建时间）", lang)}
                            ：{displayTime(item.updatedAt)}
                          </small>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section className="admin-panel">
                    <header>
                      <h2>{adminText("数据集同步", lang)}</h2>
                      <span
                        className={`admin-badge ${operations.dataset.syncStatus?.status === "success" ? "active" : operations.dataset.syncStatus?.status === "failed" ? "failed" : "disabled"}`}
                      >
                        {operations.dataset.syncStatus?.status === "success"
                          ? adminText("同步成功", lang)
                          : operations.dataset.syncStatus?.status === "failed"
                            ? adminText("同步失败", lang)
                            : opsStatusText(
                                operations.dataset.syncStatus?.status,
                                lang,
                              )}
                      </span>
                    </header>
                    <dl className="admin-ops-dl">
                      <div>
                        <dt>{adminText("提示词条数", lang)}</dt>
                        <dd>
                          {displayOpsNumber(
                            operations.dataset.databaseCounts?.prompts ??
                              operations.dataset.prompts,
                          )}
                          <small>
                            {adminText("数据库当前行数（读取时）", lang)}
                          </small>
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("图片条数", lang)}</dt>
                        <dd>
                          {displayOpsNumber(
                            operations.dataset.databaseCounts?.images ??
                              operations.dataset.images,
                          )}
                          <small>
                            {adminText("数据库当前行数（读取时）", lang)}
                          </small>
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("上次同步提示词条数", lang)}</dt>
                        <dd>
                          {displayOpsNumber(
                            operations.dataset.syncCounts?.prompts,
                          )}
                          <small>
                            {adminText("上次同步记录的库行数", lang)}
                          </small>
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("上次同步图片条数", lang)}</dt>
                        <dd>
                          {displayOpsNumber(
                            operations.dataset.syncCounts?.images,
                          )}
                          <small>
                            {adminText("上次同步记录的库行数", lang)}
                          </small>
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("预览条数", lang)}</dt>
                        <dd>
                          {displayOpsNumber(
                            operations.dataset.databaseCounts?.previews ??
                              operations.dataset.previews,
                          )}
                          <small>{adminText("当前预览目录文件数", lang)}</small>
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("同步状态时间", lang)}</dt>
                        <dd>
                          {operations.dataset.syncStatus?.updatedAt
                            ? displayTime(
                                operations.dataset.syncStatus.updatedAt,
                              )
                            : adminText("未知", lang)}
                          <small>
                            {operations.dataset.syncStatus?.status === "stale"
                              ? adminText("状态文件已过期", lang)
                              : opsStatusText(
                                  operations.dataset.syncStatus?.status,
                                  lang,
                                )}
                          </small>
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("失败原因", lang)}</dt>
                        <dd>
                          {operations.dataset.syncStatus?.failureReason || "—"}
                          <small>
                            {operations.dataset.syncStatus?.command ||
                              "systemctl start miaoimg-sync.service"}
                          </small>
                        </dd>
                      </div>
                      <div>
                        <dt>{adminText("同步定时器存在状态", lang)}</dt>
                        <dd>
                          {operations.dataset.timerFilePresent == null
                            ? adminText("未知", lang)
                            : operations.dataset.timerFilePresent
                              ? adminText("已发现", lang)
                              : adminText("未发现", lang)}
                          <small>
                            {adminText("状态来源", lang)}：
                            {adminText("宿主状态文件", lang)}
                          </small>
                        </dd>
                      </div>
                    </dl>
                    <p className="admin-footnote">
                      {adminText(
                        "当前计数来自数据库与预览目录；同步计数来自宿主状态快照，两者时点不同。",
                        lang,
                      )}{" "}
                      {!operations.dataset.syncCounts
                        ? adminText("同步计数未知，无法比较", lang)
                        : operations.dataset.countsMatch
                          ? adminText(
                              "已提供计数相同（提示词/图片/视频）",
                              lang,
                            )
                          : adminText(
                              "已提供计数不同（提示词/图片/视频）",
                              lang,
                            )}
                    </p>
                  </section>
                </div>
                <div className="admin-overview-grid">
                  <section className="admin-panel">
                    <header>
                      <h2>{adminText("索引与字节一致性", lang)}</h2>
                      <span
                        className={`admin-badge ${operations.reconcile.ran ? "active" : "disabled"}`}
                      >
                        {adminText(
                          operations.reconcile.ran
                            ? "已读取报告"
                            : "未读取到报告",
                          lang,
                        )}
                      </span>
                    </header>
                    {operations.reconcile.ran ? (
                      <pre className="admin-ops-pre">
                        {operations.reconcile.conclusion ||
                          JSON.stringify(operations.reconcile.report, null, 2)}
                      </pre>
                    ) : (
                      <>
                        <Empty>
                          {adminText("当前未读取到索引与字节核对报告。", lang)}
                        </Empty>
                        <p className="admin-footnote">
                          {adminText("运维命令", lang)}：
                          <code>{operations.reconcile.command}</code>
                        </p>
                      </>
                    )}
                  </section>
                  <section className="admin-panel">
                    <header>
                      <h2>{adminText("工作区存储分布（运维）", lang)}</h2>
                    </header>
                    <div className="admin-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>{adminText("存储字段（运维）", lang)}</th>
                            <th>{adminText("索引行", lang)}</th>
                            <th>{adminText("字节", lang)}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {operations.migration.storageDistribution.map(
                            (row) => (
                              <tr key={row.value}>
                                <td>
                                  <code>{row.value}</code>
                                </td>
                                <td>{displayNumber(row.rows)}</td>
                                <td>{displayBytes(row.bytes)}</td>
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    </div>
                    {!operations.migration.storageDistribution.length && (
                      <Empty>
                        {adminText("当前没有工作区文件索引行。", lang)}
                      </Empty>
                    )}
                    <h3 className="admin-subheading">
                      {adminText("生成结果存储分布（运维）", lang)}
                    </h3>
                    <div className="admin-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>{adminText("存储字段（运维）", lang)}</th>
                            <th>{adminText("索引行", lang)}</th>
                            <th>{adminText("字节", lang)}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {operations.migration.artifactStorageDistribution.map(
                            (row) => (
                              <tr key={row.value}>
                                <td>
                                  <code>{row.value}</code>
                                </td>
                                <td>{displayNumber(row.rows)}</td>
                                <td>{displayBytes(row.bytes)}</td>
                              </tr>
                            ),
                          )}
                        </tbody>
                      </table>
                    </div>
                    {!operations.migration.artifactStorageDistribution
                      .length && (
                      <Empty>
                        {adminText("当前没有生成结果索引行。", lang)}
                      </Empty>
                    )}
                  </section>
                </div>
              </>
            )}
          </>
        )}
        {section === "users" && (
          <section className="admin-panel">
            <header>
              <label className="admin-search">
                <MagnifyingGlass size={17} />
                <input
                  aria-label={adminText("搜索用户", lang)}
                  placeholder={adminText("搜索显示名称或邮箱", lang)}
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
              <button className="primary" onClick={() => open("create")}>
                <Plus size={17} />
                {adminText("创建用户", lang)}
              </button>
            </header>
            <div className="admin-table-wrap">
              <table className="admin-users-table">
                <thead>
                  <tr>
                    <th>{adminText("用户", lang)}</th>
                    <th>{adminText("状态", lang)}</th>
                    <th>{adminText("积分余额", lang)}</th>
                    <th>{adminText("模型权限", lang)}</th>
                    <th>{adminText("工作区内容", lang)}</th>
                    <th>{adminText("操作", lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <strong>{u.name}</strong>
                        <small>
                          {u.email || adminText("未设置邮箱", lang)}
                        </small>
                        <small
                          className="admin-user-created"
                          title={adminText("创建时间", lang)}
                        >
                          {displayTime(u.created_at)}
                        </small>
                      </td>
                      <td>
                        <Badge value={u.status} />
                        <small>
                          {adminText("邮箱", lang)} ·{" "}
                          {u.emailVerified
                            ? adminText("已验证", lang)
                            : adminText("未验证", lang)}
                        </small>
                      </td>
                      <td className="numeric admin-credit-cell">
                        <div className="admin-value-row">
                          <span>{adminText("可用", lang)}</span>
                          <strong>{displayNumber(u.storedPoints)}</strong>
                        </div>
                        <div className="admin-value-row">
                          <span>{adminText("账本", lang)}</span>
                          <span>{displayNumber(u.ledgerPoints)}</span>
                        </div>
                        {u.balanceMismatch && (
                          <small className="admin-error">
                            {adminText("余额减账本（积分）", lang)}{" "}
                            {u.balanceDifference}
                          </small>
                        )}
                        {u.textReviewRequests > 0 && (
                          <small>
                            {adminText("文本用量待核对", lang)} ·{" "}
                            {displayNumber(u.textReviewRequests)}
                          </small>
                        )}
                        {u.textReservedRequests > 0 && (
                          <small>
                            {adminText("文本预扣待结算", lang)} ·{" "}
                            {displayNumber(u.textReservedRequests)}
                          </small>
                        )}
                      </td>
                      <td>
                        {u.models.length
                          ? adminText("{n} 个模型", lang, {
                              n: u.models.length,
                            })
                          : adminText("全部已开放模型", lang)}
                      </td>
                      <td>
                        <div className="admin-content-counts">
                          <span
                            title={adminText(
                              "项目维度（老布局按有文件计 1）",
                              lang,
                            )}
                          >
                            {adminText("项目索引", lang)}{" "}
                            {displayNumber(u.projectCount)}
                          </span>
                          <span title={adminText("画布候选 JSON", lang)}>
                            {adminText("画布索引", lang)}{" "}
                            {displayNumber(u.canvasCount)}
                          </span>
                          <span>
                            {adminText("文件", lang)}{" "}
                            {displayNumber(u.fileCount)}
                          </span>
                        </div>
                        <small>
                          {adminText("MCP 令牌", lang)} ·{" "}
                          {u.mcpIssued
                            ? adminText("已签发", lang)
                            : adminText("未签发", lang)}
                        </small>
                      </td>
                      <td>
                        <div className="table-actions">
                          <button onClick={() => open("points", u)}>
                            {adminText("调积分", lang)}
                          </button>
                          <button onClick={() => open("permissions", u)}>
                            {adminText("权限", lang)}
                          </button>
                          <button onClick={() => openLedger(u)}>
                            {adminText("流水", lang)}
                          </button>
                          <button onClick={() => openUserStats(u)}>
                            {adminText("统计", lang)}
                          </button>
                          <button
                            onClick={() => {
                              setSection("generations");
                              setSearch("");
                              setFilter("");
                              setUserFilter(u.id);
                              setPage(1);
                            }}
                          >
                            {adminText("生成记录", lang)}
                          </button>
                          <button onClick={() => open("password", u)}>
                            {adminText("重置密码", lang)}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!visibleUsers.length && (
              <Empty>{adminText("当前筛选没有匹配账号。", lang)}</Empty>
            )}
            <footer className="admin-pagination">
              <span>
                {adminText("共 {n} 条 · 第 {page} 页", lang, {
                  n: users.total || 0,
                  page: users.page || page,
                })}
              </span>
              <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                {adminText("上一页", lang)}
              </button>
              <button
                disabled={page * (users.limit || 20) >= (users.total || 0)}
                onClick={() => setPage(page + 1)}
              >
                {adminText("下一页", lang)}
              </button>
            </footer>
          </section>
        )}
        {section === "models" &&
          (!overview ? (
            <Empty>{adminText("正在读取模型目录…", lang)}</Empty>
          ) : (
            <AdminModelsSection
              lang={lang}
              models={allModelRows as AdminModelRow[]}
              settings={overview.settings}
              costPolicy={overview.costPolicy || {}}
              search={search}
              kindFilter={kindFilter}
              busy={busy}
              onSearch={(value) => {
                setSearch(value);
                setPage(1);
              }}
              onKindFilter={(value) => {
                setKindFilter(value);
                setPage(1);
              }}
              onToggle={(model, enabled) =>
                act(
                  () =>
                    api("settings", "PATCH", {
                      models: { [model.id]: !enabled },
                    }),
                  adminText("模型状态已保存", lang),
                )
              }
              onOpenPrices={openPricing}
            />
          ))}
        {section === "legacy-models" && (
          <section className="admin-panel">
            <header>
              <div>
                <h2>{adminText("模型配置", lang)}</h2>
                <p className="admin-footnote">
                  {adminText(
                    "图片、视频、文本模型统一在这里控制。关闭后不会下发到客户网页端、桌面端或插件目录，服务端也会拒绝该模型请求。",
                    lang,
                  )}
                </p>
              </div>
              <button
                disabled={busy || !overview}
                onClick={() => {
                  const values = {
                    prices: buildPriceForm(),
                    textPrices: buildTextPriceForm(),
                    videoPricing: { ...overview.settings.videoPricing },
                  };
                  priceBaseline.current = structuredClone(values);
                  setForm(values);
                  setModal({ type: "prices" });
                }}
              >
                {adminText("价格设置", lang)}
              </button>
              <span className="admin-muted">
                {adminText("保存后用于新请求", lang)}
              </span>
            </header>
            <div className="admin-model-toolbar">
              <label className="admin-search">
                <MagnifyingGlass size={17} />
                <input
                  aria-label={lang === "en" ? "Search models" : "搜索模型"}
                  placeholder={
                    lang === "en" ? "Model name or ID" : "搜索模型名称或标识"
                  }
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <div className="admin-filter-buttons">
                {[
                  ["", lang === "en" ? "All" : "全部"],
                  ["image", adminText("图片", lang)],
                  ["video", adminText("视频", lang)],
                  ["text", adminText("文本", lang)],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    aria-pressed={kindFilter === key}
                    onClick={() => setKindFilter(key)}
                  >
                    {label}{" "}
                    <small>
                      {
                        allModelRows.filter((m) => !key || m.kind === key)
                          .length
                      }
                    </small>
                  </button>
                ))}
              </div>
            </div>
            <p className="admin-table-hint">
              {lang === "en"
                ? "Swipe horizontally to see the full table"
                : "左右滑动查看完整表格"}
            </p>
            <div className="admin-table-wrap">
              <table className="admin-models-table">
                <thead>
                  <tr>
                    <th>{adminText("模型", lang)}</th>
                    <th>{adminText("类型", lang)}</th>
                    <th>{adminText("通道状态", lang)}</th>
                    <th>{adminText("开放状态", lang)}</th>
                    <th>{adminText("积分 / 价格", lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {allModelRows
                    .filter(
                      (m) =>
                        (!kindFilter || m.kind === kindFilter) &&
                        (!search ||
                          `${m.label} ${m.id}`
                            .toLowerCase()
                            .includes(search.toLowerCase())),
                    )
                    .map((m) => {
                      const enabled = overview.settings.models[m.id] !== false,
                        rate =
                          m.kind === "text"
                            ? overview.costPolicy?.textModels?.[m.id]
                            : overview.costPolicy?.models?.[m.id];
                      if (m.kind === "text")
                        return (
                          <tr key={m.id}>
                            <td>
                              <strong>{m.label}</strong>
                              <small>{m.id}</small>
                            </td>
                            <td>{adminText("文本", lang)}</td>
                            <td>
                              <Badge
                                value={m.configured ? "已配置" : "未配置"}
                              />
                            </td>
                            <td>
                              <button
                                className={`admin-switch ${enabled ? "on" : ""}`}
                                role="switch"
                                aria-checked={enabled}
                                aria-label={
                                  lang === "en"
                                    ? `${m.label} availability`
                                    : `${m.label} 开放状态`
                                }
                                disabled={busy}
                                onClick={() =>
                                  act(
                                    () =>
                                      api("settings", "PATCH", {
                                        models: { [m.id]: !enabled },
                                      }),
                                    adminText("模型状态已保存", lang),
                                  )
                                }
                              >
                                <span />
                              </button>
                            </td>
                            <td>
                              <span className="admin-text-price-summary">
                                {textPriceSummary(m)}
                              </span>
                            </td>
                          </tr>
                        );
                      const automatic = rate?.pricingMode === "cost_plus";
                      const tiers = automatic
                        ? []
                        : m.video
                          ? Object.entries(rate?.creditsPerSecond || {})
                          : Object.entries(rate?.creditsPerImageBySize || {});
                      const fallback = m.video
                        ? rate?.defaultCreditsPerSecond
                        : rate?.creditsPerImage;
                      const amounts = (
                        tiers.length
                          ? tiers.map(([, value]) => value)
                          : [fallback]
                      )
                        .filter(
                          (value) =>
                            value != null && Number.isFinite(Number(value)),
                        )
                        .map(Number);
                      const low = amounts.length ? Math.min(...amounts) : null,
                        high = amounts.length ? Math.max(...amounts) : null;
                      const priceSummary =
                        low == null
                          ? "—"
                          : low === high
                            ? displayNumber(low)
                            : `${displayNumber(low)}–${displayNumber(high)}`;
                      return (
                        <tr key={m.id}>
                          <td>
                            <strong>{m.label}</strong>
                            <small>{m.id}</small>
                          </td>
                          <td>
                            {adminText(
                              m.kind === "video" ? "视频" : "图片",
                              lang,
                            )}
                          </td>
                          <td>
                            <Badge value={m.configured ? "已配置" : "未配置"} />
                          </td>
                          <td>
                            <button
                              className={`admin-switch ${enabled ? "on" : ""}`}
                              role="switch"
                              aria-checked={enabled}
                              aria-label={
                                lang === "en"
                                  ? `${m.label} availability`
                                  : `${m.label} 开放状态`
                              }
                              disabled={busy}
                              onClick={() =>
                                act(
                                  () =>
                                    api("settings", "PATCH", {
                                      models: { [m.id]: !enabled },
                                    }),
                                  adminText("模型状态已保存", lang),
                                )
                              }
                            >
                              <span />
                            </button>
                          </td>
                          <td>
                            {automatic ? (
                              <span>{adminText("按参数报价", lang)}</span>
                            ) : (
                              <details className="admin-price-details">
                                <summary
                                  aria-label={`${m.label} ${adminText("积分", lang)}`}
                                >
                                  <strong>{priceSummary}</strong>{" "}
                                  <span>
                                    {adminText(
                                      m.video ? "积分/秒" : "积分/张",
                                      lang,
                                    )}
                                  </span>
                                </summary>
                                <div className="admin-price-tiers">
                                  {(tiers.length
                                    ? tiers
                                    : [["", fallback]]
                                  ).map(([tier, value]) => (
                                    <div key={tier}>
                                      <span>
                                        {tier === "default" && !m.video
                                          ? lang === "en"
                                            ? "Other sizes"
                                            : "其他尺寸"
                                          : tier}
                                      </span>
                                      <strong>
                                        {value == null
                                          ? "—"
                                          : displayNumber(value)}
                                      </strong>
                                      <small>
                                        {adminText(
                                          m.video ? "积分/秒" : "积分/张",
                                          lang,
                                        )}
                                      </small>
                                    </div>
                                  ))}
                                </div>
                              </details>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {section === "upstream" && (
          <>
            <section className="admin-panel">
              <header>
                <h2>{adminText("秘塔余额快照核对（运维）", lang)}</h2>
                <span
                  className={`admin-badge ${upstream?.reconciliation?.some((r) => r.alarm) ? "failed" : "active"}`}
                >
                  {upstream?.reconciliation?.length
                    ? adminText("已有快照区间结论", lang)
                    : adminText("无快照区间结论", lang)}
                </span>
              </header>
              <p className="admin-footnote">
                {adminText(
                  "此处仅汇总秘塔余额快照区间；火山仅有调用密钥，当前未接入账单读取，须凭请求 ID 人工核对。",
                  lang,
                )}
              </p>
              {upstream?.models?.length ? (
                <div className="admin-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{adminText("模型", lang)}</th>
                        <th>{adminText("通道", lang)}</th>
                        <th>{adminText("最近调用（运维）", lang)}</th>
                        <th>{adminText("余额（上游积分）", lang)}</th>
                        <th>{adminText("核对方式（非账单）", lang)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {upstream.models.map((row) => (
                        <tr key={row.model}>
                          <td>
                            <strong>{row.label || row.model}</strong>
                            <small>
                              {adminText("运维标识", lang)}：{row.model}
                            </small>
                          </td>
                          <td>
                            {adminText(row.providerLabel, lang)}
                            <small>{row.provider}</small>
                          </td>
                          <td>{displayTime(row.latestCallAt)}</td>
                          <td>
                            {row.balance == null
                              ? adminText("未知", lang)
                              : row.balance}
                            <small>{displayTime(row.balanceAt)}</small>
                          </td>
                          <td>
                            {row.automaticReconciliation
                              ? adminText("余额快照区间核对", lang)
                              : adminText("凭请求 ID 人工查账", lang)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              <p className="admin-footnote">
                {adminText(
                  "上游积分余额与人民币推算成本单位不同；快照结论不等于账单实收，未知值以“未知”或“—”表示。",
                  lang,
                )}
              </p>
              {upstream?.snapshots?.length ? (
                <div className="admin-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{adminText("时间", lang)}</th>
                        <th>{adminText("通道", lang)}</th>
                        <th>{adminText("上游余额（上游积分）", lang)}</th>
                        <th>{adminText("区间余额减少（上游积分）", lang)}</th>
                        <th>{adminText("快照区间结论", lang)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {upstream.snapshots.slice(0, 10).map((s) => (
                        <tr key={s.id}>
                          <td>{displayTime(s.observed_at)}</td>
                          <td>{s.provider}</td>
                          <td>{s.balance}</td>
                          <td>
                            {upstream.reconciliation?.find(
                              (r) => r.to_at === s.observed_at,
                            )?.delta ?? adminText("未知", lang)}
                          </td>
                          <td>
                            {upstream.reconciliation?.find(
                              (r) => r.to_at === s.observed_at,
                            )?.conclusion
                              ? snapshotConclusionText(
                                  upstream.reconciliation.find(
                                    (r) => r.to_at === s.observed_at,
                                  ).conclusion,
                                  lang,
                                )
                              : adminText("无快照区间结论", lang)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty>{adminText("无快照区间结论；余额未知", lang)}</Empty>
              )}
              {upstream?.reconciliation?.some((r) => r.alarm) && (
                <p className="admin-error">
                  {adminText(
                    "快照差额高于计入预估调用；请凭请求 ID 逐笔核对实际扣费。",
                    lang,
                  )}
                </p>
              )}
              <h3 className="admin-subheading">
                {adminText("最近秘塔快照区间结论（最多 10 条）", lang)}
              </h3>
              {upstream?.reconciliation?.length ? (
                <div className="admin-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{adminText("区间", lang)}</th>
                        <th>{adminText("余额减少（上游积分）", lang)}</th>
                        <th>
                          {adminText(
                            "计入预估调用（含已提交；上游积分）",
                            lang,
                          )}
                        </th>
                        <th>{adminText("未解释差额（上游积分）", lang)}</th>
                        <th>{adminText("调用", lang)}</th>
                        <th>{adminText("结论", lang)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {upstream.reconciliation.slice(0, 10).map((r) => (
                        <tr key={r.id}>
                          <td>
                            {displayTime(r.from_at)} → {displayTime(r.to_at)}
                          </td>
                          <td>
                            {r.delta == null
                              ? adminText("未知", lang)
                              : r.delta}
                          </td>
                          <td>
                            {r.successful_estimated_credits == null
                              ? adminText("未知", lang)
                              : r.successful_estimated_credits}
                          </td>
                          <td>
                            {r.unexplained_credits == null
                              ? adminText("未知", lang)
                              : r.unexplained_credits}
                          </td>
                          <td>
                            {r.calls}（{r.failed_calls}{" "}
                            {adminText("其它状态", lang)}）
                          </td>
                          <td>
                            {snapshotConclusionText(r.conclusion, lang)}
                            {r.details && (
                              <details>
                                <summary>{adminText("查看", lang)}</summary>
                                <pre>{JSON.stringify(r.details, null, 2)}</pre>
                              </details>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty>{adminText("无快照区间结论；余额未知", lang)}</Empty>
              )}
            </section>
            {upstream?.calls?.some(
              (row) =>
                row.provider === "ark" &&
                [
                  "rejected",
                  "failed",
                  "failed_after_submit",
                  "cancelled_after_submit",
                  "submitted",
                  "submission_unknown",
                ].includes(row.status),
            ) ? (
              <section className="admin-panel">
                <header>
                  <h2>{adminText("当前留档页待人工核对的火山调用", lang)}</h2>
                  <span className="admin-muted">
                    {adminText("火山账单需人工核对", lang)}
                  </span>
                </header>
                <p className="admin-footnote">
                  {adminText(
                    "火山仅有调用密钥，当前未接入账单读取；成本按价目推算，失败、拒绝或取消是否扣费需凭请求 ID 人工确认。",
                    lang,
                  )}
                </p>
                <div className="admin-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{adminText("时间", lang)}</th>
                        <th>{adminText("模型", lang)}</th>
                        <th>{adminText("状态", lang)}</th>
                        <th>{adminText("上游请求 ID（运维）", lang)}</th>
                        <th>{adminText("错误", lang)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {upstream.calls
                        .filter(
                          (row) =>
                            row.provider === "ark" &&
                            [
                              "rejected",
                              "failed",
                              "failed_after_submit",
                              "cancelled_after_submit",
                              "submitted",
                              "submission_unknown",
                            ].includes(row.status),
                        )
                        .map((row) => (
                          <tr key={`manual-${row.id}`}>
                            <td>{displayTime(row.created_at)}</td>
                            <td>{row.model}</td>
                            <td>
                              <Badge value={row.status} />
                            </td>
                            <td className="id-cell">
                              {row.upstream_request_id || row.requestId || "—"}
                            </td>
                            <td className="admin-error">{row.error || "—"}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
            <section className="admin-panel">
              <header>
                <h2>{adminText("余额差推算率（运维）", lang)}</h2>
                <span className="admin-muted">
                  {adminText("同次调用余额差合计 ÷ 匹配样本秒数", lang)}
                </span>
              </header>
              <p className="admin-footnote">
                {adminText(
                  "余额差仅匹配同次调用的正时长；共享上游账号的其他请求也可能改变余额，不能当作逐单账单。成本均值排除未知值，全缺时显示未知。",
                  lang,
                )}{" "}
                {adminText(
                  "文本通道调用未纳入媒体留档与成本统计，不代表文本成本为 0；每笔媒体推算依据保留在运维原始字段中。",
                  lang,
                )}
              </p>
              {upstream?.derived?.length ? (
                <div className="admin-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{adminText("模型", lang)}</th>
                        <th>{adminText("档位", lang)}</th>
                        <th>{adminText("余额差推算率（运维）", lang)}</th>
                        <th>{adminText("有余额差的调用条数", lang)}</th>
                        <th>
                          {adminText("留档成本均值（元；未知不算零）", lang)}
                        </th>
                        <th>{adminText("最近调用（运维）", lang)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {upstream.derived.map((row) => (
                        <tr
                          key={`${row.provider}-${row.model}-${row.tier}-${row.has_input_video}`}
                        >
                          <td>
                            <strong>{row.model}</strong>
                            <small>{row.provider}</small>
                            {row.generationRequestId && (
                              <button
                                onClick={() =>
                                  openRecord({
                                    requestId: row.generationRequestId,
                                  })
                                }
                              >
                                {adminText("生成详情", lang)}
                              </button>
                            )}
                          </td>
                          <td>
                            {row.tier || "—"}
                            <small>
                              {adminText(
                                row.has_input_video
                                  ? "有参考视频"
                                  : "无参考视频",
                                lang,
                              )}
                            </small>
                          </td>
                          <td>
                            {row.derivedCreditsPerSecond != null &&
                            row.derivedCreditsPerSecond !== 0
                              ? `${row.derivedCreditsPerSecond} ${adminText("上游积分/秒", lang)}`
                              : adminText(
                                  row.derivedCreditsPerSecond === 0
                                    ? "有余额差样本，但余额差合计为 0，未形成推算单价"
                                    : row.note,
                                  lang,
                                )}
                          </td>
                          <td>
                            {row.samplesWithCredits == null
                              ? "—"
                              : row.samplesWithCredits}
                          </td>
                          <td>
                            {row.avgCost == null
                              ? adminText("未知", lang)
                              : `¥${Number(row.avgCost).toFixed(4)}`}
                            <small>
                              {row.samplesWithCost} / {row.calls}{" "}
                              {adminText("条有成本样本", lang)}
                            </small>
                          </td>
                          <td>{displayTime(row.lastSeen)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty>
                  {adminText(
                    "当前没有媒体调用留档；留档包含请求、响应及已获得的用量与推算成本。",
                    lang,
                  )}
                </Empty>
              )}
            </section>
            <section className="admin-panel">
              <header>
                <h2>{adminText("媒体调用留档（可翻页检索）", lang)}</h2>
                <span className="admin-muted">
                  {adminText("共 {n} 条 · 第 {page} 页", lang, {
                    n: upstream?.total || 0,
                    page,
                  })}
                </span>
                <label className="admin-search">
                  <input
                    aria-label={adminText("搜索上游留档", lang)}
                    placeholder={adminText(
                      "搜索模型、通道、上游 ID 或错误",
                      lang,
                    )}
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                  />
                </label>
              </header>
              {upstream?.calls?.length ? (
                <div className="admin-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{adminText("时间", lang)}</th>
                        <th>{adminText("模型", lang)}</th>
                        <th>{adminText("档位", lang)}</th>
                        <th>{adminText("用量（运维节选）", lang)}</th>
                        <th>{adminText("推算成本（元）", lang)}</th>
                        <th>{adminText("余额减少（上游积分）", lang)}</th>
                        <th>{adminText("上游调用状态", lang)}</th>
                        <th>{adminText("上游请求 ID（运维）", lang)}</th>
                        <th>{adminText("错误", lang)}</th>
                        <th>{adminText("请求与响应（运维节选）", lang)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {upstream.calls.map((row) => (
                        <tr key={row.id}>
                          <td>{displayTime(row.created_at)}</td>
                          <td>
                            <strong>{row.model}</strong>
                            <small>{row.provider}</small>
                            {row.generationRequestId && (
                              <button
                                onClick={() =>
                                  openRecord({
                                    requestId: row.generationRequestId,
                                  })
                                }
                              >
                                {adminText("生成详情", lang)}
                              </button>
                            )}
                          </td>
                          <td>
                            {row.tier || "—"}
                            {row.seconds
                              ? ` · ${row.seconds}${adminText("秒", lang)}`
                              : ""}
                          </td>
                          <td>
                            {row.usage
                              ? JSON.stringify(row.usage).slice(0, 60)
                              : "—"}
                          </td>
                          <td>
                            {row.cost_rmb != null ? `¥${row.cost_rmb}` : "—"}
                            <small>
                              {adminText(
                                row.costEvidence?.label || "成本未知",
                                lang,
                              )}{" "}
                              · {adminText("待账单核对", lang)}
                            </small>
                            <small>
                              {row.cost_basis
                                ? `${adminText("运维推算依据", lang)}：${row.cost_basis}`
                                : ""}
                            </small>
                          </td>
                          <td>
                            {row.credits_delta != null
                              ? row.credits_delta
                              : "—"}
                          </td>
                          <td>
                            <Badge value={row.status || "unknown"} />
                          </td>
                          <td className="id-cell">
                            {row.upstream_request_id ||
                              row.requestId ||
                              row.upstreamRequestId ||
                              "—"}
                          </td>
                          <td className="admin-error">{row.error || "—"}</td>
                          <td>
                            <details>
                              <summary>{adminText("查看", lang)}</summary>
                              <pre>
                                {JSON.stringify(
                                  {
                                    request: row.request,
                                    response: row.response,
                                    usage: row.usage,
                                    cost: row.cost,
                                    costEvidence: row.costEvidence,
                                    updatedAt: row.updated_at,
                                  },
                                  null,
                                  2,
                                )}
                              </pre>
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty>
                  {adminText(
                    "当前没有媒体调用留档；留档包含请求、响应及已获得的用量与推算成本。",
                    lang,
                  )}
                </Empty>
              )}
              <footer className="admin-pagination">
                <span>
                  {adminText("共 {n} 条 · 第 {page} 页", lang, {
                    n: upstream?.total || 0,
                    page,
                  })}
                </span>
                <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                  {adminText("上一页", lang)}
                </button>
                <button
                  disabled={
                    page * (upstream?.limit || 30) >= (upstream?.total || 0)
                  }
                  onClick={() => setPage(page + 1)}
                >
                  {adminText("下一页", lang)}
                </button>
              </footer>
            </section>
          </>
        )}
        {section === "generations" && (
          <section className="admin-panel">
            <header className="admin-filter-header">
              <label className="admin-search">
                <MagnifyingGlass size={17} />
                <input
                  aria-label={adminText("搜索生成记录", lang)}
                  placeholder={adminText(
                    "搜索用户、模型、提示词或关联 ID",
                    lang,
                  )}
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
              {userFilter && (
                <button
                  onClick={() => {
                    setUserFilter("");
                    setPage(1);
                  }}
                >
                  {adminText("清除用户筛选", lang)}
                </button>
              )}
              <div className="admin-filter-buttons">
                {[
                  ["", adminText("全部", lang)],
                  ["queued", adminText("排队中", lang)],
                  ["running", adminText("生成中", lang)],
                  ["succeeded", adminText("已完成", lang)],
                  ["failed", adminText("失败", lang)],
                  ["cancelled", adminText("已取消", lang)],
                  ["expired", adminText("已过期", lang)],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    aria-pressed={filter === key}
                    onClick={() => {
                      setFilter(key);
                      setPage(1);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <select
                aria-label={adminText("按媒体类型筛选", lang)}
                value={kindFilter}
                onChange={(e) => {
                  setKindFilter(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">{adminText("全部类型", lang)}</option>
                <option value="image">{adminText("图片", lang)}</option>
                <option value="video">{adminText("视频", lang)}</option>
              </select>
              <select
                aria-label={adminText("按模型筛选", lang)}
                value={modelFilter}
                onChange={(e) => {
                  setModelFilter(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">{adminText("全部模型", lang)}</option>
                {[...modelList, ...videoList].map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <button onClick={exportPage}>
                <DownloadSimple size={16} />
                {adminText("导出当前页", lang)}
              </button>
            </header>
            {records.reconciliation && (
              <p className="admin-footnote">
                {adminText(
                  "全库关联统计（不随筛选变化）：{requests} 条 · 有上游 ID {linked} 条 · 有通道无上游 ID {unlinked} 条 · 有用量字段 {usage} 条",
                  lang,
                  {
                    requests: displayNumber(records.reconciliation.requests),
                    linked: displayNumber(records.reconciliation.linkedRows),
                    unlinked: displayNumber(
                      records.reconciliation.unlinkedRows,
                    ),
                    usage: displayNumber(records.reconciliation.usageRows),
                  },
                )}
              </p>
            )}
            <div className="admin-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{adminText("时间 / 用户", lang)}</th>
                    <th>{adminText("模型标识 / 通道（运维）", lang)}</th>
                    <th>{adminText("提示词", lang)}</th>
                    <th>{adminText("状态", lang)}</th>
                    <th>{adminText("实扣积分", lang)}</th>
                    <th>{adminText("详情", lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {records.items.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {displayTime(r.created_at)}
                        <small>{r.actor}</small>
                      </td>
                      <td>
                        {modelList.find((m) => m.id === r.model)?.label ||
                          r.model}
                        <small>{r.provider || "—"}</small>
                      </td>
                      <td className="prompt-cell">{r.prompt}</td>
                      <td>
                        <Badge value={r.status} />
                      </td>
                      <td>{r.chargedPoints ?? r.points}</td>
                      <td>
                        <button onClick={() => openRecord(r)}>
                          {adminText("查看", lang)}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!records.items.length && (
              <Empty>{adminText("没有符合条件的生成记录。", lang)}</Empty>
            )}
            <footer className="admin-pagination">
              <span>
                {adminText("共 {n} 条 · 第 {page} 页", lang, {
                  n: records.total,
                  page,
                })}
              </span>
              <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                {adminText("上一页", lang)}
              </button>
              <button
                disabled={page * (records.limit || 30) >= records.total}
                onClick={() => setPage(page + 1)}
              >
                {adminText("下一页", lang)}
              </button>
            </footer>
          </section>
        )}
        {section === "payments" && (
          <>
            <div className="admin-metrics admin-payment-metrics">
              {[
                [
                  adminText("UTC 今日已支付订单金额", lang),
                  `¥${displayNumber((overview?.payments?.summary?.todayCents || 0) / 100)}`,
                  `${displayNumber(overview?.payments?.summary?.todayOrders || 0)} ${adminText("笔", lang)}`,
                ],
                [
                  adminText("UTC 本月已支付订单金额", lang),
                  `¥${displayNumber((overview?.payments?.summary?.monthCents || 0) / 100)}`,
                  `${displayNumber(overview?.payments?.summary?.monthOrders || 0)} ${adminText("笔", lang)}`,
                ],
                [
                  adminText("累计已支付订单金额", lang),
                  `¥${displayNumber((overview?.payments?.summary?.paidCents || 0) / 100)}`,
                  `${displayNumber(overview?.payments?.summary?.paid || 0)} ${adminText("笔", lang)}`,
                ],
              ].map(([label, value, sub]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                  <small>{sub}</small>
                </div>
              ))}
            </div>
            <section className="admin-panel">
              <header className="admin-filter-header">
                <label className="admin-search">
                  <MagnifyingGlass size={17} />
                  <input
                    aria-label={adminText("搜索充值订单", lang)}
                    placeholder={adminText(
                      "搜索订单号、用户或上游订单号",
                      lang,
                    )}
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                  />
                </label>
                <div className="admin-filter-buttons">
                  {[
                    ["", adminText("全部", lang)],
                    ["created", adminText("待支付", lang)],
                    ["paid", adminText("已支付", lang)],
                    ["closed", adminText("已关闭", lang)],
                    ["failed", adminText("失败", lang)],
                    ["expired", adminText("已过期", lang)],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      aria-pressed={filter === key}
                      onClick={() => {
                        setFilter(key);
                        setPage(1);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </header>
              <p className="admin-footnote">
                {adminText(
                  "订单金额为人民币元，订单积分为计划到账积分；仅已支付订单完成入账，赠送积分不计入充值。",
                  lang,
                )}
              </p>
              <div className="admin-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{adminText("时间 / 用户", lang)}</th>
                      <th>{adminText("订单号", lang)}</th>
                      <th>{adminText("充值方式", lang)}</th>
                      <th>{adminText("支付方式", lang)}</th>
                      <th>{adminText("订单金额（元）", lang)}</th>
                      <th>{adminText("计划到账积分", lang)}</th>
                      <th>{adminText("实际到账积分（账本）", lang)}</th>
                      <th>{adminText("状态", lang)}</th>
                      <th>{adminText("支付成功时间", lang)}</th>
                      <th>{adminText("失败原因", lang)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paymentOrders.items.map((item) => (
                      <tr key={item.outTradeNo}>
                        <td>
                          {displayTime(item.createdAt)}
                          <small>
                            {item.userName} ·{" "}
                            {item.userEmail || adminText("未设置邮箱", lang)}
                          </small>
                        </td>
                        <td className="id-cell">
                          {item.outTradeNo}
                          <small>
                            {item.upstreamTradeNo ||
                              adminText("未记录上游单号", lang)}
                          </small>
                        </td>
                        <td>{item.packageName || "—"}</td>
                        <td>{paymentTypeLabel(item.paymentType, lang)}</td>
                        <td>¥{item.amount}</td>
                        <td>{`${displayNumber(item.points)} ${adminText("积分", lang)}`}</td>
                        <td>
                          {displayNumber(item.postedPoints)}
                          {item.status === "paid" &&
                            Number(item.postedPoints) !==
                              Number(item.points) && (
                              <small className="admin-error">
                                {adminText("到账账本与订单不一致", lang)}
                              </small>
                            )}
                        </td>
                        <td>
                          <Badge value={item.status} />
                        </td>
                        <td>{displayTime(item.completedAt)}</td>
                        <td>{adminText(item.failureReason || "—", lang)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!paymentOrders.items.length && (
                <Empty>{adminText("还没有充值订单。", lang)}</Empty>
              )}
              <footer className="admin-pagination">
                <span>
                  {adminText("共 {n} 条 · 第 {page} 页", lang, {
                    n: paymentOrders.total,
                    page,
                  })}
                </span>
                <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                  {adminText("上一页", lang)}
                </button>
                <button
                  disabled={
                    page * (paymentOrders.limit || 30) >= paymentOrders.total
                  }
                  onClick={() => setPage(page + 1)}
                >
                  {adminText("下一页", lang)}
                </button>
              </footer>
            </section>
          </>
        )}

        {section === "feedback" && <AdminFeedback api={api} lang={lang} />}
        {section === "audit" && (
          <section className="admin-panel">
            <header>
              <h2>{adminText("最近操作记录", lang)}</h2>
              <span className="admin-muted">
                {adminText("共 {n} 条 · 第 {page} 页", lang, {
                  n: audits.total,
                  page,
                })}
              </span>
              <label className="admin-search">
                <input
                  aria-label={adminText("搜索操作记录", lang)}
                  placeholder={adminText("搜索用户、邮箱或事件", lang)}
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
            </header>
            <div className="admin-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{adminText("时间", lang)}</th>
                    <th>{adminText("记录发起方", lang)}</th>
                    <th>{adminText("操作", lang)}</th>
                    <th>{adminText("操作对象", lang)}</th>
                    <th>{adminText("事件详情", lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {audits.items.map((r) => (
                    <tr key={r.id}>
                      <td>{displayTime(r.created_at)}</td>
                      <td>{adminText(r.actor, lang)}</td>
                      <td>
                        {auditLabels[r.action]
                          ? adminText(auditLabels[r.action], lang)
                          : String(r.action).startsWith("user.login.")
                            ? adminText("第三方登录", lang)
                            : `${adminText("运维事件标识", lang)}: ${r.action}`}
                      </td>
                      <td className="id-cell">
                        {r.targetName || r.details?.name || r.target}
                      </td>
                      <td>
                        <details>
                          <summary>{adminText("查看内容", lang)}</summary>
                          <pre>{JSON.stringify(r.details, null, 2)}</pre>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!audits.items.length && (
              <Empty>
                {adminText("当前没有账户、支付或管理事件记录。", lang)}
              </Empty>
            )}
            <footer className="admin-pagination">
              <span>
                {adminText("共 {n} 条 · 第 {page} 页", lang, {
                  n: audits.total,
                  page,
                })}
              </span>
              <button disabled={page === 1} onClick={() => setPage(page - 1)}>
                {adminText("上一页", lang)}
              </button>
              <button
                disabled={page * (audits.limit || 30) >= audits.total}
                onClick={() => setPage(page + 1)}
              >
                {adminText("下一页", lang)}
              </button>
            </footer>
          </section>
        )}
      </main>
      {modal?.type === "prices" && (
        <Modal
          lang={lang}
          title={adminText("全部模型积分设置", lang)}
          onClose={close}
        >
          <form className="pricing-form" onSubmit={submit}>
            <AdminPricingEditor
              lang={lang}
              models={allModelRows as AdminModelRow[]}
              costPolicy={overview?.costPolicy || {}}
              settings={overview?.settings || {}}
              form={form}
              setForm={setForm}
              initialFocus={pricingFocus}
            />
            {error && (
              <p role="alert" className="admin-error">
                {error}
              </p>
            )}
            <footer>
              <button type="button" onClick={close} disabled={busy}>
                {adminText("取消", lang)}
              </button>
              <button className="primary" disabled={busy}>
                {busy
                  ? adminText("正在保存…", lang)
                  : adminText("保存全部积分", lang)}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {modal && modal.type !== "prices" && (
        <Modal
          lang={lang}
          title={
            modal.type === "create"
              ? adminText("创建用户", lang)
              : modal.type === "points"
                ? adminText("调整 {name} 的积分", lang, {
                    name: modal.data.name,
                  })
                : modal.type === "permissions"
                  ? adminText("设置 {name} 的权限", lang, {
                      name: modal.data.name,
                    })
                  : modal.type === "password"
                    ? adminText("重置 {name} 的密码", lang, {
                        name: modal.data.name,
                      })
                    : modal.type === "passwordResult"
                      ? adminText("一次性密码", lang)
                      : modal.type === "code"
                        ? adminText("用户登录码", lang)
                        : modal.type === "rotate"
                          ? adminText("更换用户登录码", lang)
                          : modal.type === "settings"
                            ? adminText("生成服务设置", lang)
                            : modal.type === "ledger"
                              ? adminText("{name} 的积分账本", lang, {
                                  name: modal.data.name,
                                })
                              : modal.type === "stats"
                                ? adminText("{name} 的账号统计", lang, {
                                    name: modal.data.name,
                                  })
                                : adminText("生成详情", lang)
          }
          onClose={close}
        >
          {[
            "create",
            "points",
            "permissions",
            "settings",
            "rotate",
            "password",
            "prices",
          ].includes(modal.type) && (
            <form onSubmit={submit}>
              {modal.type === "prices" && (
                <>
                  <details
                    className="admin-price-advanced"
                    onInvalidCapture={(event) => {
                      const field = event.target as HTMLElement;
                      const details = field.closest("details");
                      if (details) details.open = true;
                    }}
                  >
                    <summary>{adminText("成本参数", lang)}</summary>
                    <fieldset className="admin-price-group">
                      <legend>{adminText("视频成本与净利目标", lang)}</legend>
                      <label className="admin-price-row">
                        <span>{adminText("秘塔每积分成本（元）", lang)}</span>
                        <input
                          aria-label={adminText("秘塔每积分成本（元）", lang)}
                          type="number"
                          required
                          min="0.008798"
                          max="1"
                          step="0.000001"
                          value={
                            form.videoPricing?.metasoRmbPerCredit ?? 0.0108
                          }
                          onChange={(e) =>
                            setForm({
                              ...form,
                              videoPricing: {
                                ...form.videoPricing,
                                metasoRmbPerCredit: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                      <label className="admin-price-row">
                        <span>
                          {lang === "en"
                            ? "Server allocation"
                            : "服务器分摊方式"}
                        </span>
                        <select
                          value={
                            form.videoPricing?.serverAllocationMode ||
                            "video_seconds"
                          }
                          onChange={(e) =>
                            setForm({
                              ...form,
                              videoPricing: {
                                ...form.videoPricing,
                                serverAllocationMode: e.target.value,
                              },
                            })
                          }
                        >
                          <option value="all_media_requests">
                            {lang === "en"
                              ? "All image and video requests"
                              : "全站图片与视频请求共同分摊"}
                          </option>
                          <option value="video_seconds">
                            {lang === "en"
                              ? "Video output seconds"
                              : "按视频生成秒数分摊"}
                          </option>
                        </select>
                      </label>
                      <label className="admin-price-row">
                        <span>{adminText("目标净利每秒（元）", lang)}</span>
                        <input
                          aria-label={adminText("目标净利每秒（元）", lang)}
                          type="number"
                          required
                          min="0.10"
                          max="100"
                          step="0.01"
                          value={form.videoPricing?.markupPerSecond ?? 0.1}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              videoPricing: {
                                ...form.videoPricing,
                                markupPerSecond: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                      {[
                        {
                          key: "paymentFeePercent",
                          label: "支付总手续费（%）",
                          min: "0",
                          max: "50",
                          step: "0.01",
                        },
                        {
                          key: "serverAnnualUsd",
                          label: "服务器年费（美元）",
                          min: "0",
                          max: "1000000",
                          step: "0.01",
                        },
                        {
                          key: "usdToRmb",
                          label: "预算汇率（元/美元）",
                          min: "0.000001",
                          max: "100",
                          step: "0.000001",
                        },
                        {
                          key: "serverMonthlyRmb",
                          label: "服务器月费（元，可覆盖美元折算）",
                          min: "0",
                          max: "1000000",
                          step: "0.01",
                        },
                        {
                          key: "monthlyMediaRequests",
                          label: "预计每月图片与视频请求数",
                          min: "1",
                          max: "10000000000",
                          step: "1",
                        },
                        {
                          key: "monthlyBillableVideoSeconds",
                          label: "预计每月付费生成视频秒数",
                          min: "1",
                          max: "10000000000",
                          step: "1",
                        },
                        {
                          key: "otherRmbPerSecond",
                          label: "其他成本（元/生成秒）",
                          min: "0",
                          max: "10000",
                          step: "0.000001",
                        },
                      ].map((field) => (
                        <label key={field.key} className="admin-price-row">
                          <span>{adminText(field.label, lang)}</span>
                          <input
                            aria-label={adminText(field.label, lang)}
                            type="number"
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            value={form.videoPricing?.[field.key] ?? ""}
                            onChange={(e) =>
                              setForm({
                                ...form,
                                videoPricing: {
                                  ...form.videoPricing,
                                  [field.key]:
                                    e.target.value === ""
                                      ? null
                                      : Number(e.target.value),
                                },
                              })
                            }
                          />
                        </label>
                      ))}
                      <p role="status" className="admin-muted">
                        {adminText(
                          hasVideoExpenses(form.videoPricing)
                            ? "成本已配置：按预计付费生成量分摊，实际生成量下降时应重新调整。"
                            : "成本未配置完整：已知费用计入报价，缺失项尚未计入，不能确认净利达标。",
                          lang,
                        )}
                      </p>
                    </fieldset>
                  </details>
                  {textPriceEditor()}
                  <p className="admin-footnote">
                    {lang === "en"
                      ? "Custom media rates are saved to two decimal places. For videos quoted by parameters, edit cost parameters above."
                      : "自定义媒体单价保存为两位小数；按参数报价的视频请修改上方成本参数。"}
                  </p>
                  {priceSections.map((section) => (
                    <fieldset key={section.id} className="admin-price-group">
                      <legend>{section.label}</legend>
                      {section.tiers.map((tier) => (
                        <label key={tier.key} className="admin-price-row">
                          <span>{tier.label}</span>
                          <input
                            type="number"
                            required
                            min="0.01"
                            max="10000"
                            step="any"
                            value={
                              form.prices?.[section.id]?.[section.kind]?.[
                                tier.key
                              ] ?? ""
                            }
                            onChange={(e) =>
                              updatePrice(
                                section.id,
                                section.kind,
                                tier.key,
                                e.target.value,
                              )
                            }
                          />
                          <em>
                            {section.kind === "video"
                              ? adminText("每秒积分", lang)
                              : adminText("每张积分", lang)}
                          </em>
                        </label>
                      ))}
                    </fieldset>
                  ))}
                </>
              )}
              {modal.type === "create" && (
                <>
                  <label>
                    {adminText("邮箱", lang)}
                    <input
                      required
                      type="email"
                      value={form.email}
                      onChange={(e) =>
                        setForm({ ...form, email: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    {adminText("初始密码", lang)}
                    <input
                      required
                      type="password"
                      minLength={8}
                      value={form.password}
                      onChange={(e) =>
                        setForm({ ...form, password: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    {adminText("显示名称（可选）", lang)}
                    <input
                      maxLength={60}
                      value={form.name}
                      onChange={(e) =>
                        setForm({ ...form, name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    {adminText("初始赠送积分", lang)}
                    <input
                      type="number"
                      min="0"
                      max="1000000"
                      step="0.01"
                      required
                      value={form.points}
                      onChange={(e) =>
                        setForm({ ...form, points: e.target.value })
                      }
                    />
                  </label>
                  <p className="admin-muted">
                    {adminText("用户使用邮箱和密码登录工作台。", lang)}
                  </p>
                </>
              )}
              {modal.type === "points" && (
                <>
                  <p>
                    {adminText("账本累计（积分）", lang)}{" "}
                    <strong>{`${modal.data.points} ${adminText("积分", lang)}`}</strong>
                  </p>
                  <label>
                    {adminText("调整积分", lang)}
                    <input
                      type="number"
                      required
                      min="-1000000"
                      max="1000000"
                      step="0.01"
                      value={form.delta}
                      onChange={(e) =>
                        setForm({ ...form, delta: e.target.value })
                      }
                    />
                    <small>{adminText("正数增加，负数扣减。", lang)}</small>
                  </label>
                  <label>
                    {adminText("调整原因", lang)}
                    <textarea
                      required
                      maxLength={200}
                      value={form.reason}
                      onChange={(e) =>
                        setForm({ ...form, reason: e.target.value })
                      }
                    />
                  </label>
                </>
              )}
              {modal.type === "permissions" && (
                <>
                  <label className="admin-check">
                    <input
                      type="checkbox"
                      checked={form.status === "active"}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          status: e.target.checked ? "active" : "disabled",
                        })
                      }
                    />
                    {adminText("允许账号登录与申请生成", lang)}
                  </label>
                  <fieldset>
                    <legend>{adminText("可用模型", lang)}</legend>
                    <p className="admin-muted">
                      {adminText("不勾选表示可以使用全部已开放模型。", lang)}
                    </p>
                    {allModelRows.map((m) => (
                      <label className="admin-check" key={m.id}>
                        <input
                          type="checkbox"
                          checked={form.models.includes(m.id)}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              models: e.target.checked
                                ? [...form.models, m.id]
                                : form.models.filter((id) => id !== m.id),
                            })
                          }
                        />
                        <span>
                          {m.label}
                          <small>
                            {adminText(
                              m.kind === "text"
                                ? "文本"
                                : m.kind === "video"
                                  ? "视频"
                                  : "图片",
                              lang,
                            )}
                          </small>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                </>
              )}
              {modal.type === "settings" && (
                <>
                  <label className="admin-check">
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(e) =>
                        setForm({ ...form, enabled: e.target.checked })
                      }
                    />
                    {adminText("开启生成总开关（含图片/视频）", lang)}
                  </label>
                  <label className="admin-check">
                    <input
                      type="checkbox"
                      checked={form.videoEnabled !== false}
                      onChange={(e) =>
                        setForm({ ...form, videoEnabled: e.target.checked })
                      }
                    />
                    {adminText("开启视频生成", lang)}
                  </label>
                  <label className="admin-check">
                    <input
                      type="checkbox"
                      checked={form.registrationEnabled}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          registrationEnabled: e.target.checked,
                        })
                      }
                    />
                    {adminText("开放用户注册", lang)}
                  </label>
                  <label>
                    {adminText("每账号同时生成上限", lang)}
                    <input value={adminText("不设数量上限", lang)} readOnly />
                  </label>
                  <fieldset>
                    <legend>{adminText("默认图片模型", lang)}</legend>
                    {modelList.map((m) => (
                      <label className="admin-check" key={m.id}>
                        <input
                          type="radio"
                          name="defaultModel"
                          checked={form.defaultModel === m.id}
                          disabled={
                            !m.configured ||
                            overview.settings.models[m.id] === false
                          }
                          onChange={() =>
                            setForm({ ...form, defaultModel: m.id })
                          }
                        />
                        {m.label}
                      </label>
                    ))}
                  </fieldset>
                  <fieldset>
                    <legend>{adminText("默认文本模型", lang)}</legend>
                    {textModels.map((m) => (
                      <label className="admin-check" key={m.id}>
                        <input
                          type="radio"
                          name="defaultTextModel"
                          checked={form.defaultTextModel === m.id}
                          disabled={
                            !m.configured ||
                            overview.settings.models[m.id] === false
                          }
                          onChange={() =>
                            setForm({ ...form, defaultTextModel: m.id })
                          }
                        />
                        {m.label}
                      </label>
                    ))}
                  </fieldset>
                </>
              )}
              {modal.type === "rotate" && (
                <p>
                  {adminText(
                    "为 {name} 生成新登录码。旧登录码和现有登录会立即失效。",
                    lang,
                    { name: modal.data.name },
                  )}
                </p>
              )}
              {modal.type === "password" && (
                <>
                  <p>
                    {adminText(
                      "为 {name} 重置登录密码；现有登录会立即失效。",
                      lang,
                      { name: modal.data.name },
                    )}
                  </p>
                  <label>
                    {adminText("新密码", lang)}
                    <input
                      required
                      type="password"
                      minLength={8}
                      value={form.password || ""}
                      onChange={(e) =>
                        setForm({ ...form, password: e.target.value })
                      }
                    />
                  </label>
                </>
              )}
              {error && (
                <p role="alert" className="admin-error">
                  {error}
                </p>
              )}
              <footer>
                <button type="button" onClick={close} disabled={busy}>
                  {adminText("取消", lang)}
                </button>
                <button className="primary" disabled={busy}>
                  {busy
                    ? adminText("正在保存…", lang)
                    : modal.type === "create"
                      ? adminText("创建用户", lang)
                      : modal.type === "rotate"
                        ? adminText("生成新登录码", lang)
                        : modal.type === "password"
                          ? adminText("重置密码", lang)
                          : modal.type === "prices"
                            ? adminText("保存价格", lang)
                            : adminText("保存修改", lang)}
                </button>
              </footer>
            </form>
          )}
          {modal.type === "passwordResult" && (
            <div className="admin-code">
              <ShieldCheck size={32} />
              <p>
                {adminText(
                  modal.data.created
                    ? "账号已创建，登录密码只显示这一次。"
                    : "密码已重置，新密码只显示这一次。",
                  lang,
                )}
              </p>
              <label>
                {adminText("密码", lang)}
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  readOnly
                  value={modal.data.password}
                  aria-label={adminText("一次性密码", lang)}
                />
              </label>
              <p className="admin-muted">
                {adminText(
                  "服务器只保存不可逆密码哈希；关闭后无法查看原密码，只能再次重置。",
                  lang,
                )}
              </p>
              <button className="primary" onClick={copySecret}>
                <Copy size={17} />
                {copied
                  ? adminText("已复制", lang)
                  : adminText("复制密码", lang)}
              </button>
            </div>
          )}
          {modal.type === "code" && (
            <div className="admin-code">
              <ShieldCheck size={32} />
              <p>
                {adminText("{name} 的登录码已生成。", lang, {
                  name: modal.data.name,
                })}
              </p>
              <label>
                {adminText("登录码", lang)}
                <input
                  type="password"
                  readOnly
                  value={modal.data.accessCode}
                  aria-label={adminText("用户登录码", lang)}
                />
              </label>
              <p className="admin-muted">
                {adminText(
                  "登录码仅本次显示；需重新生成时使用管理接口。",
                  lang,
                )}
              </p>
              <button className="primary" onClick={copySecret}>
                <Copy size={17} />
                {copied
                  ? adminText("已复制", lang)
                  : adminText("复制登录码", lang)}
              </button>
            </div>
          )}
          {modal.type === "stats" && (
            <div className="admin-record">
              <dl>
                <div>
                  <dt>{adminText("统计口径", lang)}</dt>
                  <dd>
                    {adminText(
                      "仅该用户请求，全部状态；不含管理员与访客请求。",
                      lang,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{adminText("生成请求", lang)}</dt>
                  <dd>{displayNumber(modal.data.stats.requests)}</dd>
                </div>
                <div>
                  <dt>{adminText("已完成", lang)}</dt>
                  <dd>{displayNumber(modal.data.stats.succeeded)}</dd>
                </div>
                <div>
                  <dt>{adminText("失败", lang)}</dt>
                  <dd>{displayNumber(modal.data.stats.failed)}</dd>
                </div>
                <div>
                  <dt>{adminText("排队 / 生成中", lang)}</dt>
                  <dd>
                    {displayNumber(modal.data.stats.queued)} /{" "}
                    {displayNumber(modal.data.stats.running)}
                  </dd>
                </div>
                <div>
                  <dt>{adminText("取消 / 过期（合计）", lang)}</dt>
                  <dd>{displayNumber(modal.data.stats.cancelled)}</dd>
                </div>
                <div>
                  <dt>{adminText("实扣积分（全部状态）", lang)}</dt>
                  <dd>{`${displayNumber(modal.data.stats.pointsConsumed)} ${adminText("积分", lang)}`}</dd>
                </div>
              </dl>
              <p className="admin-muted">
                {adminText("时间范围：{from} 至 {to}", lang, {
                  from: modal.data.stats.from || adminText("全部", lang),
                  to: modal.data.stats.to || adminText("当前", lang),
                })}
              </p>
            </div>
          )}
          {modal.type === "ledger" && (
            <>
              <AdminTextCharges
                data={modal.data.textCharges}
                lang={lang}
                busy={busy}
                onPage={(textPage) =>
                  openLedger(modal.data, modal.data.ledgerPage, textPage)
                }
              />
              <p className="admin-footnote">
                {adminText(
                  "原因汇总覆盖该用户全部账本；明细可逐页查看。正向变化含赠送、充值与退还，按实际原因区分。",
                  lang,
                )}
              </p>
              <section className="admin-panel">
                <header>
                  <h3>{adminText("按实际原因汇总", lang)}</h3>
                </header>
                <div className="admin-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{adminText("原因", lang)}</th>
                        <th>{adminText("笔数", lang)}</th>
                        <th>{adminText("积分变化", lang)}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(modal.data.reasonSummary || []).map((row) => (
                        <tr key={row.reason}>
                          <td>{adminText(row.reason, lang)}</td>
                          <td>{row.rows}</td>
                          <td>
                            {row.delta > 0 ? "+" : ""}
                            {row.delta}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <div className="admin-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{adminText("时间", lang)}</th>
                      <th>{adminText("积分变化", lang)}</th>
                      <th>{adminText("原因", lang)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modal.data.ledger.map((r) => (
                      <tr key={r.id}>
                        <td>{displayTime(r.created_at)}</td>
                        <td>
                          {r.delta > 0 ? "+" : ""}
                          {r.delta}
                        </td>
                        <td>{adminText(r.reason, lang)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!modal.data.ledger.length && (
                  <Empty>{adminText("当前没有积分账本明细。", lang)}</Empty>
                )}
              </div>
              <footer className="admin-pagination">
                <span>
                  {adminText("共 {n} 条 · 第 {page} 页", lang, {
                    n: modal.data.ledgerTotal,
                    page: modal.data.ledgerPage,
                  })}
                </span>
                <button
                  disabled={busy || modal.data.ledgerPage === 1}
                  onClick={() =>
                    openLedger(
                      modal.data,
                      modal.data.ledgerPage - 1,
                      modal.data.textCharges?.page || 1,
                    )
                  }
                >
                  {adminText("上一页", lang)}
                </button>
                <button
                  disabled={
                    busy ||
                    modal.data.ledgerPage * modal.data.ledgerLimit >=
                      modal.data.ledgerTotal
                  }
                  onClick={() =>
                    openLedger(
                      modal.data,
                      modal.data.ledgerPage + 1,
                      modal.data.textCharges?.page || 1,
                    )
                  }
                >
                  {adminText("下一页", lang)}
                </button>
              </footer>
            </>
          )}
          {modal.type === "record" && (
            <AdminGenerationDetail
              key={modal.data.requestId}
              record={modal.data}
              api={api}
              lang={lang}
              onRecord={(data) => setModal({ type: "record", data })}
            />
          )}
        </Modal>
      )}
    </div>
  );
}
