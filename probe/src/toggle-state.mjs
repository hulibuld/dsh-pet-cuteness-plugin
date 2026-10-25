/**
 * 开关状态：这个插件是「偏娱乐」的，用户要能一键关掉，不被打扰。
 *
 * 三层结构（缺一层都不够用）：
 *   1. **三项能力**：persona（人设段落）/ thinking（强制中文思考）/ lines（台词气泡）。
 *      2026-10-22 起 `widget`（右下角自绘挂件）已删除——挂件改由 dsh-pet 的鲸鱼娘出镜，
 *      本插件不再注册 shell.overlay，所以也没有"挂件开关"这回事了。
 *   2. **每个会话一份**：开会话时临时关掉，下一个会话不该受影响——所以按 sessionId 分桶，
 *      不放在全局。
 *   3. **默认值可改**：新会话的初始状态由设置页决定。两项默认全关
 *      （理由：这是娱乐插件，默认就该是"不打扰"；要的人自己去开）。
 *
 * 语义约定（这三条是给 UI 与宿主半共用的，避免两边判断不一致）：
 *   - `master` = 两项**全部**开启。部分开启时 master 显示为"部分"，再点一次变全开。
 *   - 关掉某一项只影响那一项，不连坐另一项（用户可能只想关中文思考）。
 *   - 任何未知/损坏的存储值都回落到默认值，**绝不抛错**——渲染路径上抛错会让整条
 *     overlay entry 被宿主退役（挂件静默消失，比开关坏了更难查）。
 */

/** 全部能力的稳定顺序。UI 与宿主都按这个顺序走，避免两边顺序不一致。 */
export const FLAG_KEYS = Object.freeze(['persona', 'thinking', 'lines'])

/**
 * 「主开关」管哪几项。
 *
 * 为什么不是全部：`lines` 出厂就是开的（它不花钱、也不改提示词），
 * 如果把它算进主开关，「全部关闭」这个词就再也不会出现——主开关永远显示"部分"。
 * 主开关的语义是"改写提示词的那两项要不要全开"，所以它只管前两项。
 */
export const MASTER_KEYS = Object.freeze(['persona', 'thinking'])

/** 人类可读的标签。给设置页与输入框胶囊共用。 */
export const FLAG_LABELS = Object.freeze({
  persona: '人设语气',
  thinking: '强制中文思考',
  lines: '台词',
})

/** 每一项的一句话说明（给设置页用，用户是"IT 小白"，必须解释清楚）。 */
export const FLAG_HINTS = Object.freeze({
  persona: '让 AI 用角色的口吻说话（改了系统提示词）。关掉后回答恢复标准助手腔。',
  thinking: '要求模型用中文思考。关掉后思考过程回到模型默认语言。',
  lines: '把 AI 思考时嘀咕的短句显示在输入框上方。只读模型自己的思考，不额外请求、不花钱。',
})

/**
 * 出厂默认：**两项都关**。
 *
 * 语气与中文思考会改写每一次请求的提示词（用户明确说过影响效率、费钱），
 * 所以默认关，由用户按需打开。设置页会说明「打开才会改变任何东西」。
 *
 * 历史上的坑（别再犯）：2026-10-21 那版把挂件默认设成关，结果是
 * 「看不到挂件 → 找不到挂件的开关 → 永远看不到」。现在挂件交给 dsh-pet，
 * 它自己默认可见，本插件不再参与显隐，这条死锁从根上消失了。
 */
export const DEFAULT_ENABLED = Object.freeze({
  persona: false,
  thinking: false,
  // 台词出厂**开**：它不改提示词、不发额外请求、零成本，而且"什么都不出"正是
  // 用户抱怨的那个观感。上一版把一切默认关掉，结果装上之后什么都不发生。
  lines: true,
})

/** 会话级可写的 flag（全部能力都是会话级——挂件已删除，没有应用级项了）。 */
export const SESSION_FLAG_KEYS = Object.freeze(['persona', 'thinking', 'lines'])

/** 合法 flag 名判断（外部输入一律先过这个）。 */
export function isFlagKey(key) {
  return FLAG_KEYS.includes(key)
}

/**
 * 把任意输入归一化成一份合法的 flag 表。
 *
 * @param {unknown} value 可能是存储里的旧值、损坏的 JSON、或用户手改的东西
 * @param {Record<string, boolean>} [fallback] 缺字段时的回落（默认出厂值）
 * @returns {Record<string, boolean>}
 */
export function normalizeFlags(value, fallback = DEFAULT_ENABLED) {
  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_ENABLED
  const out = {}
  for (const key of FLAG_KEYS) {
    const raw = value && typeof value === 'object' ? value[key] : undefined
    // 只认真正的布尔值：字符串 "false" 是 truthy，直接 Boolean() 会把它当成开启，
    // 这是所有"存成 localStorage 再读回来"的经典坑。
    out[key] = typeof raw === 'boolean' ? raw : base[key] === true
  }
  return out
}

/**
 * 主开关状态：`'on'`（全开）/ `'off'`（全关）/ `'partial'`（部分开）。
 *
 * 为什么要三态而不是布尔：三项里只开了挂件时，主开关若显示"关"，
 * 用户点了之后会把挂件也关掉——和他的预期相反。
 *
 * @param {Record<string, boolean>} flags
 * @returns {'on'|'off'|'partial'}
 */
export function masterState(flags) {
  const normalized = normalizeFlags(flags, DEFAULT_ENABLED)
  const on = MASTER_KEYS.filter((key) => normalized[key] === true)
  if (on.length === MASTER_KEYS.length) return 'on'
  if (on.length === 0) return 'off'
  return 'partial'
}

/**
 * 点一下主开关之后应该变成什么。
 *
 * 规则（与用户的直觉一致）：
 *   - 全开 → 全关
 *   - 全关 → 全开
 *   - 部分 → 全开（"部分"时再点一次，用户想要的是全开，不是全关）
 *
 * @param {Record<string, boolean>} flags
 * @returns {Record<string, boolean>}
 */
export function toggleMaster(flags) {
  const state = masterState(flags)
  const next = {}
  for (const key of MASTER_KEYS) next[key] = state !== 'on'
  return next
}

/**
 * 只翻某一项。
 * @param {Record<string, boolean>} flags
 * @param {string} key
 */
export function toggleFlag(flags, key) {
  const normalized = normalizeFlags(flags, DEFAULT_ENABLED)
  if (!isFlagKey(key)) return normalized
  return { ...normalized, [key]: normalized[key] !== true }
}

/** 一句话摘要，给主开关的 title/aria 用（读屏器要能听懂）。 */
export function describeFlags(flags) {
  const normalized = normalizeFlags(flags, DEFAULT_ENABLED)
  const on = FLAG_KEYS.filter((key) => normalized[key] === true).map((key) => FLAG_LABELS[key])
  if (on.length === 0) return 'AI 娘化：全部关闭'
  if (on.length === FLAG_KEYS.length) return 'AI 娘化：全部开启'
  return `AI 娘化：已开启 ${on.join('、')}`
}

/**
 * 每一项的生效来源：`'session'`（被本会话的条目覆盖过）还是 `'defaults'`。
 *
 * 为什么需要它：用户点「语气」以为改的是全局，实际只改了本会话——这正是
 * 「开了没效果」的一半来源。UI 必须能说清"这一项现在是谁说了算"，
 * 而不是让用户自己猜。
 *
 * @param {unknown} store
 * @param {string|undefined|null} sessionId
 * @returns {Record<string, 'session'|'defaults'>}
 */
export function flagSources(store, sessionId) {
  const table = store && typeof store === 'object' ? store : {}
  const entry = sessionId && typeof sessionId === 'string' ? table[sessionId] : undefined
  const out = {}
  for (const key of SESSION_FLAG_KEYS) {
    out[key] = entry && typeof entry[key] === 'boolean' ? 'session' : 'defaults'
  }
  return out
}

/**
 * 从"按会话存的表"里读某个会话的状态。
 *
 * 存储形态故意用**扁平对象** `{ [sessionId]: flags }`，不用数组：
 * 数组在删除会话时会留下空洞，而对象直接 delete 就干净了。
 *
 * @param {unknown} store
 * @param {string|undefined|null} sessionId
 * @param {Record<string, boolean>} [defaults] 新会话的初始值（来自设置页）
 * @returns {Record<string, boolean>}
 */
export function flagsForSession(store, sessionId, defaults = DEFAULT_ENABLED) {
  const base = normalizeFlags(defaults, DEFAULT_ENABLED)
  if (!sessionId || typeof sessionId !== 'string') return { ...base }
  const table = store && typeof store === 'object' ? store : {}
  const entry = table[sessionId]
  if (entry === undefined) return { ...base }
  return normalizeFlags(entry, base)
}

/**
 * 写某个会话的状态（返回新表，不改入参——纯函数便于测试与 React 更新）。
 *
 * 只写 SESSION_FLAG_KEYS。调用方多传的键一律丢弃（不是报错——
 * UI 那几颗胶囊可能整行一起提交，或者读到了旧版残留的 widget 键）。
 *
 * @param {unknown} store
 * @param {string} sessionId
 * @param {Record<string, boolean>} flags
 */
export function setFlagsForSession(store, sessionId, flags) {
  const table = store && typeof store === 'object' ? { ...store } : {}
  if (!sessionId || typeof sessionId !== 'string') return table
  const normalized = normalizeFlags(flags, DEFAULT_ENABLED)
  const entry = {}
  for (const key of SESSION_FLAG_KEYS) entry[key] = normalized[key]
  table[sessionId] = entry
  return table
}

/**
 * 清理已经不存在的会话（避免存储无限增长）。
 * @param {unknown} store
 * @param {readonly string[]} liveSessionIds
 */
export function pruneSessions(store, liveSessionIds) {
  const table = store && typeof store === 'object' ? store : {}
  const live = new Set(Array.isArray(liveSessionIds) ? liveSessionIds : [])
  const out = {}
  for (const [id, flags] of Object.entries(table)) {
    if (!live.has(id)) continue
    const normalized = normalizeFlags(flags, DEFAULT_ENABLED)
    const entry = {}
    for (const key of SESSION_FLAG_KEYS) entry[key] = normalized[key]
    out[id] = entry
  }
  return out
}
