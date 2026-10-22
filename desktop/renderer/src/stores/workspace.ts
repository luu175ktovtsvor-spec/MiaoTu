import { defineStore } from 'pinia'
import type { AgentAttachment } from '@/studio/canvas/components/agent/types'

export type PendingCanvasInsert =
  | { id: string; kind: 'text'; text: string; label?: string }
  | { id: string; kind: 'image'; path: string; mimeType?: string; label?: string }

export const useWorkspaceStore = defineStore('miaoimgWorkspace', {
  state: () => ({
    project: null as null | { directory: string; name: string },
    // 灵感库交接：React 侧投递、画布侧消费一次后清空。
    pendingInsert: null as null | PendingCanvasInsert,
    pendingAgentMessage: null as null | { directory: string; prompt: string; model?: string; reasoningEffort?: string; attachments?: AgentAttachment[] },
  }),
  actions: {
    setProject(project: { directory: string; name: string }) {
      this.project = project
    },
    queueInsert(insert: PendingCanvasInsert | null) {
      this.pendingInsert = insert
    },
    takeInsert() {
      const pending = this.pendingInsert
      this.pendingInsert = null
      return pending
    },
    renameProject(_directory: string, name: string) {
      if (this.project) this.project.name = name.trim() || this.project.name
    },
  },
})
