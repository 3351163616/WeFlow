/**
 * 通用工具：为会话列表异步补全 avatarUrl / displayName
 *
 * 后端 chat.getSessions 为了首屏速度，不会主动查 contact 表，
 * 需要前端在拿到 sessions 后分批调用 enrichSessionsContactInfo。
 * 该工具只做最小实现：分批并发 + 失败静默 + 只补缺失字段。
 */

interface SessionLike {
  username: string
  displayName?: string
  avatarUrl?: string
}

const BATCH_SIZE = 50

/**
 * 分批补全会话列表的头像与显示名，调用 setter 触发一次 state 更新即可。
 *
 * @param sessions 源列表（不会被修改）
 * @param applyPatch 回调：拿到 `{ username -> {displayName?, avatarUrl?} }` 后合并到 state
 */
export async function enrichSessionAvatars<T extends SessionLike>(
  sessions: T[],
  applyPatch: (patch: Record<string, { displayName?: string; avatarUrl?: string }>) => void
): Promise<void> {
  if (!sessions || sessions.length === 0) return

  // 只挑缺头像 或 displayName 看起来是原始 wxid/群ID 的
  const needs = sessions
    .map(s => s.username)
    .filter(u => {
      if (!u) return false
      const s = sessions.find(x => x.username === u)
      if (!s) return false
      const missingAvatar = !s.avatarUrl
      const missingName = !s.displayName || s.displayName === u
      return missingAvatar || missingName
    })

  if (needs.length === 0) return

  for (let i = 0; i < needs.length; i += BATCH_SIZE) {
    const batch = needs.slice(i, i + BATCH_SIZE)
    try {
      const r = await window.electronAPI.chat.enrichSessionsContactInfo(batch, {
        onlyMissingAvatar: false
      })
      if (r.success && r.contacts && Object.keys(r.contacts).length > 0) {
        applyPatch(r.contacts)
      }
    } catch {
      // 失败静默，保留占位符兜底
    }
  }
}
