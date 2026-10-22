import type { ProgressView } from './generationProgressCore'
import type { PendingCanvasInsert } from '../stores/workspace'

export type BoundCanvasInsert = { owner: string; project: string; insert: PendingCanvasInsert }

// Fields consumed by the desktop shell. Legacy servers can omit newer fields;
// absence remains unknown rather than a fabricated zero or successful state.
export type SessionUser = {
  id?: string;
  workspaceKey?: string;
  name?: string;
  email?: string;
  points?: number;
  hasPassword?: boolean;
}
export type StudioSession = { role: 'user' | 'admin'; csrf?: string; user?: SessionUser | null }
export type PublicModel = { id: string; label?: string; configured?: boolean }
export type OAuthEntry = { enabled?: boolean; providerName?: string }
export type StudioConfig = {
  session?: StudioSession | null;
  models?: PublicModel[];
  videoModels?: PublicModel[];
  textModels?: PublicModel[];
  registrationEnabled?: boolean;
  googleLogin?: OAuthEntry;
  qqLogin?: OAuthEntry;
  githubLogin?: OAuthEntry;
  wechatLogin?: OAuthEntry;
  dingtalkLogin?: OAuthEntry;
  linuxdoLogin?: OAuthEntry;
  oidcLogin?: OAuthEntry;
  payment?: unknown;
}
export type HistoryMedia = { id?: string; url?: string; thumbnailUrl?: string; mime?: string }
export type LocalRecovery = {
  total: number;
  saved: number;
  items: { index: number; path: string; mime: string; url: string; thumbnailUrl?: string }[];
}
export type HistoryItem = {
  requestId: string;
  id?: string;
  kind?: string;
  status: string;
  model?: string;
  modelLabel?: string;
  prompt?: string;
  points?: number | null;
  reservedPoints?: number | null;
  chargedPoints?: number | null;
  cost?: { points?: number | null; reservedPoints?: number | null } | null;
  progress?: number | string | null;
  submissionUncertain?: boolean;
  created_at?: string;
  started_at?: string | null;
  startedAt?: string | null;
  images?: HistoryMedia[];
  video?: HistoryMedia | null;
  delivery?: { target: string; status: 'pending' | 'saved' | 'expired' } | null;
  localRecovery?: LocalRecovery;
  error?: string;
}
export type Summary = { runs?: number; spent?: number; gained?: number; reserved?: number }
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'
export type HistoryState = {
  owner?: string;
  project?: string;
  cacheKey?: string;
  status: LoadStatus;
  items: HistoryItem[];
  error: string;
  page: number;
  total: number;
  limit: number;
  summary: Summary | null;
  refreshing?: boolean;
}
export type LedgerEntry = { delta: number; reason: string; createdAt: string; paymentOrderId?: string | null }
export type LedgerState = { owner?: string; status: LoadStatus; items: LedgerEntry[]; error: string; summary: Summary | null }
export type HistoryProgress = ProgressView & { status: string }
export type LibrarySelection = { handoffId: string; type: 'prompt' | 'reference'; text?: string; images?: { local?: string | null; url?: string | null }[] }

export const emptyHistory = (): HistoryState => ({ status: 'idle', items: [], error: '', page: 1, total: 0, limit: 20, summary: null })
export const emptyLedger = (): LedgerState => ({ status: 'idle', items: [], error: '', summary: null })
