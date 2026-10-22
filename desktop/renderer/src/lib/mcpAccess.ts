export type McpAccess = { enabled: boolean; hasToken: boolean; desktop?: boolean; token?: string }

// The settings panel and the canvas connection consume the same access reply.
// An incomplete reply is unknown state, never an instruction to enable/disable.
export function parseMcpAccess(value: unknown): McpAccess | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (data.ok !== true || typeof data.enabled !== 'boolean' || typeof data.hasToken !== 'boolean'
    || (data.desktop !== undefined && typeof data.desktop !== 'boolean')
    || (data.token !== undefined && (typeof data.token !== 'string' || /\s/.test(data.token)))
    || (data.enabled && !data.hasToken) || (data.token && !data.hasToken)
    || (data.desktop === true && data.enabled && !data.token)) return null
  return data as McpAccess
}
