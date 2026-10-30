// Shared model eligibility owns no sessions or database. The supplied store
// remains responsible for authenticating sessions and reading current users.
const deny = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }) }

// Only the server's authenticated session reader can attach this authority.
// Symbols never arrive in JSON and are not copied into public session replies.
export const MODEL_SESSION_CURRENT = Symbol('miaoimg.modelSessionCurrent')

export function modelSessionUnexpired(expires: unknown, now = Date.now()): boolean {
  return typeof expires === 'number' && Number.isFinite(expires) && expires > now
}

export async function requireModelUser(session: any, service = '文本模型'): Promise<string> {
  if (session?.role !== 'user' || typeof session.userId !== 'string' || !session.userId) deny(`请先登录后使用${service}`, 401)
  if (session.expires !== undefined && !modelSessionUnexpired(session.expires)) deny('登录已过期，请重新登录', 401)
  const current = session[MODEL_SESSION_CURRENT]
  if (current !== undefined && (typeof current !== 'function' || !(await current()))) deny('登录已失效，请重新登录', 401)
  if (session.expires !== undefined && !modelSessionUnexpired(session.expires)) deny('登录已过期，请重新登录',401)
  return session.userId
}

export async function assertModelIdentity({ management, session, service = '文本模型' }: Record<string, any>) {
  const userId = (await requireModelUser(session, service))
  const user = (await management?.user?.(userId))
  if (!user || user.status !== 'active') deny('账号已停用', 403)
  return user
}

export async function assertModelAccess(options: Record<string, any>) {
  const user = (await assertModelIdentity(options))
  if (!(Number(user.points) > 0)) deny(`积分不足，请先充值后使用${options.service || '文本模型'}`, 402)
  return user
}
