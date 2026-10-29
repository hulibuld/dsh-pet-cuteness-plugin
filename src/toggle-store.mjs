/**
 * 开关的持久化模型：一个 JSON 文件里同时存「新会话默认值」和「每个会话的覆盖值」。
 *
 * 为什么放在一起而不是两处：用户点「关闭」时，这两件事必须**原子地**更新，
 * 否则会出现「设置了默认关，但当前会话还是开」这种看起来像没生效的状态。
 *
 * 文件形状：
 *   { "version": 3, "defaults": {persona,thinking}, "sessions": { "<id>": {...} } }
 *
 * 三条纪律：
 *   1. **读坏文件不能抛**——插件激活时抛错会让整行挂不上，用户以为装坏了。
 *   2. **写失败不能抛**——权限/磁盘满不该让挂件消失，内存里的值照样生效。
 *   3. **未知字段一律丢掉**——防止别人手改文件塞进乱七八糟的东西。
 */

import {
  DEFAULT_ENABLED,
  FLAG_KEYS,
  SESSION_FLAG_KEYS,
  normalizeFlags,
  pruneSessions,
  setFlagsForSession,
} from './toggle-state.mjs'

/**
 * 当前存储格式版本。
 *
 * v1 → v2（2026-10-21）：挂件从"会话级 + 出厂关"改成"应用级 + 出厂开"。
 * v2 → v3（2026-10-22）：**挂件整个删除**（改由 dsh-pet 出镜），
 *   `widget` 这个键从 defaults 与 sessions 里一起清掉——留着一个永远没人读的键，
 *   下一个人会以为它还有用，然后照文档去实现一个不存在的开关。
 * v3 → v4（2026-10-22）：新增 `lines`（台词气泡）。旧文件里没有这个键，
 *   归一化会按出厂值补 true；版本号一涨，启动时会把补齐后的形状落盘一次，
 *   磁盘与内存从此一致（否则用户手改文件时永远看不到 lines）。
 */
export const STORE_VERSION = 4

/**
 * 把任意输入归一化成一份可用的存储快照。
 * @param {unknown} raw 从磁盘读到的 JSON（可能损坏、可能是旧版）
 * @returns {{version: number, defaults: Record<string, boolean>, sessions: Record<string, Record<string, boolean>>}}
 */
export function normalizeStore(raw) {
  const doc = raw && typeof raw === 'object' ? raw : {}
  // 不按 version 分支：normalizeFlags 只保留 FLAG_KEYS 里的键，任何旧版本
  // （v1 的 widget、v2 的会话级 widget）到这里都会自然消失，迁移不需要特殊路径。
  const defaults = normalizeFlags(doc.defaults, DEFAULT_ENABLED)
  const sessions = {}
  const table = doc.sessions && typeof doc.sessions === 'object' ? doc.sessions : {}
  for (const [id, flags] of Object.entries(table)) {
    if (!id || typeof id !== 'string') continue
    const entry = normalizeFlags(flags, defaults)
    const normalized = {}
    for (const key of SESSION_FLAG_KEYS) normalized[key] = entry[key]
    sessions[id] = normalized
  }
  return { version: STORE_VERSION, defaults, sessions }
}

/**
 * 这份**磁盘原文**需不需要重写一遍？
 *
 * 为什么不能只靠"内存里 normalize 过了"：normalizeStore 是纯函数，如果不在启动时
 * 落盘一次，旧文件会一直躺在磁盘上——version 永远是旧的、每次启动都重新迁移、
 * UI 读到的都是旧形状，用户会看到已经删掉的 `widget:false` 反复出现，以为开关坏了。
 *
 * 判定很保守（只认确定性事实，不做猜测）：
 *   - 版本号不是当前版本；
 *   - 某个会话条目里还有 `widget` 键（v2 残留）；
 *   - defaults 缺某个 flag、不是布尔，或者残留了 widget 键。
 *
 * @param {unknown} raw 磁盘上的原始 JSON（不是 normalize 之后的）
 * @returns {boolean}
 */
export function needsRewrite(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  if (raw.version !== STORE_VERSION) return true
  const table = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
  for (const entry of Object.values(table)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true
    if ('widget' in entry) return true
  }
  const defaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {}
  if ('widget' in defaults) return true
  for (const key of FLAG_KEYS) {
    if (typeof defaults[key] !== 'boolean') return true
  }
  return false
}

/** 空存储（首次安装 / 文件不存在）。 */
export function emptyStore() {
  return { version: STORE_VERSION, defaults: { ...DEFAULT_ENABLED }, sessions: {} }
}

/**
 * 改默认值。**不回溯已经开着的会话**——这是刻意的：
 * 用户正在一个会话里工作，改"新会话默认"却把当前会话也掀翻，是很糟的体验。
 *
 * @param {unknown} store
 * @param {Record<string, boolean>} defaults
 */
export function withDefaults(store, defaults) {
  const base = normalizeStore(store)
  return { ...base, defaults: normalizeFlags(defaults, base.defaults) }
}

/**
 * 改某个会话的状态。
 * @param {unknown} store
 * @param {string} sessionId
 * @param {Record<string, boolean>} flags
 */
export function withSessionFlags(store, sessionId, flags) {
  const base = normalizeStore(store)
  return { ...base, sessions: setFlagsForSession(base.sessions, sessionId, flags) }
}

/**
 * 清理已不存在的会话，避免文件无限增长。
 * @param {unknown} store
 * @param {readonly string[]} liveSessionIds
 */
export function withPrunedSessions(store, liveSessionIds) {
  const base = normalizeStore(store)
  return { ...base, sessions: pruneSessions(base.sessions, liveSessionIds) }
}

/**
 * 序列化成写盘用的文本。**稳定排序**：同一份状态必须产出同一段文本，
 * 否则热重载时文件无谓地变化，人肉 diff 也看不出真变化。
 */
export function serializeStore(store) {
  const base = normalizeStore(store)
  const sessions = {}
  for (const id of Object.keys(base.sessions).sort()) sessions[id] = base.sessions[id]
  return `${JSON.stringify({ version: base.version, defaults: base.defaults, sessions }, null, 2)}\n`
}

/**
 * 从文本解析。坏文本返回 null（调用方据此回落到空存储，而不是抛错）。
 * @param {string} text
 */
export function parseStore(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    const raw = JSON.parse(text)
    if (!raw || typeof raw !== 'object') return null
    return normalizeStore(raw)
  } catch {
    return null
  }
}
