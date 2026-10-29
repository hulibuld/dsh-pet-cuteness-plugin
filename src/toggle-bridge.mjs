/**
 * 桥的**纯逻辑**：把 HTTP 层的糙输入翻译成"要不要写、写什么、回什么"。
 *
 * 为什么单独一个模块：`index.js` 里的路由要拿 webServer、要处理请求对象，
 * 没法单测；而这层判断恰恰是最该钉死的部分（白名单、拒绝、生效来源）。
 * 把判断掏出来，路由只剩"读 body → 调这里 → writeJson"。
 */

import { FLAG_KEYS, SESSION_FLAG_KEYS, flagSources, flagsForSession } from './toggle-state.mjs'

/** 错误码是给浏览器半**判定**用的，不是给人看着玩的：同一个 code 必须永远同一个含义。 */
export const BRIDGE_ERRORS = Object.freeze({
  METHOD: 'method',
  FORBIDDEN: 'forbidden',
  BAD_BODY: 'bad-body',
  BAD_SESSION: 'bad-session',
  BAD_FLAGS: 'bad-flags',
})

/**
 * 已经不存在的键（v3 删掉了 `widget`，挂件改由 dsh-pet 出镜）。
 *
 * **丢掉，但不整单拒绝。** 这是踩过的坑：旧版 client.js 还在用户页面上跑，
 * 它提交会话开关时会把 `widget` 一起带上；原来「见到 widget 就整单拒绝」的做法
 * 让同一单里本来该生效的 persona/thinking 一起没写进去——用户看到的正是
 * 「语气和中文思考点了没反应」。现在改成：`widget` 吞掉、其余照写，
 * 并在响应里用 `ignored` 如实告诉它「这个键我丢了」。
 */
export const RETIRED_FLAGS = Object.freeze(['widget'])

/**
 * 只挑白名单里的**真布尔**。字符串 "false" 不算（truthy 会把开关打开）。
 * @param {unknown} input
 * @param {readonly string[]} keys
 */
export function pickFlags(input, keys = FLAG_KEYS) {
  const out = {}
  if (!input || typeof input !== 'object') return out
  for (const key of keys) {
    if (typeof input[key] === 'boolean') out[key] = input[key]
  }
  return out
}

/**
 * 解析 `POST /session` 的请求体。
 *
 * 只接受 persona/thinking：
 *   - 带 `widget`（已删除的能力）**整单拒绝**并回 `retired-flag`，
 *     让还跑着旧 client.js 的页面能自己发现"我提交的东西已经没人要了"。
 *   - 完全没给出可写键 → `bad-flags`。
 *
 * @param {unknown} body
 * @returns {{ok: true, flags: {persona?: boolean, thinking?: boolean}}
 *   | {ok: false, code: string, accepted: string[], rejected?: string[]}}
 */
export function parseSessionPatch(body) {
  const accepted = [...SESSION_FLAG_KEYS]
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: BRIDGE_ERRORS.BAD_BODY, accepted }
  }
  const input = body.flags && typeof body.flags === 'object' && !Array.isArray(body.flags) ? body.flags : null
  if (!input) return { ok: false, code: BRIDGE_ERRORS.BAD_FLAGS, accepted }
  const ignored = RETIRED_FLAGS.filter((key) => typeof input[key] === 'boolean')
  const flags = pickFlags(input, SESSION_FLAG_KEYS)
  if (Object.keys(flags).length === 0) {
    return { ok: false, code: BRIDGE_ERRORS.BAD_FLAGS, accepted }
  }
  return ignored.length > 0 ? { ok: true, flags, ignored } : { ok: true, flags }
}

/**
 * 解析 `POST /defaults` 的请求体：两项都收，未知键忽略（不是错误——浏览器半可能
 * 顺手带上 `sessionId` 之类的辅助字段）；但已删除的 `widget` 要拒绝，
 * 理由同 parseSessionPatch。
 * @param {unknown} body
 * @returns {{ok: true, flags: Record<string, boolean>} | {ok: false, code: string, accepted: string[]}}
 */
export function parseDefaultsPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: BRIDGE_ERRORS.BAD_BODY, accepted: [...FLAG_KEYS] }
  }
  const ignored = RETIRED_FLAGS.filter((key) => typeof body[key] === 'boolean')
  const flags = pickFlags(body, FLAG_KEYS)
  if (Object.keys(flags).length === 0) {
    return { ok: false, code: BRIDGE_ERRORS.BAD_FLAGS, accepted: [...FLAG_KEYS] }
  }
  return ignored.length > 0 ? { ok: true, flags, ignored } : { ok: true, flags }
}

/**
 * 拼 `GET /state` 的返回体（v3 形状）。
 *
 * 形状约定（浏览器半按这个写，不要另加字段）：
 *   - `version`：存储版本，恒为 3；
 *   - `defaults`：两项完整真源；
 *   - `sessions`：**只有 persona/thinking**；
 *   - `sessionFlags` / `flags`：合法键清单（UI 据此渲染，别硬编码）；
 *   - 带 `sessionId` 时额外给 `effective` 与 `sources`：
 *     `sources[key] === 'session'` 表示这个会话覆盖了默认值——
 *     这是"设置页开了却没反应"的**可判定信号**，UI 直接据此提示
 *     "本会话有独立设置"，而不是让用户自己猜。
 *
 * @param {{version: number, defaults: Record<string, boolean>, sessions: Record<string, Record<string, boolean>>}} snapshot
 * @param {string|undefined} sessionId
 */
export function statePayload(snapshot, sessionId) {
  const sessions = {}
  for (const [id, flags] of Object.entries(snapshot.sessions ?? {})) {
    const entry = {}
    for (const key of SESSION_FLAG_KEYS) {
      if (typeof flags?.[key] === 'boolean') entry[key] = flags[key]
    }
    if (Object.keys(entry).length > 0) sessions[id] = entry
  }
  const payload = {
    version: snapshot.version,
    defaults: { ...snapshot.defaults },
    sessions,
    flags: [...FLAG_KEYS],
    sessionFlags: [...SESSION_FLAG_KEYS],
  }
  if (sessionId) {
    payload.sessionId = sessionId
    payload.effective = flagsForSession(sessions, sessionId, snapshot.defaults)
    payload.sources = flagSources(sessions, sessionId)
    payload.overridden = Object.values(payload.sources).some((source) => source === 'session')
  }
  return payload
}
