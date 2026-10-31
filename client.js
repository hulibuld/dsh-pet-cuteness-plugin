/**
 * dsh-pet-cuteness-plugin · M0 探针（浏览器半）——**构建产物，不要手改**。
 *
 * 由 `node scripts/build-client.mjs` 从以下源文件生成：
 *   src/model-identity.mjs
 *   src/toggle-state.mjs
 *   src/bubble-placement.mjs
 *   src/ui.mjs
 *
 * 手改本文件会在下次构建时被覆盖；要改逻辑请改 src/ 下对应文件。
 *
 * 目标：证明右下角挂件能挂在 `shell.overlay` 上、能点、能弹气泡，
 * 并且能读到「当前会话用的是哪个模型」。所以挂件是一个圆点 + 一个气泡，不是立绘。
 *
 * 四条硬约束（违反会白屏或崩掉整个框架）：
 *   1. 不 require 任何 @deepseek-ai/dsh-client-* 包，只用宿主给的 react；
 *   2. 不向 document.body 追加节点，一切都渲染在自己的 slot 里；
 *   3. 组件抛错会让这一条 entry 被退役（挂件静默消失），所以渲染路径上不允许有会抛的表达式；
 *   4. hooks 不能条件调用 —— 有 useSessions 和没有它的是两个组件，由挂载时决定用哪一个。
 */
window.__ModuleLoader__.load({
	id: 'dsh-pet-cuteness-plugin',
	factory: (require) => {
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const h = React.createElement
		const { useState, useEffect, useRef, useCallback } = React

		// ─────────────────────────────────────────────────────────────
		// 纯逻辑（构建期内联，来源见文件头）
		// ─────────────────────────────────────────────────────────────
		// ─── 内联自 src/model-identity.mjs（构建产物，勿手改） ───
		/**
		 * 模型识别：provider / model → 人格卡 id。
		 *
		 * 与 v2 的差别：不再只靠 `agent.options`（创建时的默认值，用户中途换模型就过期），
		 * 主来源改成 `modelSelection` 投影的 `next`。
		 *
		 * 匹配顺序很重要：先精确匹配 provider，再匹配 model 子串。
		 * `deepseek-v4-pro` 必须被 deepseek 命中，不能被更宽的模式抢走。
		 */

		/** provider / model 名 → 人格卡 id。数组顺序即优先级。 */
		const MATCHERS = [
		  ['deepseek', /deepseek|深度求索/i],
		  ['claude', /claude|anthropic|sonnet|opus|haiku/i],
		  // gpt 的正则要挡住 o3/o4 之外的 o 开头的词，同时不能让 "openai" 之外的串误命中
		  ['gpt', /(?:^|[^a-z])gpt|openai|chatgpt|(?:^|[^a-z])o[34](?:[^0-9]|$)/i],
		  ['gemini', /gemini|bard/i],
		  ['grok', /grok|xai|x\.ai/i],
		  ['qwen', /qwen|tongyi|通义|千问/i],
		  ['ernie', /ernie|wenxin|文心/i],
		  ['kimi', /kimi|moonshot|月之暗面/i],
		  ['glm', /glm|zhipu|chatglm|智谱/i],
		  ['doubao', /doubao|seed|豆包/i],
		  ['minimax', /minimax|abab/i],
		  ['llama', /llama|meta-llama/i],
		  ['mistral', /mistral|mixtral/i],
		  ['perplexity', /perplexity|pplx/i],
		]

		/**
		 * 归一化：provider 与 model 拼起来一起匹配，先命中者胜。
		 * 认不出就回 `generic` —— 任何模型都必须有娘，这是体验底线，不是兜底丑化。
		 *
		 * @param {string|undefined|null} provider
		 * @param {string|undefined|null} model
		 * @returns {string}
		 */
		function normalizePersonaId(provider, model) {
		  const haystack = `${provider ?? ''} ${model ?? ''}`
		  if (!haystack.trim()) return 'generic'
		  for (const [id, pattern] of MATCHERS) {
		    if (pattern.test(haystack)) return id
		  }
		  return 'generic'
		}

		/**
		 * 从会话投影快照里读「现在真正在用的模型」。
		 *
		 * 语义：`modelSelection.next` = 下一个请求要用的选择（显式选择先挂 pending，
		 * 直到同路由的 request/header 消费它）；`lastUsed` = 上一个请求实际用的。
		 * 当前在用的 = next ?? lastUsed。
		 *
		 * @param {any} snapshot `projections.snapshot(session, ['modelSelection'])` 的返回值
		 * @returns {{provider?: string, model?: string}|undefined}
		 */
		function readSelection(snapshot) {
		  try {
		    const values = snapshot?.values
		    const selection = values?.modelSelection
		    const next = selection?.next ?? selection?.lastUsed
		    if (next && typeof next.model === 'string') return next
		  } catch {
		    /* 投影服务不可用或还没算出值 */
		  }
		  return undefined
		}

		/**
		 * 决定人格卡 id 的唯一入口（宿主半与浏览器半共用，避免两边判断不一致）。
		 *
		 * 来源优先级：
		 *   1. `modelSelection.next`（投影，最准）
		 *   2. `agent.options`（创建时的默认值，只在投影读不到时用；会过期）
		 *   3. `generic`
		 *
		 * @param {object} input
		 * @param {{provider?:string, model?:string}|undefined} [input.selection]
		 * @param {{provider?:string, model?:string}|undefined} [input.options]
		 * @returns {{ personaId: string, provider: string|undefined, model: string|undefined, source: string }}
		 */
		function resolvePersona({ selection, options } = {}) {
		  if (selection && (selection.provider || selection.model)) {
		    return {
		      personaId: normalizePersonaId(selection.provider, selection.model),
		      provider: selection.provider,
		      model: selection.model,
		      source: 'modelSelection',
		    }
		  }
		  if (options && (options.provider || options.model)) {
		    return {
		      personaId: normalizePersonaId(options.provider, options.model),
		      provider: options.provider,
		      model: options.model,
		      source: 'agent.options',
		    }
		  }
		  return { personaId: 'generic', provider: undefined, model: undefined, source: 'fallback' }
		}

		// ─── 内联自 src/toggle-state.mjs（构建产物，勿手改） ───
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
		const FLAG_KEYS = Object.freeze(['persona', 'thinking', 'lines'])

		/**
		 * 「主开关」管哪几项。
		 *
		 * 为什么不是全部：`lines` 出厂就是开的（它不花钱、也不改提示词），
		 * 如果把它算进主开关，「全部关闭」这个词就再也不会出现——主开关永远显示"部分"。
		 * 主开关的语义是"改写提示词的那两项要不要全开"，所以它只管前两项。
		 */
		const MASTER_KEYS = Object.freeze(['persona', 'thinking'])

		/** 人类可读的标签。给设置页与输入框胶囊共用。 */
		const FLAG_LABELS = Object.freeze({
		  persona: '人设语气',
		  thinking: '强制中文思考',
		  lines: '台词',
		})

		/** 每一项的一句话说明（给设置页用，用户是"IT 小白"，必须解释清楚）。 */
		const FLAG_HINTS = Object.freeze({
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
		const DEFAULT_ENABLED = Object.freeze({
		  persona: false,
		  thinking: false,
		  // 台词出厂**开**：它不改提示词、不发额外请求、零成本，而且"什么都不出"正是
		  // 用户抱怨的那个观感。上一版把一切默认关掉，结果装上之后什么都不发生。
		  lines: true,
		})

		/** 会话级可写的 flag（全部能力都是会话级——挂件已删除，没有应用级项了）。 */
		const SESSION_FLAG_KEYS = Object.freeze(['persona', 'thinking', 'lines'])

		/** 合法 flag 名判断（外部输入一律先过这个）。 */
		function isFlagKey(key) {
		  return FLAG_KEYS.includes(key)
		}

		/**
		 * 把任意输入归一化成一份合法的 flag 表。
		 *
		 * @param {unknown} value 可能是存储里的旧值、损坏的 JSON、或用户手改的东西
		 * @param {Record<string, boolean>} [fallback] 缺字段时的回落（默认出厂值）
		 * @returns {Record<string, boolean>}
		 */
		function normalizeFlags(value, fallback = DEFAULT_ENABLED) {
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
		function masterState(flags) {
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
		function toggleMaster(flags) {
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
		function toggleFlag(flags, key) {
		  const normalized = normalizeFlags(flags, DEFAULT_ENABLED)
		  if (!isFlagKey(key)) return normalized
		  return { ...normalized, [key]: normalized[key] !== true }
		}

		/** 一句话摘要，给主开关的 title/aria 用（读屏器要能听懂）。 */
		function describeFlags(flags) {
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
		function flagSources(store, sessionId) {
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
		function flagsForSession(store, sessionId, defaults = DEFAULT_ENABLED) {
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
		function setFlagsForSession(store, sessionId, flags) {
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
		function pruneSessions(store, liveSessionIds) {
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

		// ─── 内联自 src/bubble-placement.mjs（构建产物，勿手改） ───
		/**
		 * 气泡定位：把挂在角色上的浮层（气泡 / 状态卡 / 菜单）收敛进视口。
		 *
		 * 出处：vlln/whale-girl（MIT，commit 8e70c30，2026-10-19 拉取）
		 *   文件 lib/client/overlay-placement.mjs
		 * 本文件是**移植 + 改注释 + 补边界用例**，算法逐行保持原样。
		 *
		 * 为什么连这个都要抄：几何符号错误在浏览器里极难发现（气泡只是"看起来有点歪"），
		 * 而原作者的注释记录了一个真实 issue——只比 `size.h` 会漏掉 `offsetY` 这一条窄带，
		 * 导致"代码认为放得下、实际溢出 5px 被裁"。这种坑不值得我们再踩一次。
		 *
		 * 契约：入参全为数值/矩形，出参是可直接写进内联样式的字符串。零 DOM，可单测。
		 *   - 纵向：优先请求的朝向；该侧空间不足且另一侧更宽裕时翻面。
		 *     可用空间扣掉 offsetY（角色与浮层之间的间隙）与 margin。
		 *   - 横向：浮层以角色中心居中；居中会越出视口时反向平移；比视口还宽时以视口居中。
		 *   - left 用 calc(50% ± Npx) 表达位移，不用 transform——气泡入场动画的关键帧占用了 transform。
		 *
		 * @param {object} input
		 * @param {{top:number,bottom:number,left:number,width:number}} input.rect 角色在视口中的位置
		 * @param {{w:number,h:number}} input.viewport 视口尺寸
		 * @param {{w:number,h:number}} input.size 浮层的实测尺寸
		 * @param {boolean} input.above 请求的朝向：true = 角色上方
		 * @param {number} [input.offsetY=0] 角色与浮层之间的间隙
		 * @param {number} [input.margin=8] 与视口边缘保留的最小距离
		 */
		function planOverlay({ rect, viewport, size, above, offsetY = 0, margin = 8 }) {
		  // 浮层实际占 (rect.top - offsetY - size.h) … (rect.top - offsetY)（上方），
		  // 或 (rect.bottom + offsetY) … (rect.bottom + offsetY + size.h)（下方），
		  // 所以两侧可用空间都要扣掉 offsetY。
		  const roomAbove = rect.top - margin - offsetY
		  const roomBelow = viewport.h - rect.bottom - margin - offsetY

		  // 纵向：请求的朝向放不下、且另一侧更宽裕 → 翻面（两侧都不足时取宽裕的一侧）。
		  let up = above
		  if (above && roomAbove < size.h && roomBelow > roomAbove) up = false
		  else if (!above && roomBelow < size.h && roomAbove > roomBelow) up = true

		  // 横向：居中位置 = 角色中心 ± 半宽；越界则平移回视口内（左右各留 margin）。
		  const centerX = rect.left + rect.width / 2
		  let dx = 0
		  if (size.w >= viewport.w - margin * 2) dx = viewport.w / 2 - centerX // 比视口还宽：以视口居中
		  else if (centerX - size.w / 2 < margin) dx = margin - centerX + size.w / 2
		  else if (centerX + size.w / 2 > viewport.w - margin) dx = viewport.w - margin - centerX - size.w / 2

		  const shift = Math.round(dx)
		  return {
		    up,
		    top: up ? `-${offsetY}px` : `calc(100% + ${offsetY}px)`,
		    transform: up ? 'translate(-50%, -100%)' : 'translateX(-50%)',
		    left: shift === 0 ? '50%' : `calc(50% ${shift > 0 ? '+' : '-'} ${Math.abs(shift)}px)`,
		  }
		}

		// ─── 内联自 src/ui.mjs（构建产物，勿手改） ───
		/**
		 * 设置页的共用原语（色板 / 标度 / 组件）。
		 *
		 * 为什么单独一个文件：设置页有 12 个卡片、几十个按钮和输入框，之前每一处都手写
		 * 内联样式，于是同一个"次要文字"出现过四种灰度、同一类按钮有三种圆角。
		 * 用户 2026-10-31 的返工意见（逐字）：「新增 client/src/ui.js，共用原语」，
		 * 并给了三层清单：色板、标度、组件。
		 *
		 * 三条纪律（违反会退回到手写样式的状态）：
		 *   1. **颜色只从 `C` 取**，不在组件里写 `rgba(...)` 字面量。C 的每一项形如
		 *      `var(--dsw-alias-…, 深色兜底)`，宿主主题换色时自动跟随；深色兜底值
		 *      是给"宿主没给变量"的场景用的（旧版宿主、单测假环境）。
		 *   2. **尺寸只从 `UI_FONT` / `UI_SPACE` / `UI_RADIUS` 取**，四档间距、三档字号、四档圆角。
		 *   3. **不碰 DOM、不读 window**：`h` 由调用方注入（浏览器半里就是 React.createElement），
		 *      这样模块可以在 node 里直接被单测渲染，不需要 jsdom。
		 *
		 * 这一层只负责"长什么样"，不负责"取什么数据"——数据仍然由调用方传 props。
		 */

		/** 字号三档。15 用于页面标题，13 用于卡片标题/正文强调，11.5 用于说明与注释。 */
		const UI_FONT = { lg: 15, md: 13, sm: 11.5 }

		/** 间距四档。s 用于行内小间隙，m 用于一行之内，l 用于卡片内边距，xl 用于页面留白。 */
		const UI_SPACE = { s: 6, m: 10, l: 16, xl: 24 }

		/** 圆角四档。xs 用于徽标，sm 用于输入框/按钮，md 用于卡片，pill 用于胶囊。 */
		const UI_RADIUS = { xs: 4, sm: 8, md: 12, pill: 999 }

		/** 深色主题判定：宿主 <html> 主题属性 → class → 系统偏好，读不到按深色。 */
		function isDarkTheme(env) {
		  const scope = env || (typeof globalThis !== 'undefined' ? globalThis : {})
		  try {
		    const doc = scope.document
		    const root = doc && doc.documentElement
		    if (root) {
		      const attr = root.getAttribute && root.getAttribute('data-theme')
		      if (attr === 'dark') return true
		      if (attr === 'light') return false
		      const cls = typeof root.className === 'string' ? root.className : ''
		      // class 里常见写成 theme-dark / dark-mode，所以把连字符也当边界。
		      if (/(^|[\s-])dark([\s-]|$)/.test(cls)) return true
		      if (/(^|[\s-])light([\s-]|$)/.test(cls)) return false
		    }
		    const mm = scope.matchMedia
		    if (typeof mm === 'function') {
		      const mql = mm('(prefers-color-scheme: dark)')
		      if (mql && typeof mql.matches === 'boolean') return mql.matches
		    }
		  } catch {
		    /* 读不到就按兜底走 */
		  }
		  return true
		}

		/** 色板：每项是"宿主变量 + 兜底值"，深/浅各一套兜底。 */
		function palette(dark) {
		  const isDark = dark !== false
		  const fallback = {
		    text: isDark ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.88)',
		    sub: isDark ? 'rgba(255,255,255,0.62)' : 'rgba(0,0,0,0.58)',
		    faint: isDark ? 'rgba(255,255,255,0.42)' : 'rgba(0,0,0,0.38)',
		    bg1: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
		    bg2: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
		    border: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)',
		    border2: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.20)',
		    accent: isDark ? '#8ab4ff' : '#2f6fdb',
		    accentSoft: isDark ? 'rgba(138,180,255,0.16)' : 'rgba(47,111,219,0.12)',
		    ok: isDark ? '#5fd18a' : '#1f8f4e',
		    warn: isDark ? '#e8b84b' : '#8a6300',
		    error: isDark ? '#ff6b6b' : '#c33a3a',
		  }
		  return {
		    text: `var(--dsw-alias-label-primary, ${fallback.text})`,
		    sub: `var(--dsw-alias-label-secondary, ${fallback.sub})`,
		    faint: `var(--dsw-alias-label-tertiary, ${fallback.faint})`,
		    bg1: `var(--dsw-alias-bg-layer-1, ${fallback.bg1})`,
		    bg2: `var(--dsw-alias-bg-layer-2, ${fallback.bg2})`,
		    border: `var(--dsw-alias-border-l1, ${fallback.border})`,
		    border2: `var(--dsw-alias-border-l2, ${fallback.border2})`,
		    accent: `var(--dsw-alias-brand-primary, ${fallback.accent})`,
		    accentSoft: `var(--dsw-alias-brand-weak, ${fallback.accentSoft})`,
		    ok: `var(--dsw-alias-label-success, ${fallback.ok})`,
		    warn: `var(--dsw-alias-label-warning, ${fallback.warn})`,
		    error: `var(--dsw-alias-label-error, ${fallback.error})`,
		  }
		}

		/** 把"用户给的样式"盖在"我们算好的样式"上。空对象也是合法输入。 */
		function merge(base, extra) {
		  return extra && typeof extra === 'object' ? Object.assign({}, base, extra) : base
		}

		/**
		 * 造一整套原语。浏览器半里 `h` 就是 `React.createElement`。
		 *
		 * @param {(type: any, props?: any, ...children: any[]) => any} h
		 * @param {{ dark?: boolean, env?: object }} [options]
		 * @returns {object} 含 C / FONT / SPACE / RADIUS 与十个组件
		 */
		function makePrimitives(h, options) {
		  if (typeof h !== 'function') throw new Error('makePrimitives 需要一个 createElement 实现')
		  const opts = options && typeof options === 'object' ? options : {}
		  const dark = typeof opts.dark === 'boolean' ? opts.dark : isDarkTheme(opts.env)
		  const C = palette(dark)

		  /** 页面外壳：限宽 + 纵向留白。设置面板本身就窄，限宽防大屏下被拉成一行长文。 */
		  function Page(props) {
		    const p = props || {}
		    return h(
		      'div',
		      {
		        style: merge(
		          { maxWidth: 760, padding: `${UI_SPACE.s}px 0 ${UI_SPACE.l}px`, color: C.text },
		          p.style,
		        ),
		      },
		      p.children,
		    )
		  }

		  /** 页头：标题 + 一句说明 + 右侧动作。说明必须短（用户要求「别写长」）。 */
		  function PageHeader(props) {
		    const p = props || {}
		    const hasSub = typeof p.subtitle === 'string' && p.subtitle.length > 0
		    return h(
		      'div',
		      { style: { padding: `2px 0 ${UI_SPACE.m}px` } },
		      h(
		        'div',
		        {
		          style: {
		            display: 'flex',
		            alignItems: 'baseline',
		            justifyContent: 'space-between',
		            gap: UI_SPACE.m,
		          },
		        },
		        h('div', { style: { fontSize: UI_FONT.lg, fontWeight: 600, color: C.text } }, p.title),
		        p.right ? h('div', { style: { flex: '0 0 auto' } }, p.right) : null,
		      ),
		      hasSub
		        ? h(
		            'div',
		            { style: { marginTop: 2, fontSize: UI_FONT.sm, lineHeight: 1.6, color: C.sub } },
		            p.subtitle,
		          )
		        : null,
		    )
		  }

		  /** 卡片：一块带边框的面板，标题可选。卡片之间靠 marginTop 拉开，不用额外包裹层。 */
		  function Card(props) {
		    const p = props || {}
		    const title = p.title
		    const sub = p.subtitle
		    return h(
		      'section',
		      {
		        style: merge(
		          {
		            marginTop: UI_SPACE.m,
		            padding: `${UI_SPACE.s}px ${UI_SPACE.l - 4}px ${UI_SPACE.m}px`,
		            border: `1px solid ${C.border2}`,
		            borderRadius: UI_RADIUS.md,
		            background: C.bg1,
		          },
		          p.style,
		        ),
		      },
		      title
		        ? h(
		            'div',
		            {
		              style: {
		                fontSize: UI_FONT.md,
		                fontWeight: 600,
		                margin: `${UI_SPACE.s}px 0 2px`,
		                color: C.sub,
		              },
		            },
		            title,
		          )
		        : null,
		      typeof sub === 'string' && sub
		        ? h(
		            'div',
		            { style: { fontSize: UI_FONT.sm, lineHeight: 1.6, color: C.faint } },
		            sub,
		          )
		        : null,
		      p.children,
		    )
		  }

		  const BUTTON_VARIANTS = {
		    primary: { background: C.accent, color: '#fff', border: `1px solid ${C.accent}` },
		    secondary: { background: C.bg2, color: C.text, border: `1px solid ${C.border2}` },
		    ghost: { background: 'transparent', color: C.sub, border: '1px solid transparent' },
		    danger: { background: 'transparent', color: C.error, border: `1px solid ${C.error}` },
		  }

		  /** 按钮：四种意图。尺寸只有一种（小），因为设置页里没有主行动按钮的余地。 */
		  function Button(props) {
		    const p = props || {}
		    const variant = BUTTON_VARIANTS[p.variant] ? p.variant : 'secondary'
		    const look = BUTTON_VARIANTS[variant]
		    return h(
		      'button',
		      {
		        type: p.type || 'button',
		        disabled: p.disabled === true,
		        title: p.title,
		        onClick: p.onClick,
		        'aria-label': p.ariaLabel,
		        style: merge(
		          {
		            padding: '4px 10px',
		            fontSize: UI_FONT.sm,
		            lineHeight: 1.5,
		            borderRadius: UI_RADIUS.sm,
		            cursor: p.disabled === true ? 'not-allowed' : 'pointer',
		            opacity: p.disabled === true ? 0.5 : 1,
		            background: look.background,
		            color: look.color,
		            border: look.border,
		          },
		          p.style,
		        ),
		      },
		      p.children,
		    )
		  }

		  /** 开关。用 role="switch"：读屏器会念"开/关"，与宿主其它开关一致。 */
		  function Switch(props) {
		    const p = props || {}
		    const on = p.checked === true
		    return h(
		      'button',
		      {
		        type: 'button',
		        role: 'switch',
		        'aria-checked': on ? 'true' : 'false',
		        'aria-label': p.ariaLabel,
		        disabled: p.disabled === true,
		        onClick: p.onChange,
		        style: merge(
		          {
		            display: 'inline-flex',
		            alignItems: 'center',
		            gap: UI_SPACE.s,
		            padding: '2px 0',
		            border: 'none',
		            background: 'transparent',
		            color: on ? C.text : C.sub,
		            fontSize: UI_FONT.sm,
		            cursor: p.disabled === true ? 'not-allowed' : 'pointer',
		            opacity: p.disabled === true ? 0.5 : 1,
		          },
		          p.style,
		        ),
		      },
		      h('span', {
		        'aria-hidden': 'true',
		        style: {
		          width: 26,
		          height: 15,
		          borderRadius: UI_RADIUS.pill,
		          background: on ? C.accent : C.bg2,
		          border: `1px solid ${on ? C.accent : C.border2}`,
		          position: 'relative',
		          transition: 'background 120ms ease',
		          flex: '0 0 auto',
		        },
		      }),
		      p.label ? h('span', null, p.label) : null,
		    )
		  }

		  /** 单行输入。数字用 `type="number"`，其余一律文本。 */
		  function Input(props) {
		    const p = props || {}
		    return h('input', {
		      type: p.type || 'text',
		      value: p.value === undefined || p.value === null ? '' : String(p.value),
		      placeholder: p.placeholder,
		      disabled: p.disabled === true,
		      inputMode: p.inputMode,
		      'aria-label': p.ariaLabel,
		      onChange: p.onChange,
		      onKeyDown: p.onKeyDown,
		      style: merge(
		        {
		          padding: '4px 8px',
		          fontSize: UI_FONT.sm,
		          lineHeight: 1.5,
		          borderRadius: UI_RADIUS.sm,
		          border: `1px solid ${C.border2}`,
		          background: C.bg2,
		          color: C.text,
		          minWidth: p.wide === true ? 200 : 0,
		        },
		        p.style,
		      ),
		    })
		  }

		  /** 下拉。`options` 形如 `[{ value, label }]`。 */
		  function Select(props) {
		    const p = props || {}
		    const list = Array.isArray(p.options) ? p.options : []
		    return h(
		      'select',
		      {
		        value: p.value === undefined || p.value === null ? '' : String(p.value),
		        disabled: p.disabled === true,
		        'aria-label': p.ariaLabel,
		        onChange: p.onChange,
		        style: merge(
		          {
		            padding: '4px 6px',
		            fontSize: UI_FONT.sm,
		            lineHeight: 1.5,
		            borderRadius: UI_RADIUS.sm,
		            border: `1px solid ${C.border2}`,
		            background: C.bg2,
		            color: C.text,
		          },
		          p.style,
		        ),
		      },
		      list.map((item) =>
		        h('option', { key: String(item.value), value: String(item.value) }, item.label),
		      ),
		    )
		  }

		  const BADGE_TONES = {
		    info: { bg: C.accentSoft, fg: C.accent },
		    ok: { bg: C.bg2, fg: C.ok },
		    warn: { bg: C.bg2, fg: C.warn },
		    error: { bg: C.bg2, fg: C.error },
		    plain: { bg: C.bg2, fg: C.sub },
		  }

		  /** 小徽标：显示"已开启/未生效/上限 20"这类短状态。 */
		  function Badge(props) {
		    const p = props || {}
		    const tone = BADGE_TONES[p.tone] ? p.tone : 'plain'
		    const look = BADGE_TONES[tone]
		    return h(
		      'span',
		      {
		        style: merge(
		          {
		            display: 'inline-block',
		            padding: '1px 6px',
		            fontSize: UI_FONT.sm,
		            lineHeight: 1.6,
		            borderRadius: UI_RADIUS.xs,
		            background: look.bg,
		            color: look.fg,
		            whiteSpace: 'nowrap',
		          },
		          p.style,
		        ),
		      },
		      p.children,
		    )
		  }

		  const NOTE_TONES = { info: 'sub', ok: 'ok', warn: 'warn', error: 'error', faint: 'faint' }

		  /** 说明文字：一行小字，可选语义色。比 Badge 长、比正文弱。 */
		  function Note(props) {
		    const p = props || {}
		    const key = NOTE_TONES[p.tone] || 'sub'
		    return h(
		      'div',
		      {
		        role: p.tone === 'error' ? 'alert' : undefined,
		        style: merge(
		          { fontSize: UI_FONT.sm, lineHeight: 1.6, color: C[key] },
		          p.style,
		        ),
		      },
		      p.children,
		    )
		  }

		  /** 表单一行：左边标签（固定宽），右边控件，下面可挂一句提示。 */
		  function Field(props) {
		    const p = props || {}
		    return h(
		      'div',
		      { style: merge({ display: 'flex', alignItems: 'center', gap: UI_SPACE.m, marginTop: UI_SPACE.s }, p.style) },
		      p.label
		        ? h(
		            'label',
		            {
		              htmlFor: p.htmlFor,
		              style: {
		                flex: '0 0 auto',
		                minWidth: p.labelWidth || 88,
		                fontSize: UI_FONT.sm,
		                color: C.sub,
		              },
		            },
		            p.label,
		          )
		        : null,
		      h(
		        'div',
		        { style: { flex: '1 1 auto', minWidth: 0 } },
		        p.children,
		        p.hint
		          ? h(
		              'div',
		              { style: { marginTop: 2, fontSize: UI_FONT.sm, lineHeight: 1.6, color: C.faint } },
		              p.hint,
		            )
		          : null,
		      ),
		    )
		  }

		  return {
		    C,
		    palette: C,
		    FONT: UI_FONT,
		    SPACE: UI_SPACE,
		    RADIUS: UI_RADIUS,
		    dark,
		    Page,
		    PageHeader,
		    Card,
		    Button,
		    Switch,
		    Input,
		    Select,
		    Badge,
		    Note,
		    Field,
		  }
		}

		const core = {
			MATCHERS,
			normalizePersonaId,
			readSelection,
			resolvePersona,
			FLAG_KEYS,
			MASTER_KEYS,
			FLAG_LABELS,
			FLAG_HINTS,
			DEFAULT_ENABLED,
			SESSION_FLAG_KEYS,
			isFlagKey,
			normalizeFlags,
			masterState,
			toggleMaster,
			toggleFlag,
			describeFlags,
			flagSources,
			flagsForSession,
			setFlagsForSession,
			pruneSessions,
			planOverlay,
			UI_FONT,
			UI_SPACE,
			UI_RADIUS,
			isDarkTheme,
			palette,
			makePrimitives,
		}

		// ─────────────────────────────────────────────────────────────
		// 展示层
		// ─────────────────────────────────────────────────────────────
		// ── 本地偏好（全部可一键清除，卸载时不残留） ──────────────────────
		//
		// 为什么这几行值得单独写：用户卸载一个桌宠之后，最不想看到的是
		// "重装第一天就哑着"（冷却表残留）或"角落里还留着一个坐标"。
		// 所以约定：**所有本地状态都挂在这一个键下**，卸载时删一次就干净。
		const PREFS_KEY = 'dsh-ai-waifu'

		function readPrefs() {
		  try {
		    const raw = window.localStorage && window.localStorage.getItem(PREFS_KEY)
		    const parsed = raw ? JSON.parse(raw) : null
		    return parsed && typeof parsed === 'object' ? parsed : {}
		  } catch {
		    return {}
		  }
		}

		function writePrefs(patch) {
		  try {
		    if (!window.localStorage) return
		    const next = Object.assign({}, readPrefs(), patch)
		    window.localStorage.setItem(PREFS_KEY, JSON.stringify(next))
		  } catch {
		    /* 隐私模式 / 配额满：偏好存不下不影响使用 */
		  }
		}

		/** 卸载时调用：把本插件写过的所有本地状态删干净。 */
		function clearPrefs() {
		  try {
		    if (window.localStorage) window.localStorage.removeItem(PREFS_KEY)
		  } catch {
		    /* 同上 */
		  }
		}


		// ── 开关桥：浏览器半读写宿主开关状态的唯一通道 ────────────────────
		//
		// 为什么必须走 HTTP：挂件在浏览器里，「人设语气」「中文思考」却要在**宿主**侧
		// 改系统提示词。浏览器没有任何通道能直接调宿主服务，而宿主已经用
		// webServer.register 给我们开了口子（见 index.js 的 registerToggleBridge）。
		const BRIDGE = '/api/dsh-pet-cuteness-plugin'

		// 桥的请求上限：4 秒。fetch 默认没有超时，桥一旦挂住（宿主正在重启、代理吞包），
		// flagStore.load() 就永远停在 pending，Overlay 永远拿不到 state——症状又是「挂件不显示」。
		// 所以宁可 4 秒后按出厂值把挂件画出来，也不让它无限等。
		const BRIDGE_TIMEOUT_MS = 4000

		// 「写一篇日记」不是普通请求：宿主要去解压今天的会话、起一只子代理、写 20–90 秒。
		// 拿 4 秒去卡它，实际情况是「她还在写，界面先说失败」，用户点第二次又撞 busy。
		// 所以分档：写日记 180 秒，选文件夹 300 秒（等人翻目录），其余一律 4 秒快速失败。
		const DIARY_WRITE_TIMEOUT_MS = 180000
		const DIARY_PICK_TIMEOUT_MS = 300000
		// 统计：宿主 todayView 最多等 8 秒（index.js DIARY_SCAN_WAIT_MS）才回 scanning，
		// 4 秒会先 abort（体感审 F2）。三处时间必须配套看，别只按一个数字改：
		//   · 宿主：8 秒后不等了，先把 "scanning + 旧数字" 回给页面，后台算完写回「二、今天」；
		//   · 客户端：单次请求给 15 秒（这里），比宿主那 8 秒多留余量，不会先自杀；
		//   · 前端轮询：拿到 scanning 后每 1500ms 追问一次、最多 20 次（≈30 秒），
		//     加起来才够覆盖「冷启动扫描 + 写回文档」的整段，不是三次请求各给 15 秒。
		const DIARY_STATS_TIMEOUT_MS = 15000

		/**
		 * 桥请求。
		 *
		 * @param {string} path 桥内路径（不含 /api/dsh-pet-cuteness-plugin）
		 * @param {object|null|undefined} body undefined/null = GET，其它 = POST JSON
		 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
		 *   'timeoutMs' 不传 = 4000（快速失败）；'0' = 不装 AbortController（真等人，不算超时）。
		 */
		function bridgeRequest(path, body, options) {
		  const opts = options && typeof options === 'object' ? options : {}
		  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : BRIDGE_TIMEOUT_MS
		  // null 也当 GET：读类接口（/diary/today）常被写成 bridgeRequest(path, null, …)，
		  // 当成 POST 会被宿主 405 掉，界面上只看到「内部出错了」。
		  const requestOptions =
		    body === undefined || body === null
		      ? { method: 'GET' }
		      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
		  let timer = 0
		  if (opts.signal) {
		    requestOptions.signal = opts.signal
		  } else if (timeoutMs > 0 && typeof AbortController === 'function') {
		    const controller = new AbortController()
		    requestOptions.signal = controller.signal
		    timer = setTimeout(() => {
		      try {
		        controller.abort()
		      } catch {
		        /* 老浏览器没有 abort：退回"没有超时"的老行为，不影响主流程 */
		      }
		    }, timeoutMs)
		  }
		  return fetch(BRIDGE + path, requestOptions)
		    .then((response) =>
		      response.json().then((payload) => {
		        if (!payload || payload.ok !== true) {
		          // 错误码两种写法都认：老接口是顶层 code，新接口（/pet/treats）是
		          // {ok:false,error:{code}}。只认一种的话，界面上就只剩「内部出错了」。
		          const nested = payload && payload.error && typeof payload.error === 'object' ? payload.error : null
		          const error = new Error((payload && payload.code) || (nested && nested.code) || 'bridge-failed')
		          // 宿主给的人话/原因带上，explain() 在码表没命中时还能说点具体的
		          if (payload && typeof payload.reason === 'string') error.reason = payload.reason
		          if (payload && typeof payload.detail === 'string') error.detail = payload.detail
		          if (payload && typeof payload.message === 'string') error.detail = payload.message
		          if (nested && typeof nested.detail === 'string' && !error.detail) error.detail = nested.detail
		          if (nested && typeof nested.message === 'string' && !error.detail) error.detail = nested.message
		          throw error
		        }
		        return payload.value
		      }),
		    )
		    .then(
		      (value) => {
		        if (timer) clearTimeout(timer)
		        return value
		      },
		      (error) => {
		        if (timer) clearTimeout(timer)
		        // AbortError 归一成 timeout 码：界面要能说「等太久了」，不是显示英文异常名。
		        if (error && (error.name === 'AbortError' || /abort/i.test(String(error.message)))) {
		          throw new Error('timeout')
		        }
		        throw error
		      },
		    )
		}

		function writeSessionFlags(sessionId, flags) {
		  return bridgeRequest('/session', { sessionId: sessionId, flags: flags })
		}

		function writeDefaults(flags) {
		  return bridgeRequest('/defaults', flags)
		}

		/**
		 * 开关状态的**模块级共享 store**。
		 *
		 * 为什么必须共享：输入框的 ToggleBar 和插件详情页的 PluginSettings 是两个独立
		 * 组件，各自 useState 的话，点开关只改自己那份，另一个永远停在挂载时读到的值。
		 * 症状是用户报的「关掉再打开挂件不出来」那一版（当时是挂件与输入框各持一份
		 * defaults.widget）——组件拆开后仍然必须共用这一份。
		 *
		 * 用最小订阅表实现：一份 state + 一组 setState 回调，写入时广播。
		 */
		// 桥不通时用的出厂值：语气与中文思考默认关（用户自己定的：省 token，默认开着是打扰）。
		// ⚠️ 这两个常量被误删过一次。事故经过：删立绘色常量时用「往前找最近的 /**」定位，
		// 把紧挨在前面的 CLIENT_DEFAULT_FLAGS 与 CARD_ACCENT 一起吞了；本地测试只做语法检查和
		// 字符串断言，全绿，直到用户在真机刷新时炸出
		//   ReferenceError: CLIENT_DEFAULT_FLAGS is not defined → dsh-pet-cuteness-plugin: import failed
		// 整个浏览器半不加载，界面一片哑。守门测试现在断言这两行必须存在。
		const CLIENT_DEFAULT_FLAGS = { persona: false, thinking: false }

		// 角色主色（胶囊、按钮、提示文字用它）。
		const CARD_ACCENT = {
		  deepseek: '#4D8FE0',
		  claude: '#D97757',
		  gpt: '#8E8E93',
		  generic: '#7A7A7A',
		}

		const flagStore = {
		  state: null,
		  subs: new Set(),
		  loading: null,
		  set(next) {
		    flagStore.state = next
		    for (const fn of flagStore.subs) {
		      try {
		        fn(next)
		      } catch {
		        /* 某个订阅者抛错不能拖垮其它订阅者 */
		      }
		    }
		  },
		  /** 首次加载只发一次请求，多个组件同时挂载时共用。 */
		  load() {
		    if (flagStore.loading) return flagStore.loading
		    // 失败/超时之后必须把 loading 放掉：否则这一个 promise 会永久占着，
		    // 之后任何组件再想读都只是重新 await 同一个已经死掉的结果，永远不重试。
		    const inflight = bridgeRequest('/state')
		      .then((value) => {
		        const defaults = core.normalizeFlags((value && value.defaults) || null, CLIENT_DEFAULT_FLAGS)
		        const sessions = (value && value.sessions) || {}
		        flagStore.set({ defaults: defaults, sessions: sessions })
		        return flagStore.state
		      })
		      .catch(() => {
		        // 桥不通：给出厂值（挂件**开**），不报错。
		        // 这里以前用 core 的默认参数（那会儿是全关），结果桥一挂就等于"挂件消失"——
		        // 用户看不到任何报错，只能得出"插件坏了"。现在兜底值由浏览器半自己定。
		        flagStore.set({ defaults: core.normalizeFlags(null, CLIENT_DEFAULT_FLAGS), sessions: {} })
		        return flagStore.state
		      })
		    flagStore.loading = inflight
		    inflight.then(
		      () => {
		        flagStore.loading = null
		      },
		      () => {
		        flagStore.loading = null
		      },
		    )
		    return inflight
		  },
		}

		/**
		 * 订阅共享 store，返回当前快照。
		 *
		 * sessionId 只影响**读**的时候从哪个桶取 flags；写的时候各自写各自的桶。
		 * 传空串表示只关心应用级 defaults（挂件用）。
		 */
		function useToggleFlags(sessionId) {
		  const [state, setLocal] = useState(flagStore.state)
		  useEffect(() => {
		    flagStore.subs.add(setLocal)
		    if (flagStore.state === null) {
		      flagStore.load()
		    } else {
		      // 已经加载过：立即同步一次，避免组件后挂载时拿到 null。
		      setLocal(flagStore.state)
		    }
		    return () => {
		      flagStore.subs.delete(setLocal)
		    }
		  }, [])
		  if (!state) return [null, () => {}]
		  const table = state.sessions || {}
		  const defaults = state.defaults
		  const flags = core.normalizeFlags(sessionId ? table[sessionId] : undefined, defaults)
		  // 写入统一走 store，保证所有组件同时看到新值。
		  const setState = (next) => {
		    const merged = {
		      defaults: next.defaults || defaults,
		      sessions: Object.assign({}, table, sessionId ? { [sessionId]: next.flags || flags } : {}),
		    }
		    flagStore.set(merged)
		  }
		  return [{ defaults: defaults, flags: flags }, setState]
		}

		/**
		 * 写盘失败时给用户看的一句话。
		 *
		 * 为什么必须让用户看见（code-auditor B1）：以前的写法是 catch(() => {}) ——
		 * 界面立刻显示"开"，宿主其实还是"关"，下一轮请求没有任何变化。用户得到的
		 * 结论只能是"这插件没用"，而我们没有任何线索。失败率最高的场景恰恰是
		 * 桥没挂上（宿主服务还没就绪、端口变了、页面是旧缓存）。
		 */
		const WRITE_FAILED = '没保存上：宿主桥没响应，开关已退回原状（刷新页面再试一次）'

		/** 一个紧凑的开关按钮（输入框工具行高度只有 ~28px）：圆点 + 名字 + 明确的「开/关」。 */
		function MiniToggle(props) {
		  const on = props.on === true
		  return h(
		    'button',
		    {
		      type: 'button',
		      onClick: props.onClick,
		      title: props.title,
		      'aria-label': props.title,
		      'aria-pressed': on ? 'true' : 'false',
		      style: {
		        display: 'inline-flex',
		        alignItems: 'center',
		        gap: 4,
		        height: 24,
		        padding: '0 8px',
		        borderRadius: 12,
		        cursor: 'pointer',
		        fontSize: 11,
		        lineHeight: 1,
		        border: '1px solid ' + (on ? props.accent : 'var(--dsw-alias-border-l2, rgba(255,255,255,0.16))'),
		        background: on ? props.accent + '22' : 'transparent',
		        color: on ? props.accent : 'var(--dsw-alias-label-secondary, rgba(255,255,255,0.66))',
		        transition: 'background 120ms ease, color 120ms ease, border-color 120ms ease',
		      },
		    },
		    // 6px 的圆点只能当"扫一眼"的辅助，用户明确说过看不出开没开。
		    // 所以再加一个文字「开/关」：边框、底色、文字三层一起表达状态，色弱也能读。
		    h('span', {
		      'aria-hidden': 'true',
		      style: {
		        width: 6,
		        height: 6,
		        borderRadius: '50%',
		        background: on ? props.accent : 'transparent',
		        border: on ? 'none' : '1px solid currentColor',
		        flex: 'none',
		      },
		    }),
		    props.label,
		    props.showState === false
		      ? null
		      : h('span', { style: { fontSize: 10, fontWeight: 600, opacity: on ? 0.95 : 0.62 } }, on ? '开' : '关'),
		  )
		}

		/**
		 * 输入框左边的三项开关（语气 / 中文思考 / 台词）。
		 *
		 * 挂在 conversation.input.left（session 作用域，宿主直接给 sessionId），
		 * 所以"每个对话各自开关"是天然成立的，不需要我自己去猜当前会话是谁。
		 *
		 * 2026-10-24：试过把三颗收成一颗「娘 1」紧凑按钮，用户不要——这三项要一眼看全、
		 * 一下点准，所以恢复成三颗独立胶囊（开/关 文案 + title 解释）。
		 */
		function ToggleBar(props) {
		  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
		  const [state, setState] = useToggleFlags(sessionId)
		  // 写盘失败要**看得见**：见 WRITE_FAILED 的注释（code-auditor B1）。
		  const [failed, setFailed] = useState(false)
		  if (!state) return null
		  const flags = state.flags

		  // 只发 persona/thinking/lines 三个键：宿主半是白名单，多传键会被整单拒绝（400），
		  // 那才是"点了没反应"的经典来源。
		  const toggleSession = (key) => {
		    if (!sessionId) {
		      // 拿不到 sessionId 就写不了会话级状态。这不是崩溃，是"这个位置不该出现"：
		      // 宿主换过槽位契约时会出现，宁可什么都不做也不要写脏数据。
		      setFailed(true)
		      return
		    }
		    const before = { defaults: state.defaults, flags: flags }
		    const next = core.toggleFlag(flags, key)
		    setState({ defaults: state.defaults, flags: next })
		    setFailed(false)
		    writeSessionFlags(sessionId, {
		      persona: next.persona === true,
		      thinking: next.thinking === true,
		      lines: next.lines === true,
		    })
		      .then(() => {
		        // 台词刚被打开：立刻回到正常间隔，不继承关掉期间的 15 秒退避（t4 F18）。
		        if (key === 'lines' && next.lines === true) linesControl.reset()
		      })
		      .catch((error) => {
		      // 回滚到点之前：界面绝不能停在"开"而宿主是"关"——那正是用户报的"开了没效果"。
		      setState(before)
		      setFailed(true)
		      try {
		        console.warn('[dsh-pet-cuteness-plugin] 会话开关写入失败', error)
		      } catch {
		        /* 控制台不可用也不能崩 */
		      }
		    })
		  }

		  const accent = CARD_ACCENT.deepseek
		  return h(
		    'div',
		    { style: { display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 } },
		    h(MiniToggle, {
		      key: 'persona',
		      on: flags.persona === true,
		      accent: accent,
		      label: '语气',
		      title: '人设语气（本会话生效）：让她按人格说话，会增加每次请求的 token 开销',
		      onClick: () => toggleSession('persona'),
		    }),
		    h(MiniToggle, {
		      key: 'thinking',
		      on: flags.thinking === true,
		      accent: accent,
		      label: '中文思考',
		      title: '中文思考（本会话生效）：思考过程改用中文，同样会增加每次请求的 token 开销',
		      onClick: () => toggleSession('thinking'),
		    }),
		    h(MiniToggle, {
		      key: 'lines',
		      on: flags.lines === true,
		      accent: accent,
		      label: '台词',
		      title: '台词（本会话生效）：把她思考时的嘀咕摘一两句冒在输入框上方，不额外花钱',
		      onClick: () => toggleSession('lines'),
		    }),
		    failed
		      ? h(
		          'span',
		          {
		            style: {
		              fontSize: 11,
		              color: 'var(--dsw-alias-label-error, #ff6b6b)',
		              whiteSpace: 'nowrap',
		            },
		            title: WRITE_FAILED,
		          },
		          '未保存',
		        )
		      : null,
		  )
		}


		// ── 台词气泡：挂在她头顶，跟着她走 ────────────────────────────
		//
		// 用户定的方向：把模型思考过程里"像人话"的碎片直接冒在界面上。
		// 2026-10-22 用户实测后追加了一条：**气泡要跟着挂件走**。
		// 上一版把气泡挂在 「conversation.input.dock」（输入框上方），挂件被拖到别处时
		// 气泡还钉在右下角，看着就是"两个不相关的东西"。
		//
		// 现在的结构：
		//   · 会话 id 由会话作用域的 「LinesSessionBridge」 递出来（dock 槽，渲染 null）；
		//   · 气泡本体挂在 「shell.overlay」（root 作用域），位置由 dsh-pet 的
		//     「$DSH_HOME/pet.json → display」 决定，1.5 秒轮询一次，所以拖动挂件气泡会跟；
		//   · 数据仍然来自宿主半的 「GET /lines」 长轮询。
		//
		// 三条对用户的承诺：
		//   1. 一次只冒一句，5 秒后自己走，不挡视线、不堆叠；
		//   2. 关掉「台词」就不再拉（宿主那边也立刻回空，不让浏览器白等 15 秒）；
		//   3. 任何失败都静默重试——台词是装饰，绝不能变成错误提示。
		const READ_SLOW_MS = 2500
		// 页面不可见时的轮询间隔（只做还活着的心跳，不真发请求）
		const HIDDEN_POLL_MS = 4000
		const LINES_POLL_WAIT_MS = 8000
		// 看门狗：25 秒还没有任何一次轮询跑完，就当循环死了，重新拉起来。
		// 为什么需要：fetch 兜底超时只管住「请求挂住」，管不住「下一次 setTimeout 根本没排上」
		// （某个 then 里抛了异常、或定时器被别的路径清掉）——那种情况下气泡会无声停死。
		const LINES_WATCHDOG_MS = 25000
		const LINES_SHOW_MS = 3200
		const LINES_QUEUE_MAX = 10
		// 台词开着时的长轮询间隔：一次问完立刻问下一次（宿主那边 wait 会挡住 8 秒）。
		const LINES_POLL_MS = 400
		// 关掉台词后宿主立刻回 enabled:false，再按 400ms 问就是纯空转（2.5 次/秒）。
		// 退避到 3 秒起步，按 1.8 倍放长，封顶 15 秒——用户重新打开台词时最多 15 秒冒一句。
		const LINES_OFF_RETRY_MS = 3000
		const LINES_MAX_RETRY_MS = 15000
		// 网络/宿主错误：2 秒起，×2 放长，封顶 10 秒。
		const LINES_ERR_RETRY_MS = 2000
		const LINES_ERR_MAX_RETRY_MS = 10000
		// 宿主在、但台词引擎没挂（unavailable）：5 秒问一次，别空转也别放弃。
		const LINES_UNAVAILABLE_RETRY_MS = 5000
		// 「形状不认识」的兜底：宿主明明在，只是字段名对不上（重塑返回体、被反代包了一层）时，
		// 别再退到 5 秒——那就是用户实测的「半天不出词」。800ms 再问一次，代价只是一点请求。
		const LINES_UNKNOWN_RETRY_MS = 800
		// 一次拉到台词后立刻续问：让 cursor 尽快追上宿主队列。
		// 用户感知是「一句接一句」，而不是每句都额外搭上 400ms 才去问下一批。
		const LINES_DRAIN_MS = 120
		const LINES_BACKOFF_FACTOR = 1.8
		// 关台词期间会退避到最多 15 秒一次；用户重新打开时必须马上恢复到正常节奏，
		// 不能继承关掉期间的退避（契约审 t4 F18：这就是「台词生成变慢」的直接原因）。
		// 共享一份对象：ToggleBar 写盘成功后 reset()，气泡那边同时把睡眠中的定时器叫醒。
		const linesControl = {
		  backoff: { off: 0, err: 0 },
		  wake: null,
		  reset() {
		    this.backoff.off = 0
		    this.backoff.err = 0
		    const wake = this.wake
		    if (typeof wake === 'function') {
		      try {
		        wake()
		      } catch {
		        /* 气泡还没挂上/已经卸载：只清退避就够了 */
		      }
		    }
		  },
		}
		// 量不到立绘时退回 /pet 轮询：2 秒一次（原先 5 秒，拖动后最坏要等 5 秒才对齐）。
		const PET_FALLBACK_POLL_MS = 2000
		// 采样节流：≥120ms 且位移 >1px 才提交。拖动中约 8 次/秒，肉眼看是连续跟手；静止时 0 次。
		const PET_SAMPLE_MIN_INTERVAL_MS = 120
		const PET_SAMPLE_MIN_DELTA_PX = 1
		const PET_DEFAULT_SIZE = 160
		const PET_DEFAULT_EDGE = 20
		const PET_ANCHOR_OFFSET_Y = 6

		/** 只认真正有限的数字；不 throw。 */
		function finiteOr(value, fallback) {
		  return typeof value === 'number' && isFinite(value) ? value : fallback
		}

		function nowMs() {
		  try {
		    return typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
		      ? performance.now()
		      : Date.now()
		  } catch {
		    return Date.now()
		  }
		}

		/**
		 * 台词轮询下一次的等待时间（纯函数，便于单测）。
		 *
		 * 价值不在"算一个数"，而在**不空转**：关掉台词后宿主立即返回，旧代码固定 400ms
		 * 再问一次，于是一个关掉的开关每秒烧 2.5 个请求。这里按三种结局分别退避：
		 *   · enabled:false → 3000ms 起，×1.8，封顶 15000ms；
		 *   · enabled:true  → 回到 400ms（用户重新打开后要立刻有反应）；
		 *   · 传 {error:true} → 2000ms 起，×2，封顶 10000ms；
		 *   · value 为空（路由不认识/宿主没给值）→ 固定 5000ms。
		 *
		 * @param {{enabled?:boolean, unavailable?:boolean, retryAfterMs?:number, error?:boolean}|null} value
		 * @param {{off?:number, err?:number}} state 调用方持有的一份退避状态（会被改写）
		 * @returns {number} 毫秒
		 */
		function nextLinesDelay(value, state) {
		  const s = state && typeof state === 'object' ? state : {}
		  const off = finiteOr(s.off, 0)
		  const err = finiteOr(s.err, 0)
		  if (value && value.unavailable === true) {
		    s.off = 0
		    s.err = 0
		    return LINES_UNAVAILABLE_RETRY_MS
		  }
		  if (value && value.enabled === true) {
		    s.off = 0
		    s.err = 0
		    // 这一批里真有台词：立刻续问（120ms），让 cursor 追上宿主队列。
		    return Array.isArray(value.lines) && value.lines.length > 0 ? LINES_DRAIN_MS : LINES_POLL_MS
		  }
		  if (value && value.enabled === false) {
		    s.err = 0
		    const floor = Math.max(LINES_OFF_RETRY_MS, Math.round(finiteOr(value.retryAfterMs, 0)))
		    s.off = off > 0 ? Math.min(LINES_MAX_RETRY_MS, Math.round(off * LINES_BACKOFF_FACTOR)) : floor
		    return Math.max(floor, s.off)
		  }
		  if (value && value.error === true) {
		    s.off = 0
		    s.err = err > 0 ? Math.min(LINES_ERR_MAX_RETRY_MS, Math.round(err * 2)) : LINES_ERR_RETRY_MS
		    return s.err
		  }
		  // 给了对象、却没有我们认识的 enabled 字段（宿主重塑过返回体、被反代包了一层）：
		  // 当作「开着」快速重问，别掉进 5 秒的「宿主没准备好」分支——这就是「半天不出词」。
		  if (value && typeof value === 'object' && value.enabled === undefined) {
		    s.off = 0
		    s.err = 0
		    const batch = Array.isArray(value.lines) ? value.lines.length : 0
		    return batch > 0 ? LINES_DRAIN_MS : LINES_UNKNOWN_RETRY_MS
		  }
		  return LINES_UNAVAILABLE_RETRY_MS
		}

		/**
		 * 时间输入规范化（与宿主半 'normalizeTimeInput' 同一份规则）。
		 * '9:00' / '9：00' / ' 21:00 ' / '2100' → 'HH:MM'；'25:00' / '9点' / 'abc' → null。
		 */
		function normalizeTimeInput(raw) {
		  if (raw === null || raw === undefined) return null
		  let text = String(raw).trim().replace(/：/g, ':')
		  if (!text) return null
		  // 纯数字：2100 / 0930 / 930（3 位补 0）
		  if (/^[0-9]{3,4}$/.test(text)) {
		    const padded = ('0000' + text).slice(-4)
		    text = padded.slice(0, 2) + ':' + padded.slice(2)
		  }
		  const match = /^([0-9]{1,2}):([0-9]{2})$/.exec(text)
		  if (!match) return null
		  const hour = Number(match[1])
		  const minute = Number(match[2])
		  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) return null
		  return (hour < 10 ? '0' : '') + hour + ':' + (minute < 10 ? '0' : '') + minute
		}

		/**
		 * '/pet' 的 display（dsh-pet 用 right/bottom 定位）→ 视口 rect。
		 *
		 * 只在 DOM 量不到立绘时用来兜底。注意 'visible === false' 是"她自己藏起来了"，
		 * 这时不该继续在她原来的位置冒气泡，退回默认位置。
		 */
		function anchorFromPetDisplay(display, viewport) {
		  if (!display || typeof display !== 'object' || display.visible === false) return null
		  const vw = finiteOr(viewport && viewport.w, 0)
		  const vh = finiteOr(viewport && viewport.h, 0)
		  if (!(vw > 0) || !(vh > 0)) return null
		  const size = Math.max(1, finiteOr(display.size, PET_DEFAULT_SIZE))
		  const right = finiteOr(display.right, PET_DEFAULT_EDGE)
		  const bottom = finiteOr(display.bottom, PET_DEFAULT_EDGE)
		  const left = vw - right - size
		  const top = vh - bottom - size
		  return { left: left, top: top, right: left + size, bottom: top + size, width: size, height: size }
		}

		/** 兜底位置：右下角 20px、160 见方（和 dsh-pet 的出厂位置一致）。 */
		function defaultPetAnchor(viewport) {
		  const vw = Math.max(1, finiteOr(viewport && viewport.w, 1280))
		  const vh = Math.max(1, finiteOr(viewport && viewport.h, 800))
		  const left = vw - PET_DEFAULT_EDGE - PET_DEFAULT_SIZE
		  const top = vh - PET_DEFAULT_EDGE - PET_DEFAULT_SIZE
		  return {
		    left: left,
		    top: top,
		    right: left + PET_DEFAULT_SIZE,
		    bottom: top + PET_DEFAULT_SIZE,
		    width: PET_DEFAULT_SIZE,
		    height: PET_DEFAULT_SIZE,
		  }
		}

		/**
		 * 三级降级的决策函数（纯逻辑、零 DOM、永不 throw）。
		 *
		 * 1 级：'[class*="spriteWrap"]' 的 getBoundingClientRect —— 真值，拖动/走路都跟得上；
		 * 2 级：'/pet' 的 display（right/bottom 坐标系）换算成 rect —— dsh-pet 在但量不到 DOM；
		 * 3 级：右下角默认 20/20/160 —— 连 /pet 都读不到，气泡也不能消失。
		 */
		function pickPetAnchor(input) {
		  const source = input && typeof input === 'object' ? input : {}
		  const rawViewport = source.viewport && typeof source.viewport === 'object' ? source.viewport : {}
		  const viewport = {
		    w: Math.max(1, finiteOr(rawViewport.w, 1280)),
		    h: Math.max(1, finiteOr(rawViewport.h, 800)),
		  }
		  // 挂件收起来了（用户 2026-10-27：隐藏挂件后气泡还在原地冒）。
		  // 这时候不是"换个位置接着画"，是"不画"——台词跟挂件一起出现、一起消失。
		  if (source.hidden === true) return { level: 0, hidden: true, viewport: viewport }
		  if (source.petDisplay && source.petDisplay.visible === false) {
		    return { level: 0, hidden: true, viewport: viewport }
		  }
		  const sprite = source.sprite
		  const width = finiteOr(sprite && sprite.width, 0)
		  const height = finiteOr(sprite && sprite.height, 0)
		  if (sprite && width > 0 && height > 0) {
		    const left = finiteOr(sprite.left, 0)
		    const top = finiteOr(sprite.top, 0)
		    return {
		      level: 1,
		      viewport: viewport,
		      rect: {
		        left: left,
		        top: top,
		        right: finiteOr(sprite.right, left + width),
		        bottom: finiteOr(sprite.bottom, top + height),
		        width: width,
		        height: height,
		      },
		    }
		  }
		  const fromPet = anchorFromPetDisplay(source.petDisplay, viewport)
		  if (fromPet) return { level: 2, viewport: viewport, rect: fromPet }
		  return { level: 3, viewport: viewport, rect: defaultPetAnchor(viewport) }
		}

		/** 节流判据：距上次提交 ≥120ms 且任一方向位移 >1px（纯函数）。 */
		function shouldCommitAnchor(prev, rect, lastAt, now) {
		  if (!rect) return false
		  if (!prev) return true
		  if (!(now - lastAt >= PET_SAMPLE_MIN_INTERVAL_MS)) return false
		  return (
		    Math.abs(rect.left - prev.left) > PET_SAMPLE_MIN_DELTA_PX ||
		    Math.abs(rect.top - prev.top) > PET_SAMPLE_MIN_DELTA_PX
		  )
		}

		/**
		 * 向上找带 'transform' 的祖先。
		 *
		 * 为什么要在意：'position: fixed' 的后代如果祖先带 transform，fixed 会退化成
		 * 「相对那个祖先」定位，气泡会整体偏移。命中时改用 absolute + 祖先 rect 换算。
		 */
		function hasTransformedAncestor(el, readStyle) {
		  try {
		    if (!el || typeof readStyle !== 'function') return false
		    let node = el.parentElement
		    while (node && node.nodeType === 1) {
		      const style = readStyle(node)
		      if (style && style.transform && style.transform !== 'none') return true
		      node = node.parentElement
		    }
		  } catch {
		    /* 读样式失败就当没有 transform，退回 fixed */
		  }
		  return false
		}

		function viewportOf() {
		  try {
		    return {
		      w: Math.max(1, finiteOr(window.innerWidth, 1280)),
		      h: Math.max(1, finiteOr(window.innerHeight, 800)),
		    }
		  } catch {
		    return { w: 1280, h: 800 }
		  }
		}

		/**
		 * 量 dsh-pet 的立绘。**只读，不写 DOM**（rAF 里写 DOM 会触发回流）。
		 *
		 * 选择器只用子串/属性：'spriteWrap' 前面的 'v78Lda_' 是 CSS Modules 哈希，
		 * dsh-pet 一升级就变；写死类名等于下次升级气泡就掉回右下角。
		 */
		function measureSprite() {
		  try {
		    if (typeof document === 'undefined') return null
		    const root = document.querySelector('div[data-dsh-pet-root]')
		    if (!root) return null
		    const sprite = root.querySelector('[class*="spriteWrap"]')
		    if (!sprite) return null
		    const rect = sprite.getBoundingClientRect()
		    if (!rect || !(finiteOr(rect.width, 0) > 0) || !(finiteOr(rect.height, 0) > 0)) return null
		    return {
		      left: finiteOr(rect.left, 0),
		      top: finiteOr(rect.top, 0),
		      right: finiteOr(rect.right, finiteOr(rect.left, 0) + finiteOr(rect.width, 0)),
		      bottom: finiteOr(rect.bottom, finiteOr(rect.top, 0) + finiteOr(rect.height, 0)),
		      width: finiteOr(rect.width, 0),
		      height: finiteOr(rect.height, 0),
		    }
		  } catch {
		    return null
		  }
		}

		/** dsh-pet 自己的状态气泡占着位置时，把我们的气泡再让开一行（可选优化，失败不影响）。 */
		function measureNeighborOffset(scale) {
		  try {
		    if (typeof document === 'undefined') return PET_ANCHOR_OFFSET_Y
		    const root = document.querySelector('div[data-dsh-pet-root]')
		    if (!root) return PET_ANCHOR_OFFSET_Y
		    // dsh-pet 的气泡用的是 CSS Module 类名（...bubble、bubbleUsage 这些），
		    // 老代码查的 bubbleAnchor 在它的 DOM 里根本不存在，所以从来没让开过。
		    // 现在按真实类名找，取「所有可见气泡里最高的那条边」当邻居的上沿。
		    const sprite = measureSprite()
		    if (!sprite) return PET_ANCHOR_OFFSET_Y
		    let topEdge = null
		    const nodes = root.querySelectorAll('[class*="bubble"]')
		    for (let i = 0; i < nodes.length; i += 1) {
		      const rect = nodes[i].getBoundingClientRect()
		      if (!(finiteOr(rect.width, 0) > 1) || !(finiteOr(rect.height, 0) > 1)) continue
		      if (rect.bottom > sprite.top + 2) continue // 在立绘里面的（点击热区之类）不算
		      if (topEdge === null || rect.top < topEdge) topEdge = rect.top
		    }
		    if (topEdge === null) return PET_ANCHOR_OFFSET_Y
		    // 让到人家气泡上面：距离 = 立绘上沿到它上沿 + 一点缝。
		    //
		    // 不乘 bubbleScale：sprite.top 与 topEdge 都是 getBoundingClientRect 的视口像素，
		    // 缩放已经含在里面了；再乘一次就是双重缩放（bubbleScale 一改，气泡会飘到屏幕外）。
		    // 上限 220px 是防呆：人家的气泡若飘到屏幕顶端，我们跟着飘过去会整个飞出可视区，
		    // 不如老老实实贴着立绘头顶。
		    const gap = Math.round(sprite.top - topEdge + 6)
		    return Math.min(220, Math.max(PET_ANCHOR_OFFSET_Y, gap))
		  } catch {
		    /* 读不到就按默认间隙 */
		  }
		  return PET_ANCHOR_OFFSET_Y
		}

		/** 判断气泡该用 fixed 还是 absolute（transform 祖先陷阱）。 */
		function resolveAnchorFrame(container) {
		  try {
		    if (!container) return { position: 'fixed', origin: { left: 0, top: 0 } }
		    const readStyle = (node) => {
		      try {
		        return window.getComputedStyle(node)
		      } catch {
		        return null
		      }
		    }
		    if (!hasTransformedAncestor(container, readStyle)) return { position: 'fixed', origin: { left: 0, top: 0 } }
		    let node = container.parentElement
		    while (node && node.nodeType === 1) {
		      const style = readStyle(node)
		      if (style && style.transform && style.transform !== 'none') {
		        const rect = node.getBoundingClientRect()
		        return { position: 'absolute', origin: { left: finiteOr(rect.left, 0), top: finiteOr(rect.top, 0) } }
		      }
		      node = node.parentElement
		    }
		  } catch {
		    /* 任何异常都退回 fixed */
		  }
		  return { position: 'fixed', origin: { left: 0, top: 0 } }
		}


		// 会话 id 从会话作用域的组件递给 root 作用域的气泡：overlay 拿不到 sessionId，
		// 不这么传就会串台（A 会话的嘀咕冒在 B 会话的窗口上）。
		let linesSessionId = ''
		const linesSessionSubs = new Set()
		function publishLinesSession(id) {
		  if (typeof id !== 'string' || id === linesSessionId) return
		  linesSessionId = id
		  linesSessionSubs.forEach((fn) => {
		    try {
		      fn(id)
		    } catch {
		      // 某个订阅方（可能是别的插件塞进来的）抛错，不能连累其它订阅方收到会话 id；
		      // 这里也没有可降级的东西——丢了这一个 id 只影响它自己那一条台词。
		    }
		  })
		}

		function LinesSessionBridge(props) {
		  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
		  useEffect(() => {
		    publishLinesSession(sessionId)
		  }, [sessionId])
		  return null
		}

		/**
		 * 「她现在在哪」：实时量 dsh-pet 的立绘，而不是每 5 秒读一次 pet.json。
		 *
		 * 为什么必须量 DOM：dsh-pet 拖动时只在 pointerup 落盘 pet.json，走路动画更是每帧
		 * 直接改 float.style。pet.json 永远是滞后值——这就是「拖完挂件，气泡最多 5 秒后才跟」。
		 * 真值只有 '[class*="spriteWrap"]' 的 getBoundingClientRect。
		 *
		 * 采样：rAF 自循环、只读不写；提交节流 120ms / 1px（见 shouldCommitAnchor）。
		 * 降级：量不到 → 停 rAF，2 秒轮询 /pet（页面隐藏时 4 秒）；轮询里也顺手再量 DOM，
		 * 立绘一出现立刻回 1 级并停轮询。三级全失败也只会是默认右下角，绝不抛错。
		 *
		 * @param {boolean} active 气泡可见时才采样（空闲成本 0）
		 * @param {{current: HTMLElement|null}} containerRef 锚点容器（判断 transform 祖先）
		 * @returns {object|null} {level, rect, viewport, offsetY, position, origin, scale}
		 */
		function usePetAnchor(active, containerRef) {
		  const [anchor, setAnchor] = useState(null)
		  const anchorRef = useRef(null)

		  useEffect(() => {
		    if (!active) return undefined
		    let stopped = false
		    let raf = 0
		    let pollTimer = 0
		    let petDisplay = null
		    let lastAt = 0

		    const stopRaf = () => {
		      if (raf) {
		        try {
		          cancelAnimationFrame(raf)
		        } catch {
		          /* 老环境没有 cancelAnimationFrame：下一帧自己会 return */
		        }
		        raf = 0
		      }
		    }
		    const stopPoll = () => {
		      if (pollTimer) {
		        clearTimeout(pollTimer)
		        pollTimer = 0
		      }
		    }

		    // 贵操作只在"真的要提交"时做：getComputedStyle 会强制样式/布局同步，
		    // 气泡显示期间每帧做一次，恰好会拖累 dsh-pet 自己的跟手（体感审 F4）。
		    // 再各带一层缓存：offsetY 只跟 bubbleScale 走；frame 只跟锚点容器走。
		    // 不做缓存：pet 的气泡是"点一下出现、几秒后消失"，按 scale 缓存会让气泡一直让在旧位置。
		    // 这个测量只在 commit（节流后 ≤8 次/秒）里发生，成本可接受（不走 getComputedStyle）。
		    const neighborOffset = (scale) => measureNeighborOffset(scale)
		    let cachedFrame = null
		    let cachedFrameHost = null
		    const resolveFrame = () => {
		      const host = containerRef && containerRef.current
		      if (cachedFrame && cachedFrameHost === host) return cachedFrame
		      cachedFrameHost = host
		      cachedFrame = resolveAnchorFrame(host)
		      return cachedFrame
		    }

		    const commit = (result, now) => {
		      if (!result) return
		      const prev = anchorRef.current
		      const rawScale = petDisplay && petDisplay.bubbleScale
		      const scale = Math.max(0.5, finiteOr(rawScale, 1))
		      // 便宜的先算：一行比较，不碰 DOM。
		      const offsetY = neighborOffset(rawScale)
		      if (result.level === 1) {
		        if (prev && !shouldCommitAnchor(prev.rect, result.rect, lastAt, now)) return
		      } else if (result.hidden === true) {
		        // 挂件不在了：气泡一起收起来。已经收着就不重复渲染。
		        if (prev && prev.hidden === true) return
		      } else if (
		        // 降级路径由 2 秒轮询驱动：只有 level/位置真的变了才重渲染。
		        prev &&
		        prev.level === result.level &&
		        prev.rect &&
		        prev.rect.left === result.rect.left &&
		        prev.rect.top === result.rect.top &&
		        prev.offsetY === offsetY
		      ) {
		        return
		      }
		      // 节流通过了才取样式（逐祖先 getComputedStyle）——顺序反了就是白烧。
		      const frame = resolveFrame()
		      lastAt = now
		      const next = {
		        level: result.level,
		        hidden: result.hidden === true,
		        rect: result.rect,
		        viewport: result.viewport,
		        offsetY: offsetY,
		        position: frame.position,
		        origin: frame.origin,
		        scale: scale,
		      }
		      anchorRef.current = next
		      setAnchor(next)
		    }

		    const schedulePoll = (delay) => {
		      if (stopped) return
		      stopPoll()
		      pollTimer = setTimeout(probe, delay)
		    }

		    const startRaf = () => {
		      if (stopped) return
		      stopPoll()
		      if (!raf) raf = requestAnimationFrame(sampleFrame)
		    }

		    // rAF 采样：每帧读一次 rect，按节流提交。
		    function sampleFrame(now) {
		      raf = 0
		      if (stopped) return
		      try {
		        if (typeof document !== 'undefined' && document.hidden) return
		        const sprite = measureSprite()
		        if (!sprite) {
		          // 立绘没了 = 挂件被隐藏/关掉：气泡立刻一起收起来（不等 /pet 回包），
		          // 然后交给 2 秒轮询；挂件重新出现时轮询会再量到 DOM，自己回到 1 级。
		          commit(pickPetAnchor({ hidden: true, viewport: viewportOf() }), now)
		          schedulePoll(PET_FALLBACK_POLL_MS)
		          return
		        }
		        commit(pickPetAnchor({ sprite: sprite, petDisplay: petDisplay, viewport: viewportOf() }), now)
		        raf = requestAnimationFrame(sampleFrame)
		      } catch {
		        // 采样失败不能拖垮台词：停 rAF 交给兜底轮询，下一轮还会再试。
		        schedulePoll(PET_FALLBACK_POLL_MS)
		      }
		    }

		    // 兜底轮询：先量 DOM（最便宜），量不到才问 /pet。
		    function probe() {
		      pollTimer = 0
		      if (stopped) return
		      try {
		        if (typeof document !== 'undefined' && document.hidden) {
		          schedulePoll(HIDDEN_POLL_MS)
		          return
		        }
		        const sprite = measureSprite()
		        if (sprite) {
		          commit(pickPetAnchor({ sprite: sprite, petDisplay: petDisplay, viewport: viewportOf() }), nowMs())
		          startRaf()
		          return
		        }
		      } catch {
		        /* 落到 /pet */
		      }
		      // 挂件现在不在：先让气泡立刻收起来，再问 /pet「它到底还被不该在」。
		      // 收在等网络之前，是为了"点隐藏"这一下看得见反应，不是等 2 秒才消失。
		      commit(pickPetAnchor({ hidden: true, viewport: viewportOf() }), nowMs())
		      fetch(BRIDGE + '/pet', { method: 'GET' })
		        .then((response) => response.json())
		        .then((payload) => {
		          if (stopped) return
		          petDisplay = payload && payload.ok === true ? payload.value : null
		          commit(pickPetAnchor({ sprite: null, petDisplay: petDisplay, viewport: viewportOf() }), nowMs())
		        })
		        .catch(() => {
		          // /pet 都读不到：连"人在不在"都不知道，按不在处理，别在半空吊一个气泡。
		          if (stopped) return
		          commit(pickPetAnchor({ hidden: true, viewport: viewportOf() }), nowMs())
		        })
		        .then(() => {
		          schedulePoll(PET_FALLBACK_POLL_MS)
		        })
		    }

		    const onResize = () => {
		      if (stopped) return
		      try {
		        const sprite = measureSprite()
		        if (!sprite) {
		          commit(pickPetAnchor({ hidden: true, viewport: viewportOf() }), nowMs())
		          schedulePoll(PET_FALLBACK_POLL_MS)
		          return
		        }
		        commit(pickPetAnchor({ sprite: sprite, petDisplay: petDisplay, viewport: viewportOf() }), nowMs())
		      } catch {
		        /* resize 只是顺手对齐，失败不影响主循环 */
		      }
		    }
		    const onVisibility = () => {
		      if (stopped) return
		      let hidden = false
		      try {
		        hidden = typeof document !== 'undefined' && document.hidden === true
		      } catch {
		        hidden = false
		      }
		      if (hidden) {
		        stopRaf()
		        stopPoll()
		        return
		      }
		      // 回前台：立刻量一次，然后按当前能不能量到 DOM 选循环。
		      probe()
		    }

		    try {
		      window.addEventListener('resize', onResize)
		      if (typeof document !== 'undefined' && document.addEventListener) {
		        document.addEventListener('visibilitychange', onVisibility)
		      }
		    } catch {
		      /* 没有 window（单测假环境）：只跑一次 probe，不影响渲染 */
		    }
		    probe()

		    return () => {
		      stopped = true
		      stopRaf()
		      stopPoll()
		      try {
		        window.removeEventListener('resize', onResize)
		        if (typeof document !== 'undefined' && document.removeEventListener) {
		          document.removeEventListener('visibilitychange', onVisibility)
		        }
		      } catch {
		        /* 清理失败也不能抛 */
		      }
		    }
		  }, [active, containerRef])

		  return anchor
		}

		function LinesBubbleOverlay() {
		  const [sessionId, setSessionId] = useState(linesSessionId)
		  const [text, setText] = useState('')
		  const [bubbleSize, setBubbleSize] = useState({ w: 220, h: 34 })
		  const cursorRef = useRef(0)
		  const queueRef = useRef([])
		  // 与 ToggleBar 共用一份退避状态：重新打开台词时由 linesControl.reset() 清掉。
		  const backoffRef = useRef(linesControl.backoff)
		  const bubbleRef = useRef(null)
		  const containerRef = useRef(null)
		  const anchor = usePetAnchor(text !== '', containerRef)

		  useEffect(() => {
		    const fn = (id) => setSessionId(id)
		    linesSessionSubs.add(fn)
		    if (linesSessionId) setSessionId(linesSessionId)
		    return () => {
		      linesSessionSubs.delete(fn)
		    }
		  }, [])

		  // 切会话时把「上一场」的残留清干净：游标、待播队列、正在显示的那句、退避状态。
		  // 用户实测（m00558）：「切换会话的时候气泡要等 4–5 条才跳到新的会话内容」——
		  // ① queueRef 还排着旧会话的 4–5 句；② 新会话的请求带着旧 cursor 去问，宿主按
		  // cursor 分页，只会空转。这个 effect 必须排在长轮询 effect **之前**：React 先跑完
		  // 所有 cleanup 再按声明顺序跑 effect，重置先落地，紧随其后的长轮询才会用 cursor=0
		  // 发新会话的第一次请求（那个 effect 体里第一件事就是 poll()，不用等下一个定时器）。
		  useEffect(() => {
		    cursorRef.current = 0
		    queueRef.current = []
		    // 退避也归零：新会话不该继承上一场「关着/出错」攒下的 15 秒等待。
		    backoffRef.current = linesControl.backoff
		    backoffRef.current.off = 0
		    backoffRef.current.err = 0
		    setText('')
		  }, [sessionId])

		  // 位置不再在这里轮询 pet.json：usePetAnchor 每帧量 dsh-pet 的立绘（见上）。
		  // 这里只剩台词数据本身。

		  // 长轮询：拉到的句子入队。cursor 只在内存里，刷新页面就等于"从头开始听"，
		  // 不落 localStorage —— 台词是即时气氛，不是要回放的历史。
		  useEffect(() => {
		    if (!sessionId) return undefined
		    let stopped = false
		    let timer = 0
		    const poll = () => {
		      if (stopped) return
		      // 同上：后台标签页不挂长轮询，否则一个窗口就常占一条连接。
		      if (typeof document !== 'undefined' && document.hidden) {
		        timer = setTimeout(poll, HIDDEN_POLL_MS)
		        return
		      }
		      const url =
		        BRIDGE +
		        '/lines?sessionId=' +
		        encodeURIComponent(sessionId) +
		        '&cursor=' +
		        String(cursorRef.current) +
		        '&wait=' +
		        String(LINES_POLL_WAIT_MS)
		      // outcome 是这个请求的"结论"，给退避函数用：value / {error:true} / {unknown:true}。
		      // 一份"说不清形状"的回包（ok:false、字段改名）不能算 null——null 会退到 5 秒，
		      // 用户看到的就是「半天不出词」。{unknown:true} → 800ms 重问。
		      let outcome = null
		      // 兜底超时：长轮询本身最多等 8 秒，若连接被中间层吃掉（代理、休眠唤醒），
		      // fetch 会一直挂着 —— 挂住就再也不会排下一次 poll，气泡"无声停住"。
		      // 用户 2026-10-25 报的「几分钟后就不说话了」，这条是第二道保险。
		      const controller = typeof AbortController === 'function' ? new AbortController() : null
		      const failSafe = controller
		        ? setTimeout(() => {
		            try {
		              controller.abort()
		            } catch {
		              /* 已经结束了 */
		            }
		          }, LINES_POLL_WAIT_MS + 5000)
		        : 0
		      fetch(url, controller ? { method: 'GET', signal: controller.signal } : { method: 'GET' })
		        .then((response) => response.json())
		        .then((payload) => {
		          if (stopped) return
		          const value = payload && payload.ok === true ? payload.value : null
		          if (!value || typeof value !== 'object') {
		            outcome = { unknown: true }
		            return
		          }
		          outcome = value
		          // 兼容：宿主若暂时没给 enabled 字段，但给了 lines/cursor，仍按"开着"消费这一批，
		          // 别把台词丢了（nextLinesDelay 对缺 enabled 的形状按 800ms/120ms 处理）。
		          if (value.enabled === false) {
		            queueRef.current = []
		            return
		          }
		          if (typeof value.cursor === 'number') cursorRef.current = value.cursor
		          const lines = Array.isArray(value.lines) ? value.lines : []
		          for (let i = 0; i < lines.length; i += 1) {
		            const line = lines[i]
		            // 兼容：lines 里可能是字符串，而不是 {id,text,at}。
		            const lineText = typeof line === 'string' ? line : line && typeof line.text === 'string' ? line.text : ''
		            if (lineText) queueRef.current.push(lineText)
		          }
		          if (queueRef.current.length > LINES_QUEUE_MAX) {
		            queueRef.current = queueRef.current.slice(-LINES_QUEUE_MAX)
		          }
		        })
		        .catch(() => {
		          outcome = { error: true }
		          // 超时/中断过：游标可能已经跟宿主对不上，退回 0 从头对齐（宿主那边也会自愈）。
		          cursorRef.current = 0
		        })
		        .then(() => {
		          if (failSafe) clearTimeout(failSafe)
		          if (stopped) return
		          lastTickAt = Date.now()
		          // 关掉台词时宿主立刻回空：旧代码固定 400ms 再问，等于每秒 2.5 个空请求。
		          // 现在按结局退避（关着 ≥3s、出错 2s 起翻倍、宿主没准备好 5s）。
		          timer = setTimeout(poll, nextLinesDelay(outcome, backoffRef.current))
		        })
		    }
		    // 看门狗：兜住「循环自己死了」。只在真的超过 LINES_WATCHDOG_MS 没动静时才动，
		    // 正常轮询（8 秒一次）永远不会触发它，不会变成额外的请求源。
		    let lastTickAt = Date.now()
		    const watchdog = setInterval(() => {
		      if (stopped) return
		      if (Date.now() - lastTickAt < LINES_WATCHDOG_MS) return
		      if (timer) {
		        clearTimeout(timer)
		        timer = 0
		      }
		      poll()
		    }, 5000)
		    // 用户在开关里把台词打开：叫醒可能正睡 15 秒的定时器，立刻重问一次。
		    const wake = () => {
		      if (stopped) return
		      if (timer) {
		        clearTimeout(timer)
		        timer = 0
		      }
		      poll()
		    }
		    linesControl.wake = wake
		    poll()
		    return () => {
		      stopped = true
		      if (timer) clearTimeout(timer)
		      clearInterval(watchdog)
		      if (linesControl.wake === wake) linesControl.wake = null
		    }
		  }, [sessionId])

		  // 队列 → 屏幕：气泡空着就取下一句。用定时器是因为 queueRef 变化不触发渲染。
		  useEffect(() => {
		    if (!sessionId) return undefined
		    const timer = setInterval(() => {
		      if (queueRef.current.length === 0) return
		      setText((current) => {
		        if (current) return current
		        return queueRef.current.shift() || ''
		      })
		      // 450ms 一问：上一句刚消失就能接上下一条，不再"空两秒再冒一句"。
		    }, 450)
		    return () => clearInterval(timer)
		  }, [sessionId])

		  // 每句活 3.2 秒：用户说「两个气泡之间隔太久了」，就靠这个收窄节奏。
		  useEffect(() => {
		    if (!text) return undefined
		    const timer = setTimeout(() => setText(''), LINES_SHOW_MS)
		    return () => clearTimeout(timer)
		  }, [text])

		  // 气泡尺寸只在文案变化时量一次：每帧量气泡会把 rAF 变成回流风暴。
		  useEffect(() => {
		    if (!text) return
		    try {
		      const node = bubbleRef.current
		      if (!node) return
		      const w = node.offsetWidth
		      const h = node.offsetHeight
		      if (w > 0 && h > 0) {
		        setBubbleSize((prev) => (prev.w === w && prev.h === h ? prev : { w: w, h: h }))
		      }
		    } catch {
		      /* 量不到就先用估值，下一句再试 */
		    }
		  }, [text, anchor ? anchor.level : 0])

		  // 锚点容器始终渲染（0 尺寸也无所谓）：usePetAnchor 要先有这个节点才能判断
		  // 有没有 transform 祖先；气泡本体等第一次量到锚点再挂上去，避免闪一下左上角。
		  // 挂件被隐藏时（anchor.hidden）容器也不占位置、不画气泡：台词跟挂件同进同退。
		  const petGone = anchor ? anchor.hidden === true : false
		  const rect = anchor && !petGone ? anchor.rect : null
		  const viewport = petGone ? null : anchor ? anchor.viewport : null
		  const placement =
		    rect && viewport
		      ? core.planOverlay({
		          rect: rect,
		          viewport: viewport,
		          size: bubbleSize,
		          above: true,
		          offsetY: finiteOr(anchor.offsetY, PET_ANCHOR_OFFSET_Y),
		        })
		      : null
		  const origin = anchor && anchor.origin ? anchor.origin : { left: 0, top: 0 }
		  const scale = Math.max(0.5, finiteOr(anchor && anchor.scale, 1))
		  // 位置来自 getBoundingClientRect（视口坐标），所以默认 fixed；
		  // 祖先带 transform 时 fixed 会退化，这时改用 absolute 并减掉祖先原点。
		  const anchorStyle = {
		    position: anchor && anchor.position === 'absolute' ? 'absolute' : 'fixed',
		    left: (rect ? rect.left - origin.left : 0) + 'px',
		    top: (rect ? rect.top - origin.top : 0) + 'px',
		    width: (rect ? rect.width : 0) + 'px',
		    height: (rect ? rect.height : 0) + 'px',
		    // 气泡不许吃掉点击：它只是看的（连挂件本身都要能继续被拖动）。
		    pointerEvents: 'none',
		    zIndex: 60,
		  }
		  const bubbleStyle = Object.assign(
		    {
		      position: 'absolute',
		      // planOverlay：上方放不下自动翻到下方，横向越界推回视口内。
		      left: placement ? placement.left : '50%',
		      top: placement ? placement.top : '100%',
		      transform: placement ? placement.transform : 'translateX(-50%)',
		      // 用户实测（2026-10-24）：气泡每行只有 2–3 个汉字。
		      // 原因是本体 position:absolute + left:50% 且没写 width → 走 shrink-to-fit，
		      // 可用宽度被定位容器（= 立绘矩形，几十到一百多 px）卡死。
		      // 显式 max-content 让它先按文字自然宽度排，超过 maxWidth 才折行；
		      // border-box 保证 maxWidth 把 padding 也算进去，右边缘不被撑出视口。
		      width: 'max-content',
		      boxSizing: 'border-box',
		      // 窄窗口下 240*scale 仍可能比视口宽：再夹一道视口上限，避免左右被裁。
		      maxWidth:
		        (viewport ? Math.min(340, Math.round(240 * scale), Math.max(160, viewport.w - 16)) : Math.min(340, Math.round(240 * scale))) +
		        'px',
		      // 用户反馈：点挂件出来的气泡是蓝色大字，思考气泡是灰色小字，两只看着不像一个人。
		      // 所以这里直接照 dsh-pet 的气泡来：同一片蓝黑玻璃 + 亮字 + 深蓝描边微光。
		      fontSize: 14,
		      lineHeight: 1.55,
		      padding: '9px 14px',
		      borderRadius: 12,
		      whiteSpace: 'pre-wrap',
		      letterSpacing: '0.02em',
		      background: 'linear-gradient(160deg, rgba(19,28,54,0.94), rgba(7,11,26,0.96))',
		      color: '#f4f7ff',
		      border: '1px solid rgba(126,152,255,0.45)',
		      boxShadow:
		        '0 4px 12px rgba(2,6,23,0.35), inset 0 1px 0 rgba(226,232,255,0.12), 0 0 12px rgba(77,107,254,0.18)',
		    },
		    {},
		  )
		  return h(
		    'div',
		    { ref: containerRef, style: anchorStyle },
		    // 用户实测（2026-10-24）：台词 3.2 秒到期后气泡不卸载，立绘头顶永久留一个深色空壳。
		    // 只判 rect 不够——没文案就干脆不挂这个节点（节点不在，也就不可能留下 padding/边框/背景）。
		    // 注意别改成 display:none 那种"留着但不显示"：测量 effect 读 offsetWidth/offsetHeight，
		    // 隐藏但占位的节点还能量；这里的做法是"没文案时根本不渲染"，测量也在 !text 时提前 return。
		    rect && text
		      ? h(
		          'div',
		          {
		            ref: bubbleRef,
		            role: 'status',
		            'aria-live': 'polite',
		            style: bubbleStyle,
		          },
		          text,
		        )
		      : null,
		  )
		}

		// ── 插件详情页：两项默认值 + 那只鲸鱼娘是谁 ────────────────────
		//
		// 2026-10-22 决策变更之后，这一页要回答的是三个问题：
		//   1. 这两项各自是什么、默认值是什么、改了作用于谁（新会话 vs 本会话）；
		//   2. 右下角那只鲸鱼娘是谁画的、跟她什么关系（用户明确不接受"我们自己画一个"）；
		//   3. 万一没生效，去哪儿看为什么。
		//
		// 刻意不做的事：不给"挂件"开关（挂件已删）、不做"一键全开"（两项的代价不同，
		// 语气要花钱、中文思考不额外花钱，混在一起用户没法只关贵的那项）。
		/**
		 * 设置页的全部用户可见文案集中在这里。
		 *
		 * 为什么集中：用户报的「界面直接显示英文码」就是因为文案散在 catch 里、新错误码
		 * 没人补。集中成一个表之后，测试可以逐码断言（含 bad-flags 这种以前漏掉的）。
		 */
		const COPY = {
		  sections: {
		    identity: '她是谁',
		    diary: '日记本',
		    schedule: '什么时候写',
		    diarist: '谁来写',
		    today: '今天',
		    recent: '最近写过的',
		    doc: '记录文档是什么',
		    help: '出问题了怎么办',
		  },
		  problem: {
		    'write-failed': '文件没写进去（磁盘满了或没有权限）',
		    'bad-dir': '选中的不是一个能用的文件夹',
		    'dir-move-failed': '换文件夹没成功，我已经把你原来的设置改回去了',
		    'pointer-write-failed': '设置存不进插件数据目录（可能是磁盘满或权限问题）',
		    'bad-time': '时间格式不对（见下面红字）',
		    'bad-flags': '这次提交的字段不被接受（内部错误，刷新页面再试）',
		    disabled: '日记还关着，先在「什么时候写」里打开',
		    'no-dir': '日记本文件夹不见了，先去上面第 2 区处理',
		    'empty-day': '今天没有能写的内容（还没聊过天）',
		    'no-diarist': '今天没有能用的执笔；换一个 DeepSeek 模型或选「自动」',
		    'unsupported-diarist': '执笔只支持 DeepSeek 模型；换一个 DeepSeek 模型或选「自动」',
		    'no-subagents': '这台机器现在起不了写作进程，重启 App 再试',
		    'no-parent': '这台机器现在起不了写作进程，重启 App 再试',
		    timeout: '她写了但没写完（超时），可以再试一次',
		    'bad-body': '写出来的东西不合格，没存盘',
		    busy: '上一篇还在写，等它写完',
		    cancelled: '取消了，这次没写',
		    'no-picker': '这个宿主没有目录选择器，手动填路径吧',
		    'recover-failed': '认回了日记本，但这轮没写回去，点「重新读取」再试一次',
		    internal: '内部出错了，把 code 告诉我就行',
		  },
		  status: {
		    off: '日记关着',
		    writing: '她正在写今天的日记…',
		    written: '今天写过了',
		    willWrite: '她今天还没写',
		    empty: '今天没有可写内容（还没聊过天）',
		    missing: '日记本文件夹找不到了，等她写之前要先处理',
		    noMore: '前不会再写',
		    at: '会写',
		    failedScan: '今天的内容没统计出来',
		  },
		  s1: {
		    title: '上次用的日记本文件夹找不到了：',
		    body: '可能是你把它改名、挪走或删了。你选一个：',
		    pick: '① 点「更换文件夹」，重新指一个地方（原来的日记我不动）；',
		    rebuild: '② 点「重新建一个」，我在原来的位置新建一个空文件夹，接着往里写。',
		    pickButton: '更换文件夹',
		    rebuildButton: '重新建一个',
		    found: '已找到日记本：',
		    noDir: '还没有指定位置，先点「更换文件夹」选一个。',
		  },
		  s2: {
		    hint: '这个时间看不懂。要写成 21:00 这样——几点:几分，24 小时制（晚上 9 点 = 21:00）。',
		    saved: '时间已保存：',
		  },
		  s3: {
		    hint: '她正在写，一般 20–60 秒，最多等 2 分钟。你可以先离开这一页——写完会出现在「最近写过的」里。',
		  },
		  s4: {
		    retry: '再试一次',
		    docLink: '看记录文档的「四、最近一次没写成」',
		  },
		  recovered: {
		    text: '日记本被改名了，已自动认回：',
		    rename: '也就是你给文件夹改的新名字，我认出来了。原来那个位置是 ',
		    stillThere: '日记都还在，接着往下写就行。',
		    reject: '不是我那个',
		    know: '知道了',
		    persisted: '我改回来了，但没能把这件事记进记录文档（文件可能被别的程序占着）。下次打开这一页我再试一次。',
		    dirMarkerHint: '这个文件夹里我没能留下身份标记。以后你要是给它改名字，可能需要手动选一次。',
		    suggestion: '顺便说一句：我在旁边的文件夹里找到一个像日记本的地方：',
		    useIt: '用它',
		    hint: '不是你原来那个？选一个地方，或在原来的位置重新建一个。',
		  },
		  doc: {
		    intro:
		      '这份文件就是日记的全部设置和记录。你手改「一、设置」保存，再点上面的「重新读取」就生效；下面几段是她自己写的，改了会被覆盖。',
		    missing: '记录文档还没建立，等她第一次写日记时会自动建；现在也可以点「重新读取」试试。',
		    open: '打开记录文档',
		    reload: '重新读取',
		    reloadHint: '改完记录文档记得点这里',
		    migrated: '已把旧版日记设置迁移进记录文档（迁移了 ',
		    migratedTail: ' 天的记录）。',
		  },
		}

		/** 出厂配置：读记录文档失败时也用这份把界面画出来，不让页面白等。 */
		const FACTORY_DIARY_CONFIG = {
		  enabled: false,
		  dir: '',
		  dirState: 'none',
		  dirMessage: '还没选日记本文件夹',
		  time: '21:00',
		  timeValid: true,
		  diarist: '',
		  autoCreate: true,
		}

		// ── 版式常量（2026-10-24 用户要求「改的精致一点」）──────────────────
		//
		// 只统一样子，不动业务逻辑。以前每张卡、每行、每个按钮都各写一套魔法数字，
		// 结果同一页里卡片间距有 8/10/12 三种、按钮 padding 有 3 套、圆角 6/8/10 混用，
		// 看上去就是「拼起来的」。这里收成一组常量，新写的样式一律引用它们。
		//
		// 改之前先看一眼测试：build-output.test.mjs 里钉住了这几个数字本身
		// （CARD_GAP / ROW_GAP / RADIUS / BTN_HEIGHT），别只改一边。
		const CARD_GAP = 12 // 卡片之间
		const ROW_GAP = 8 // 一行之内（文字与控件、按钮与按钮）
		const FONT_TITLE = 13 // 卡片内的小标题、状态一句话
		const FONT_SM = 12 // 正文、按钮
		const FONT_XS = 11 // 说明、注释、码表
		const RADIUS = 8 // 卡片/输入框/按钮统一圆角

		// 共用原语（src/ui.mjs）：色板、字号三档、间距四档、圆角四档、十个组件。
		// 新写的界面一律从这里取，不要再手写字面量颜色。
		// 只造一次：主题（深/浅）在页面生命周期内不会变，每帧重算色板是白花钱。
		const UI = makePrimitives(h)
		const BTN_HEIGHT = 28 // 按钮统一高度（同高才排得整齐，不靠 padding 撑）

		const UI_MUTED = { color: 'var(--dsw-alias-label-secondary, rgba(255,255,255,0.6))' }
		const UI_MONO = {
		  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
		  fontSize: 11,
		  wordBreak: 'break-all',
		  userSelect: 'text',
		}
		const UI_FIELD = {
		  padding: '4px 8px',
		  fontSize: FONT_SM,
		  color: 'var(--dsw-alias-label-primary, #fff)',
		  background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.06))',
		  border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12))',
		  borderRadius: RADIUS,
		  fontFamily: 'inherit',
		}
		// 全站只有这一种按钮：同高 28、同圆角、同字号。以前每处自己写 padding，
		// 于是「+1」「写成这个数」「打开挂件」三种高度并排，看着就不齐。
		const UI_BUTTON = {
		  display: 'inline-flex',
		  alignItems: 'center',
		  justifyContent: 'center',
		  boxSizing: 'border-box',
		  height: BTN_HEIGHT,
		  padding: '0 10px',
		  fontSize: FONT_SM,
		  lineHeight: 1,
		  color: 'var(--dsw-alias-label-primary, #fff)',
		  background: 'transparent',
		  border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.2))',
		  borderRadius: RADIUS,
		  cursor: 'pointer',
		  fontFamily: 'inherit',
		}
		const UI_LINK = { color: CARD_ACCENT.deepseek, textDecoration: 'none', cursor: 'pointer', fontSize: FONT_SM }

		/**
		 * 错误码 → 一句白话（与 docs/重做方案.md §a.8 的码表一一对应）。
		 *
		 * 没命中的码不再只显示英文：退回 internal 的说明，并把码贴在括号里，用户至少
		 * 能把它复制给开发者；宿主给的 reason/detail 也一并带上。
		 */
		// 超时是最容易被写错的一句话：写日记超时是「写了一半」，读设置/统计超时只是「等太久」，
		// 混用会让用户以为日记已经写了一部分（体感审 F3）。所以按调用场景分文案。
		const TIMEOUT_COPY = {
		  read: '读设置超时了，刷新页面再试一次',
		  save: '保存超时了，刷新页面看看改没改上',
		  stats: '统计有点慢，点「刷新统计」再试一次',
		  pick: '选文件夹等太久了（可能对话框被挡住了），再试一次',
		  reload: '读记录文档超时了，再点一次「重新读取」试试',
		  write: '她写了但没写完（超时），可以再试一次',
		}

		/** 保存成功提示贴到哪一区：由 patch 的键推断（时间/执笔/日记本/其它都算「什么时候写」）。 */
		const RECOVER_DISMISS_KEY = 'ai-waifu-recover-dismissed'

		/** 记住「知道了」过哪一次认回（按 dirRecovered.at 去重）；读不到就当作没记过。 */
		function readRecoverDismissed() {
		  try {
		    const raw = window.localStorage && window.localStorage.getItem(RECOVER_DISMISS_KEY)
		    return typeof raw === 'string' ? raw : ''
		  } catch {
		    return ''
		  }
		}

		function rememberRecoverDismissed(at) {
		  try {
		    if (window.localStorage && at) window.localStorage.setItem(RECOVER_DISMISS_KEY, String(at))
		  } catch {
		    /* 隐私模式/存储满了：这次照常收起，下次再提示一遍即可 */
		  }
		}

		function whereFromPatch(patch) {
		  if (!patch || typeof patch !== 'object') return 'schedule'
		  if (Object.prototype.hasOwnProperty.call(patch, 'time')) return 'time'
		  if (Object.prototype.hasOwnProperty.call(patch, 'diarist')) return 'diarist'
		  if (Object.prototype.hasOwnProperty.call(patch, 'dir')) return 'dir'
		  return 'schedule'
		}

		function explain(error, scene) {
		  const code = String((error && error.message) || error || '').trim()
		  const detail =
		    error && typeof error.detail === 'string'
		      ? error.detail
		      : error && typeof error.reason === 'string'
		        ? error.reason
		        : ''
		  if (code === 'timeout' && scene && TIMEOUT_COPY[scene]) {
		    return TIMEOUT_COPY[scene] + '（timeout）'
		  }
		  const text = COPY.problem[code]
		  if (text) return text + '（' + code + '）' + (detail ? '：' + detail : '')
		  return COPY.problem.internal + '（' + (code || 'unknown') + '）' + (detail ? '：' + detail : '')
		}

		/** 截断摘要：记录文档只存前 60 字，这里再兜一层，防止手改出来的长行撑爆版面。 */
		function truncateText(text, max) {
		  const value = typeof text === 'string' ? text : ''
		  if (value.length <= max) return value
		  return value.slice(0, max) + '…'
		}

		/** 状态卡的一句话 + 颜色。纯函数（测试可断言：四种状态不许互相盖住）。 */
		function summaryOf(config, today, busy, hasProblem) {
		  const c = config || FACTORY_DIARY_CONFIG
		  const t = today || null
		  const b = busy || {}
		  if (hasProblem === true) return { tone: 'fail', text: '上次没写成，看下面「今天」那一区' }
		  if (c.enabled !== true) return { tone: 'warn', text: COPY.status.off }
		  if (b.writing === true) return { tone: 'warn', text: COPY.status.writing }
		  if (c.dirState === 'missing') return { tone: 'warn', text: COPY.status.missing }
		  if (c.timeValid === false) return { tone: 'warn', text: '「每天几点写」的时间不对，去第 3 区改一下' }
		  if (t && t.written === true) {
		    return { tone: 'ok', text: COPY.status.written + (c.time ? '，' + c.time + ' ' + COPY.status.noMore : '') }
		  }
		  if (t && t.empty === true) return { tone: 'warn', text: COPY.status.empty }
		  if (t && t.state === 'failed') {
		    return { tone: 'warn', text: COPY.status.failedScan + '：' + (t.failedReason || '点「刷新统计」再试一次') }
		  }
		  return { tone: 'ok', text: COPY.status.willWrite + (c.time ? '，' + c.time + ' ' + COPY.status.at : '') }
		}

		function formatStamp(iso) {
		  if (typeof iso !== 'string' || !iso) return ''
		  const match = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2})/.exec(iso)
		  return match ? match[1] + ' ' + match[2] : iso
		}

		/** 窄屏（<520px）时控件换行：只在挂载/resize 时读一次 window.innerWidth。 */
		function useNarrow() {
		  const [narrow, setNarrow] = useState(false)
		  useEffect(() => {
		    const read = () => {
		      try {
		        setNarrow(typeof window !== 'undefined' && window.innerWidth < 520)
		      } catch {
		        /* 读不到就按宽屏排版 */
		      }
		    }
		    read()
		    try {
		      window.addEventListener('resize', read)
		    } catch {
		      /* 没有 window：不监听 */
		    }
		    return () => {
		      try {
		        window.removeEventListener('resize', read)
		      } catch {
		        /* 同上 */
		      }
		    }
		  }, [])
		  return narrow
		}

		function actionButton(label, onClick, options) {
		  const opts = options && typeof options === 'object' ? options : {}
		  return h(
		    'button',
		    {
		      type: 'button',
		      onClick: onClick,
		      disabled: opts.disabled === true,
		      title: opts.title,
		      'aria-label': opts.ariaLabel || undefined,
		      style: Object.assign({}, UI_BUTTON, opts.style, opts.disabled === true ? { cursor: 'default', opacity: 0.6 } : {}),
		    },
		    label,
		  )
		}

		function StatusDot(props) {
		  const tone = props && props.tone
		  const color =
		    tone === 'fail' ? 'var(--dsw-alias-label-error, #ff6b6b)' : tone === 'warn' ? '#d6a210' : '#2fb344'
		  return h('span', {
		    'aria-hidden': 'true',
		    style: { width: 8, height: 8, borderRadius: '50%', background: color, flex: 'none', display: 'inline-block' },
		  })
		}

		/** 一行 = 左（标题 + 说明）＋ 右（控件）；窄屏时控件换到下一行。 */
		function DiaryRow(props) {
		  const narrow = props.narrow === true
		  return h(
		    'div',
		    {
		      style: {
		        display: 'flex',
		        flexDirection: narrow ? 'column' : 'row',
		        alignItems: narrow ? 'stretch' : 'flex-start',
		        justifyContent: 'space-between',
		        gap: narrow ? ROW_GAP : 16,
		        padding: '10px 0',
		        borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08))',
		      },
		    },
		    h(
		      'div',
		      { style: { minWidth: 0, flex: '1 1 auto' } },
		      h('div', { style: { fontSize: FONT_TITLE, color: 'var(--dsw-alias-label-primary, #fff)' } }, props.title),
		      props.hint
		        ? h('div', { style: Object.assign({ marginTop: 2, fontSize: FONT_XS, lineHeight: 1.5 }, UI_MUTED) }, props.hint)
		        : null,
		      props.children || null,
		    ),
		    h(
		      'div',
		      {
		        style: {
		          flex: 'none',
		          display: 'flex',
		          alignItems: 'center',
		          gap: ROW_GAP,
		          flexWrap: 'wrap',
		          alignSelf: narrow ? 'flex-start' : 'auto',
		        },
		      },
		      props.control,
		    ),
		  )
		}

		/** 分区卡片：用户要的是「分区排版」，不是一串没有层次的行。 */
		function DiaryCard(props) {
		  // 走共用原语（src/ui.mjs）。DOM 仍是 section + 可选标题 div，
		  // 但内边距/圆角/边框粗细统一由标度给，不再每个卡片自己写一遍。
		  return UI.Card({ title: props && props.title, children: props && props.children })
		}

		function DiaryStatusCard(props) {
		  return h(
		    'div',
		    {
		      role: 'status',
		      'aria-live': 'polite',
		      style: {
		        marginTop: ROW_GAP,
		        padding: '10px ' + CARD_GAP + 'px',
		        borderRadius: RADIUS,
		        border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))',
		        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.04))',
		        display: 'flex',
		        alignItems: 'center',
		        justifyContent: 'space-between',
		        gap: CARD_GAP,
		      },
		    },
		    h('div', { style: { fontSize: FONT_TITLE, minWidth: 0 } }, props.text),
		    h(StatusDot, { tone: props.tone }),
		  )
		}

		/**
		 * 日记快照：首屏**只发一次** GET /diary。
		 *
		 * 断掉的旧行为：挂载时并发打 /diary 与 /diary?today=1，后者要解压全部会话日志
		 * （实测冷 2.14 秒），用户看到的就是「日记配置加载慢」。现在今日统计、最近日记
		 * 全部来自记录文档快照；只有「正在写」时按 3 秒轮询一次状态。
		 */
		function useDiarySnapshot() {
		  const [snap, setSnap] = useState(null)
		  const [problem, setProblem] = useState('')
		  const [reading, setReading] = useState(true)
		  const aliveRef = useRef(true)
		  const apply = useCallback((value) => {
		    if (!aliveRef.current) return
		    if (value && typeof value === 'object') setSnap(value)
		  }, [])
		  const reload = useCallback(() => {
		    setReading(true)
		    return bridgeRequest('/diary')
		      .then((value) => {
		        apply(value)
		        if (aliveRef.current) setProblem('')
		      })
		      .catch((error) => {
		        if (aliveRef.current) setProblem(explain(error, 'read'))
		      })
		      .then(() => {
		        if (aliveRef.current) setReading(false)
		      })
		  }, [apply])
		  useEffect(() => {
		    aliveRef.current = true
		    reload()
		    return () => {
		      aliveRef.current = false
		    }
		  }, [reload])
		  const writing = !!(snap && snap.busy && snap.busy.writing === true)
		  useEffect(() => {
		    if (!writing) return undefined
		    // 后台标签页不轮询（体感审 F9）：隐藏时跳过本轮，回前台且还在写就补一次。
		    const tick = () => {
		      if (typeof document !== 'undefined' && document.hidden) return
		      bridgeRequest('/diary')
		        .then(apply)
		        .catch(() => {
		          /* 轮询失败静默：下面还有「刷新统计」按钮可以手动拉 */
		        })
		    }
		    const timer = setInterval(tick, 3000)
		    const onVisible = () => {
		      if (typeof document !== 'undefined' && document.hidden) return
		      tick()
		    }
		    try {
		      document.addEventListener('visibilitychange', onVisible)
		    } catch {
		      /* 没有 document：只靠定时器 */
		    }
		    return () => {
		      clearInterval(timer)
		      try {
		        document.removeEventListener('visibilitychange', onVisible)
		      } catch {
		        /* 同上 */
		      }
		    }
		  }, [writing, apply])
		  return { snap: snap, problem: problem, reading: reading, reload: reload, apply: apply, setSnap: setSnap }
		}

		function DiaryDirCard(props) {
		  const config = props.config
		  const doc = props.doc
		  const narrow = props.narrow
		  const busy = props.action
		  const dir = config.dir || ''
		  const docPath = doc && typeof doc.path === 'string' ? doc.path : dir ? dir + '/AI娘日记记录.md' : ''
		  const docMeta = []
		  if (doc && doc.exists === true) {
		    if (typeof doc.size === 'number') docMeta.push(doc.size + ' 字节')
		    if (typeof doc.mtime === 'string') docMeta.push('最后更新 ' + formatStamp(doc.mtime))
		  }
		  const warnings = doc && Array.isArray(doc.warnings) ? doc.warnings.slice(0, 5) : []
		  const migrated = props.migrated
		  return h(
		    DiaryCard,
		    { title: COPY.sections.diary },
		    h(
		      DiaryRow,
		      {
		        narrow: narrow,
		        title: '日记本文件夹',
		        hint: '她的日记写在这个文件夹里；记录文档也在里面。路径只读，改位置用右边的按钮。',
		        control: [
		          actionButton(busy === 'pick' ? '选着…' : dir ? '更改文件夹' : '选文件夹', props.onPick, {
		            key: 'pick',
		            disabled: busy === 'pick',
		            title: '打开系统目录选择框（原来文件夹里的日记不会被删）',
		          }),
		          actionButton(busy === 'rebuild' ? '正在建…' : '重新建一个', props.onRebuild, {
		            key: 'rebuild',
		            disabled: busy === 'rebuild' || !dir,
		            title: dir ? '在原来的位置新建一个空文件夹，接着往里写' : '先选一个位置',
		          }),
		        ],
		        children: [
		          h(
		            'div',
		            { key: 'dir', style: Object.assign({ marginTop: 4 }, UI_MONO) },
		            dir || '（还没选）',
		          ),
		          h(
		            'div',
		            { key: 'state', style: Object.assign({ marginTop: 2, fontSize: 11, lineHeight: 1.5 }, UI_MUTED) },
		            config.dirMessage || (config.dirState === 'missing' ? '这个文件夹找不到了' : ''),
		          ),
		          migrated
		            ? h(
		                'div',
		                { key: 'migrated', style: { marginTop: 2, fontSize: 11, color: CARD_ACCENT.deepseek } },
		                COPY.doc.migrated + String(migrated.writtenDates || 0) + COPY.doc.migratedTail,
		              )
		            : null,
		          props.noteDir
		            ? h('div', { key: 'note-dir', role: 'status', style: { marginTop: 4, fontSize: 11, color: '#2fb344' } }, props.noteDir)
		            : null,
		          // 身份标记缺失只是一件静默的小事（docs §c S1a 末条）：一行灰字，不报警。
		          props.dirMarker && props.dirMarker !== 'present'
		            ? h(
		                'div',
		                { key: 'marker', style: Object.assign({ marginTop: 4, fontSize: 11, lineHeight: 1.5 }, UI_MUTED) },
		                COPY.recovered.dirMarkerHint,
		              )
		            : null,
		        ],
		      },
		    ),
		    h(
		      DiaryRow,
		      {
		        narrow: narrow,
		        title: '记录文档',
		        hint: '她的全部设置和记录就在这一份文件里。手改「一、设置」后点「重新读取」生效。',
		        control: [
		          docPath
		            ? h(
		                'a',
		                {
		                  key: 'open',
		                  href: 'file://' + docPath,
		                  target: '_blank',
		                  rel: 'noreferrer',
		                  style: UI_LINK,
		                  title: docPath,
		                },
		                COPY.doc.open,
		              )
		            : null,
		          actionButton(busy === 'reload' ? '读取中…' : COPY.doc.reload, props.onReload, {
		            key: 'reload',
		            disabled: busy === 'reload',
		          }),
		        ],
		        children: [
		          h(
		            'div',
		            { key: 'path', style: Object.assign({ marginTop: 4 }, UI_MONO) },
		            docPath || COPY.doc.missing,
		          ),
		          docMeta.length
		            ? h('div', { key: 'meta', style: Object.assign({ marginTop: 2, fontSize: 11 }, UI_MUTED) }, docMeta.join(' · '))
		            : null,
		          warnings.length
		            ? h(
		                'div',
		                { key: 'warnings', style: Object.assign({ marginTop: 2, fontSize: 11, lineHeight: 1.5 }, UI_MUTED) },
		                warnings.join('；'),
		              )
		            : null,
		          props.noteDoc
		            ? h('div', { key: 'note-doc', role: 'status', style: { marginTop: 4, fontSize: 11, color: '#2fb344' } }, props.noteDoc)
		            : null,
		        ],
		      },
		    ),
		  )
		}

		function DiaryTimeRow(props) {
		  const config = props.config
		  const [draft, setDraft] = useState(config.time || '21:00')
		  const [bad, setBad] = useState(config.timeValid === false)
		  const timerRef = useRef(0)
		  const editingRef = useRef(false)

		  useEffect(() => {
		    // 正在写日记时面板每 3 秒刷一次快照；用户正在改时间输入框时不能拿旧值把
		    // 半截输入顶掉（那是"打字打一半自己变回去"的经典 bug）。
		    if (editingRef.current) return
		    setDraft(config.time || '21:00')
		    setBad(config.timeValid === false)
		  }, [config.time, config.timeValid])
		  useEffect(
		    () => () => {
		      clearTimeout(timerRef.current)
		    },
		    [],
		  )

		  const onBlur = () => {
		    const normalized = normalizeTimeInput(draft)
		    if (!normalized) {
		      // 看不懂就不发请求：回填上次的合法值，红字留 4 秒。
		      editingRef.current = false
		      setBad(true)
		      setDraft(config.time || '21:00')
		      clearTimeout(timerRef.current)
		      timerRef.current = setTimeout(() => setBad(false), 4000)
		      return
		    }
		    editingRef.current = false
		    setBad(false)
		    setDraft(normalized)
		    if (normalized === (config.time || '')) return
		    props.onSave({ time: normalized }, COPY.s2.saved + normalized)
		  }

		  return h(DiaryRow, {
		    narrow: props.narrow,
		    title: '每天几点写',
		    hint: '24 小时制，写成 21:00 这样。到点她才会写；改完失焦即保存。',
		    control: h('input', {
		      type: 'text',
		      value: draft,
		      'aria-label': '每天几点写',
		      'aria-invalid': bad ? 'true' : 'false',
		      onChange: (event) => {
		        editingRef.current = true
		        setDraft(String((event.target && event.target.value) || ''))
		      },
		      onBlur: onBlur,
		      style: Object.assign({ width: 86, textAlign: 'center' }, UI_FIELD, bad
		        ? { borderColor: 'var(--dsw-alias-label-error, #ff6b6b)' }
		        : {}),
		    }),
		    children: [
		      bad
		        ? h(
		            'div',
		            { key: 'bad', style: { marginTop: 4, fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-error, #ff6b6b)' } },
		            COPY.s2.hint,
		          )
		        : null,
		      props.note
		        ? h('div', { key: 'note', role: 'status', style: { marginTop: 4, fontSize: 11, color: '#2fb344' } }, props.note)
		        : null,
		    ],
		  })
		}

		function DiaryScheduleCard(props) {
		  const config = props.config
		  return h(
		    DiaryCard,
		    { title: COPY.sections.schedule },
		    h(DiaryRow, {
		      narrow: props.narrow,
		      title: '打开日记',
		      // 还没读到配置时不能说「现在关着」——那是断言，会跟状态卡的「正在读设置…」打架（体感审 L1）。
		      hint: props.reading
		        ? '正在读取你的设置…'
		        : config.enabled
		          ? '开着，到点会自己写'
		          : '现在关着（关着不会写，也不花任何 token）',
		      control: h(MiniToggle, {
		        on: config.enabled === true,
		        accent: CARD_ACCENT.deepseek,
		        label: config.enabled === true ? '开' : '关',
		        showState: false,
		        title: config.enabled ? '点一下关掉' : '点一下打开',
		        onClick: props.onToggleEnabled,
		      }),
		    }),
		    h(DiaryTimeRow, { config: config, narrow: props.narrow, onSave: props.onSave, note: props.noteTime }),
		    props.note
		      ? h('div', { role: 'status', style: { padding: '6px 0', fontSize: 11, color: '#2fb344' } }, props.note)
		      : null,
		    h(DiaryRow, {
		      narrow: props.narrow,
		      title: '自动新建本子',
		      hint: '到点时文件夹不在了，就自动建一个空文件夹继续写（不会删你原来的东西）。',
		      control: h(MiniToggle, {
		        on: config.autoCreate !== false,
		        accent: CARD_ACCENT.deepseek,
		        label: config.autoCreate !== false ? '开' : '关',
		        showState: false,
		        title: '自动新建本子：' + (config.autoCreate !== false ? '开' : '关') + '（点一下切换）',
		        onClick: props.onToggleAutoCreate,
		      }),
		    }),
		  )
		}

		function DiaryDiaristCard(props) {
		  const config = props.config
		  const today = props.today
		  const top = today && Array.isArray(today.topUsage) ? today.topUsage : []
		  const keys = []
		  for (let i = 0; i < top.length; i += 1) {
		    const key = top[i] && typeof top[i].key === 'string' ? top[i].key : ''
		    if (key && keys.indexOf(key) === -1) keys.push(key)
		  }
		  if (config.diarist && keys.indexOf(config.diarist) === -1) keys.push(config.diarist)
		  // 「自动」= 空字符串，由宿主挑一个 DeepSeek 模型。用户老问「自动到底用谁的 key」，
		  // 所以显示文字里直接写明：用你登录的这个 DeepSeek 账号。
		  const autoLabel = '自动（用 DeepSeek 账号的 API）'
		  const options = [h('option', { key: 'auto', value: '' }, autoLabel)].concat(
		    keys.map((key) => h('option', { key: key, value: key }, key)),
		  )
		  // topUsage 为空时只有「自动」一项，也要正常画出来（不要空下拉）。
		  const hint =
		    (today && today.diarist && today.diarist.key
		      ? '今天会是 ' + today.diarist.key + '；'
		      : '今天还没有可用的执笔（聊过天并统计之后才出现）；') +
		    '只支持 DeepSeek 系模型；选「自动」就用你登录的这个 DeepSeek 账号。'
		  return h(DiaryCard, { title: COPY.sections.diarist }, h(DiaryRow, {
		    narrow: props.narrow,
		    title: '谁来写',
		    hint: hint,
		    control: h(
		      'select',
		      {
		        value: config.diarist || '',
		        'aria-label': '谁来写',
		        onChange: (event) => props.onSave({ diarist: String((event.target && event.target.value) || '') }, '执笔已保存'),
		        style: Object.assign({ maxWidth: 260 }, UI_FIELD),
		      },
		      options,
		    ),
		    children: props.note
		      ? h('div', { role: 'status', style: { marginTop: 4, fontSize: 11, color: '#2fb344' } }, props.note)
		      : null,
		  }))
		}

		function DiaryTodayCard(props) {
		  const today = props.today
		  const busy = props.busy || {}
		  const writing = props.writing === true
		  const stats = today
		    ? today.state === 'scanning'
		      ? '正在统计今天的对话…'
		      : (today.sessions || 0) +
		        ' 段对话 · ' +
		        (today.kept || 0) +
		        ' 条可用 · ' +
		        (today.outputTokens || 0) +
		        ' 字' +
		        (today.diarist && today.diarist.key ? ' · 执笔 ' + today.diarist.key : '')
		    : '还没有统计过；点「刷新统计」现在算一次'
		  const scanned = today && today.scannedAt ? '统计于 ' + formatStamp(today.scannedAt) + (today.stale ? '（可能过期了）' : '') : ''
		  const failure = props.failure
		  // 白话优先：宿主写进文档的 reason 常是技术串（EACCES/ENOENT…），
		  // 直接摆给人看等于没翻译（体感审 F8）。技术细节降级到 title + 折叠区。
		  const failurePlain = failure
		    ? COPY.problem[failure.code] || failure.message || failure.reason || '上次没写成'
		    : ''
		  const failureTech = failure
		    ? [failure.reason, failure.detail, failure.message]
		        .filter((part) => typeof part === 'string' && part && part !== failurePlain)
		        .join(' · ')
		    : ''
		  const failureLine = failure
		    ? failurePlain +
		      '（' +
		      String(failure.code || 'unknown') +
		      '）' +
		      (failure.at ? ' · ' + failure.at : '')
		    : ''
		  return h(
		    DiaryCard,
		    { title: COPY.sections.today },
		    h(DiaryRow, {
		      narrow: props.narrow,
		      title: '今天',
		      hint: stats,
		      control: actionButton(props.refreshing ? '统计中…' : '刷新统计', props.onRefresh, {
		        disabled: props.refreshing === true,
		        title: '只在你点的时候才重新统计，不会拖慢页面',
		      }),
		      children: [scanned ? h('div', { key: 'scan', style: Object.assign({ marginTop: 2, fontSize: 11 }, UI_MUTED) }, scanned) : null],
		    }),
		    h(DiaryRow, {
		      narrow: props.narrow,
		      title: '现在就写一篇',
		      hint: props.writeDisabledReason || (today && today.empty ? '今天没有可写内容' : '写一篇要花 20–90 秒，也花一点 token；只写今天，不碰工具输出。'),
		      control: actionButton(writing ? '正在写…' : '现在就写', props.onWrite, {
		        disabled: props.writeDisabled === true,
		        title: props.writeDisabled ? props.writeDisabledReason : '让执笔现在写一篇',
		        style: writing ? { cursor: 'default' } : undefined,
		      }),
		      children: [
		        writing
		          ? h(
		              'div',
		              { key: 'writing', style: Object.assign({ marginTop: 4, fontSize: 11, lineHeight: 1.5 }, UI_MUTED) },
		              COPY.s3.hint,
		            )
		          : null,
		        props.note
		          ? h('div', { key: 'note-today', role: 'status', style: { marginTop: 4, fontSize: 11, color: '#2fb344' } }, props.note)
		          : null,
		        props.todayProblem
		          ? h(
		              'div',
		              { key: 'tp', style: { marginTop: 4, fontSize: 11, color: 'var(--dsw-alias-label-error, #ff6b6b)' } },
		              props.todayProblem,
		            )
		          : null,
		        // 后台补统计两次都没成：不冒充「已经统计好」，也不弹错，只留一行灰字说明能手动再来。
		        props.statsQuiet
		          ? h(
		              'div',
		              { key: 'sq', role: 'status', style: Object.assign({ marginTop: 4, fontSize: 11, lineHeight: 1.5 }, UI_MUTED) },
		              props.statsQuiet,
		            )
		          : null,
		        failure || props.problem
		          ? h(
		              'div',
		              {
		                key: 'fail',
		                title: failureTech || undefined,
		                style: { marginTop: 6, fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-error, #ff6b6b)' },
		              },
		              props.problem || failureLine,
		            )
		          : null,
		        failure && failureTech
		          ? h(
		              'details',
		              { key: 'fail-detail', style: { marginTop: 2, fontSize: 11, lineHeight: 1.5 } },
		              h('summary', { style: Object.assign({ cursor: 'pointer' }, UI_MUTED) }, '技术细节'),
		              h('div', { style: Object.assign({ paddingTop: 2 }, UI_MUTED) }, failureTech),
		            )
		          : null,
		        failure || props.problem
		          ? h(
		              'div',
		              { key: 'retry', style: { marginTop: 6, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
		              actionButton(COPY.s4.retry, props.onRetry, { disabled: props.actionBusy === true }),
		              props.docPath
		                ? h(
		                    'a',
		                    { key: 'doc', href: 'file://' + props.docPath, target: '_blank', rel: 'noreferrer', style: Object.assign({ fontSize: 11 }, UI_MUTED) },
		                    COPY.s4.docLink,
		                  )
		                : h('span', { key: 'doc', style: Object.assign({ fontSize: 11 }, UI_MUTED) }, COPY.s4.docLink),
		            )
		          : null,
		      ],
		    }),
		  )
		}

		function DiaryRecentCard(props) {
		  const [openIndex, setOpenIndex] = useState(-1)
		  const recent = props.recent.length ? props.recent.slice(0, 5) : []
		  return h(
		    DiaryCard,
		    { title: COPY.sections.recent },
		    recent.length === 0
		      ? h('div', { style: Object.assign({ padding: '10px 0', fontSize: 12 }, UI_MUTED) }, '还没有写过。到点或者点「现在就写」之后，这里会出现最近几篇。')
		      : recent.map((row, index) =>
		          h(
		            'button',
		            {
		              key: (row && row.label ? row.label : 'row') + '-' + index,
		              type: 'button',
		              onClick: () => setOpenIndex(openIndex === index ? -1 : index),
		              style: {
		                display: 'block',
		                width: '100%',
		                textAlign: 'left',
		                padding: '8px 0',
		                borderTop: index === 0 ? '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08))' : 'none',
		                borderLeft: 'none',
		                borderRight: 'none',
		                borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.06))',
		                background: 'transparent',
		                color: 'inherit',
		                fontFamily: 'inherit',
		                cursor: 'pointer',
		              },
		            },
		            h(
		              'div',
		              { style: { display: 'flex', justifyContent: 'space-between', gap: 12 } },
		              h('span', { style: { fontSize: 12 } }, (row && row.label ? row.label : '?') + (row && row.missing ? '（文件不见了）' : '')),
		              h('span', { style: Object.assign({ fontSize: 11 }, UI_MUTED) }, (row && row.chars ? row.chars : 0) + ' 字'),
		            ),
		            row && row.summary
		              ? h(
		                  'div',
		                  { style: Object.assign({ marginTop: 2, fontSize: 11, lineHeight: 1.5 }, UI_MUTED) },
		                  truncateText(row.summary, 60),
		                )
		              : null,
		            openIndex === index
		              ? h(
		                  'div',
		                  { style: Object.assign({ marginTop: 3 }, UI_MONO) },
		                  row && row.file ? row.file : '（记录文档里没有路径）',
		                )
		              : null,
		          ),
		        ),
		  )
		}

		function DiaryDocCard(props) {
		  return h(DiaryCard, { title: COPY.sections.doc }, h('details', null, h('summary', { style: { cursor: 'pointer', fontSize: 12, padding: '8px 0' } }, '这份文件是干什么的'), h('div', { style: Object.assign({ fontSize: 11, lineHeight: 1.65, paddingBottom: 6 }, UI_MUTED) }, COPY.doc.intro)))
		}

		// ── 与挂件的联动：状态一行 + 亲密度 + 小鱼干（设置页最底部）──────────────
		//
		// 亲密度上限改成本地常量（2026-10-24 用户要求）：用户要求上限六位数；pet 自己允许
		// 更大（宿主 src/affinity-store.mjs 的 AFFINITY_MAX 还是 999999999），但界面上只放
		// 999999。宿主那批会同步改成 999999，测试里不再断言「两边相等」——那是并行任务，
		// 断言相等等于把自己的构建绑在别人的文件上，那边一动这边就红。
		const AFFINITY_MAX = 999999

		// 小鱼干上限：用户要求最多 999 个（跟 pet 那边对齐，宿主 POST 也按 999 校验）。
		const TREATS_MAX = 999

		// 亲密度这几个码的「人话」。为什么不并进 COPY.problem：那是日记的错误码表，
		// 会渲染在日记面板的错误对照表里；混进去等于让用户在日记帮助里看到挂件错误。
		const AFFINITY_PROBLEM = {
		  'no-pet': '还没装挂件，装好之后这里才能改',
		  'bad-points': '亲密度要填 0 到 ' + AFFINITY_MAX + ' 之间的整数',
		  'bad-body': '这边发过去的格式不对（内部错误，刷新页面再试）',
		  'reload-unavailable': '改不动：挂件现在没在重载状态，直接改文件会被它下一次保存盖掉。这次什么都没写入',
		  'verify-failed': '写进去了但回读对不上，已经还原成原来的数字',
		  'settings-unavailable': '这个版本的挂件没有对外提供这个能力',
		  'read-failed': '挂件的状态文件读不出来',
		}

		// 小鱼干的白话文案（错误码与亲密度那套同构，但文案不同，别共用一个表）。
		const TREATS_PROBLEM = {
		  'no-pet': '还没装挂件，装好之后这里才能改',
		  'bad-treats': '小鱼干填不下那么多：填 0 到挂件允许的上限之间的整数',
		  'bad-body': '这边发过去的格式不对（内部错误，刷新页面再试）',
		  'reload-unavailable': '改不动：挂件现在没在重载状态，直接改文件会被它下一次保存盖掉。这次什么都没写入',
		  'verify-failed': '写进去了但回读对不上，已经还原成原来的数字',
		  'settings-unavailable': '这个版本的挂件没有对外提供这个能力',
		  'read-failed': '挂件的状态文件读不出来',
		}

		// 输入框的公共处理：先把非数字剔掉再截断。不做这一步，用户粘一串「12a3」直接进
		// draft，提交时又得再校验一次，中间那帧显示 "12a3 / 999999" 很怪。
		// 正则里的反斜杠必须写双的：这一整段是塞进模板字符串的，写单反斜杠到产物里就变成
		// /D/g，非数字一个都剔不掉（实测：粘贴 12a34b56 会原样留下）。
		function digitsOnly(value, maxLength) {
		  return String(value == null ? '' : value)
		    .replace(/\D/g, '')
		    .slice(0, maxLength)
		}

		function clampInt(value, min, max) {
		  const n = Math.floor(Number(value))
		  if (!isFinite(n)) return min
		  if (n < min) return min
		  if (n > max) return max
		  return n
		}

		/**
		 * 小鱼干的**真实**上限。
		 *
		 * 为什么不直接用 999：999 是用户想要的口径，但挂件自己只允许囤它的 treats.max 个
		 * （默认 20，见 pet 的 defaultTreatConfig.maxTreats）。界面按 999 放行，
		 * 用户填完只会被挂件夹回 20——看着像"改了不生效"。所以以挂件报的数为准。
		 */
		function treatsCapOf(source) {
		  const reported = source && typeof source === 'object' && typeof source.max === 'number' ? source.max : NaN
		  return isFinite(reported) && reported > 0 ? clampInt(reported, 1, TREATS_MAX) : TREATS_MAX
		}

		/**
		 * 设置页最底部的「和挂件联动」卡。
		 *
		 * 用户原话（m00596）：「设置里面再加一个可以编辑的，就是修改 dsh-pet 亲密度的地方……
		 * 直接放在最下面的一个可折叠开关，默认关，用户想改自己开」。
		 * 三条硬规矩：① 在最底部；② 折叠且默认关；③ 不展开就一个请求都不发（零 IO）。
		 */
		function AffinityEditor() {
		  const narrow = useNarrow()
		  const [pet, setPet] = useState(null)
		  const [open, setOpen] = useState(false)
		  const [view, setView] = useState(null)
		  const [draft, setDraft] = useState('')
		  const [error, setError] = useState('')
		  const [notice, setNotice] = useState('')
		  const [busy, setBusy] = useState(false)
		  const [enabling, setEnabling] = useState(false)
		  // 小鱼干跟亲密度同一张卡、同一个开合开关（用户展开一次就把两样都看到）。
		  const [treats, setTreats] = useState(null)
		  const [treatsDraft, setTreatsDraft] = useState('')
		  const [treatsError, setTreatsError] = useState('')
		  const [treatsNotice, setTreatsNotice] = useState('')
		  const [treatsBusy, setTreatsBusy] = useState(false)

		  // 挂件在不在、开没开：挂载时悄悄问一次（很轻）。「没装」这件事不展开也该看见。
		  // GET /pet 现在还会顺带带 affinity 与 treats；展开时能省掉两个请求，拿不到再各自回退。
		  useEffect(() => {
		    let alive = true
		    bridgeRequest('/pet', null, { timeoutMs: 6000 })
		      .then((value) => {
		        if (!alive) return
		        setPet(value && typeof value === 'object' ? value : { installed: false, enabled: false })
		        // /pet 顺手带回来的两串数字先填上：点开「亲密度」时立刻能看见，
		        // 不用等第二个来回（原来这里是空着等 load()，而 load() 又只在
		        // 「/pet 没带数据」时才被叫——结果就是永远停在「正在读」）。
		        if (value && value.affinity && typeof value.affinity.points === 'number') {
		          const points = clampInt(value.affinity.points, 0, AFFINITY_MAX)
		          setView({ points: points })
		          setDraft(String(points))
		        }
		        if (value && value.treats && typeof value.treats.treats === 'number') {
		          const cap = treatsCapOf(value.treats)
		          const amount = clampInt(value.treats.treats, 0, cap)
		          setTreats({ treats: amount, max: cap })
		          setTreatsDraft(String(amount))
		        }
		      })
		      .catch(() => {
		        if (alive) setPet({ installed: false, enabled: false, unknown: true })
		      })
		    return () => {
		      alive = false
		    }
		  }, [])

		  // 小鱼干单读：/pet 里没带这一块时用（老版本挂件就是没有）。
		  const readTreats = () => {
		    bridgeRequest('/pet/treats', null, { timeoutMs: 6000 })
		      .then((value) => {
		        if (!value || typeof value !== 'object') return
		        if (typeof value.treats !== 'number') return
		        const cap = treatsCapOf(value)
		        const amount = clampInt(value.treats, 0, cap)
		        setTreats({ treats: amount, max: cap })
		        setTreatsDraft(String(amount))
		      })
		      .catch(() => {
		        /* 读不到小鱼干不影响亲密度：静默，下次展开再试 */
		      })
		  }

		  const load = () => {
		    setError('')
		    setNotice('')
		    // 优先吃 GET /pet 里现成的那份（同一份数据，少一个请求）；没有就按老路读 /pet/affinity。
		    if (pet && pet.affinity && typeof pet.affinity === 'object' && typeof pet.affinity.points === 'number') {
		      setView(pet.affinity)
		      setDraft(String(clampInt(pet.affinity.points, 0, AFFINITY_MAX)))
		    } else {
		      bridgeRequest('/pet/affinity', null, { timeoutMs: 6000 })
		        .then((value) => {
		          setView(value || null)
		          setDraft(value && typeof value.points === 'number' ? String(clampInt(value.points, 0, AFFINITY_MAX)) : '')
		        })
		        .catch((err) => {
		          const code = String((err && err.message) || 'read-failed')
		          setError(AFFINITY_PROBLEM[code] || AFFINITY_PROBLEM['read-failed'])
		        })
		    }
		    // 小鱼干：优先用 /pet 里带的，拿不到再单读一份。
		    if (pet && pet.treats && typeof pet.treats === 'object' && typeof pet.treats.treats === 'number') {
		      const cap = treatsCapOf(pet.treats)
		      const amount = clampInt(pet.treats.treats, 0, cap)
		      setTreats({ treats: amount, max: cap })
		      setTreatsDraft(String(amount))
		    } else {
		      readTreats()
		    }
		  }

		  const toggle = () => {
		    const next = !open
		    setOpen(next)
		    // 展开就读一次（默认关着时零请求，这是用户硬要求）。
		    // 这里**不能**写成「/pet 里带了数据就不读」：那种写法一旦 /pet 先回来，
		    // 点开就再也没人调 load()，界面永远停在「正在读」（2026-10-25 用户实测）。
		    // load() 内部优先吃 /pet 里现成的那份，所以不会多打一次网络。
		    if (next && (!view || !treats)) load()
		  }

		  const apply = (target) => {
		    if (busy) return
		    const suspect = typeof target === 'number' ? target : Number(String(draft).trim())
		    if (!Number.isFinite(suspect)) {
		      setError(AFFINITY_PROBLEM['bad-points'])
		      return
		    }
		    // 超限先在本地夹住再发请求：别让宿主收到 9999999 再回一个错。
		    let next = Math.round(suspect)
		    if (next < 0) next = 0
		    if (next > AFFINITY_MAX) next = AFFINITY_MAX
		    setBusy(true)
		    setError('')
		    setNotice('')
		    bridgeRequest('/pet/affinity', { points: next }, { timeoutMs: 12000 })
		      .then((value) => {
		        const applied = value && value.applied
		        const points = value && typeof value.points === 'number' ? value.points : next
		        setView(Object.assign({}, view || {}, { points: points }))
		        setDraft(String(points))
		        setNotice(
		          applied === 'pending-restart'
		            ? '已写入，重启 App 后生效（挂件这一版没开放热重载）'
		            : applied === 'reloaded'
		              ? '已改好，还顺手让她重载了一次，现在就是 ' + points + ' 了'
		              : '已改好，她那边现在就是 ' + points + ' 了',
		        )
		      })
		      .catch((err) => {
		        const code = String((err && err.message) || 'verify-failed')
		        setError(AFFINITY_PROBLEM[code] || '没改成：' + (err && err.detail ? err.detail : code))
		      })
		      .then(() => setBusy(false))
		  }

		  // 小鱼干写回：跟亲密度同构，只是码表与上限不同。
		  const applyTreats = (target) => {
		    if (busy || treatsBusy) return
		    const suspect = typeof target === 'number' ? target : Number(String(treatsDraft).trim())
		    if (!Number.isFinite(suspect)) {
		      setTreatsError(TREATS_PROBLEM['bad-treats'])
		      return
		    }
		    // 同样：超上限先在本地夹住，不发非法值。上限以挂件为准（它可能只让囤 20）。
		    const cap = treatsCapOf(treats)
		    let next = Math.round(suspect)
		    if (next < 0) next = 0
		    if (next > cap) next = cap
		    setTreatsBusy(true)
		    setTreatsError('')
		    setTreatsNotice('')
		    bridgeRequest('/pet/treats', { treats: next }, { timeoutMs: 12000 })
		      .then((value) => {
		        const amount = value && typeof value.treats === 'number' ? clampInt(value.treats, 0, cap) : next
		        setTreats({ treats: amount, max: cap })
		        setTreatsDraft(String(amount))
		        setTreatsNotice('已改好，她那边现在有 ' + amount + ' 条小鱼干')
		      })
		      .catch((err) => {
		        const code = String((err && err.message) || 'verify-failed')
		        setTreatsError(TREATS_PROBLEM[code] || '没改成：' + (err && err.detail ? err.detail : code))
		      })
		      .then(() => setTreatsBusy(false))
		  }

		  const openPet = () => {
		    if (enabling) return
		    setEnabling(true)
		    setError('')
		    bridgeRequest('/pet/enable', {}, { timeoutMs: 8000 })
		      .then((value) => {
		        setPet(Object.assign({}, pet, { installed: true, enabled: Boolean(value && value.enabled) }))
		        setNotice('挂件打开了，看看右下角')
		      })
		      .catch((err) => {
		        const code = String((err && err.message) || '')
		        setError(AFFINITY_PROBLEM[code] || '没打开成功：' + (err && err.detail ? err.detail : '再点一次试试'))
		      })
		      .then(() => setEnabling(false))
		  }

		  const installed = !!(pet && pet.installed)
		  const enabled = !!(pet && pet.enabled)
		  const line = (text, tone) =>
		    h(
		      'div',
		      {
		        style: {
		          fontSize: FONT_XS,
		          lineHeight: 1.65,
		          padding: '6px 0 0',
		          color: tone === 'bad' ? 'var(--dsw-alias-label-error, #ff6b6b)' : UI_MUTED.color,
		        },
		      },
		      text,
		    )

		  // 步进按钮：跟全站同一个高度（BTN_HEIGHT）、同一个圆角，只把字号压小一档。
		  // 以前这里 padding 3px 8px、下面「写成这个数」5px 14px，两种高度并排就是歪的；
		  // 2026-10-24 用户要求「按钮统一成一种外观（同高 28）」，所以不再单独矮 4px。
		  const stepStyle = Object.assign({}, UI_BUTTON, {
		    height: BTN_HEIGHT,
		    padding: '0 8px',
		    fontSize: FONT_XS,
		    background: 'var(--dsw-alias-bg-l2, rgba(255,255,255,0.08))',
		  })

		  const stepButton = (label, delta) =>
		    h(
		      'button',
		      {
		        key: label,
		        type: 'button',
		        onClick: () => {
		          if (!view) return
		          // 归零走绝对值；其余走「当前 + 增量」（apply 里再夹到 [0, AFFINITY_MAX]）
		          if (delta === 'zero') apply(0)
		          else apply(view.points + delta)
		        },
		        disabled: !view || busy,
		        style: Object.assign({}, stepStyle, { cursor: busy ? 'default' : 'pointer' }),
		      },
		      label,
		    )

		  // 小鱼干的步进：跟亲密度同构，但走 applyTreats、上限是 TREATS_MAX。
		  const treatsStepButton = (label, delta) =>
		    h(
		      'button',
		      {
		        key: 'treats-' + label,
		        type: 'button',
		        onClick: () => {
		          if (!treats) return
		          if (delta === 'zero') applyTreats(0)
		          else applyTreats(treats.treats + delta)
		        },
		        disabled: !treats || treatsBusy,
		        style: Object.assign({}, stepStyle, { cursor: treatsBusy ? 'default' : 'pointer' }),
		      },
		      label,
		    )

		  return h(
		    DiaryCard,
		    { title: '和挂件（鲸鱼娘）的联动' },
		    // 一、状态：装没装、开没开。挂件不是我们代装的，这里只提示 + 一键打开，不擅改用户配置。
		    h(
		      'div',
		      {
		        style: {
		          display: 'flex',
		          flexDirection: narrow ? 'column' : 'row',
		          alignItems: narrow ? 'stretch' : 'center',
		          justifyContent: 'space-between',
		          gap: ROW_GAP,
		          padding: '8px 0',
		        },
		      },
		      h(
		        'div',
		        { style: { fontSize: FONT_SM, lineHeight: 1.7 } },
		        installed
		          ? enabled
		            ? '挂件已装、已经打开。'
		            : '挂件已装，现在是关着的（关着的时候她不会出现在桌面上，亲密度也攒不动）。'
		          : pet && pet.unknown
		            ? '没读到挂件的状态（宿主没回话，刷新页面再看）。'
		            : '还没装挂件 dsh-pet。装了我们才能让她站在桌面上说话。',
		      ),
		      installed && !enabled
		        ? h(
		            'button',
		            {
		              type: 'button',
		              onClick: openPet,
		              disabled: enabling,
		              style: Object.assign({}, UI_BUTTON, {
		                background: 'var(--dsw-alias-bg-l2, rgba(255,255,255,0.08))',
		                cursor: enabling ? 'default' : 'pointer',
		              }),
		            },
		            enabling ? '正在打开…' : '打开挂件',
		          )
		        : null,
		    ),
		    // 二、亲密度 + 小鱼干：一个开关管两块，默认收起，展开才请求。用 button 而不是
		    // <details>：原生 details 靠 toggle 事件，插槽运行时里不好断言，而且这里的
		    // 「展开才拉数据」必须能写成真点击用例（默认零 IO 是用户硬要求，得测住）。
		    h(
		      'button',
		      {
		        type: 'button',
		        onClick: toggle,
		        style: Object.assign({}, UI_BUTTON, {
		          marginTop: ROW_GAP,
		          background: 'var(--dsw-alias-bg-l2, rgba(255,255,255,0.06))',
		        }),
		      },
		      open ? '收起亲密度' : '亲密度（默认收起，想改就点这里）',
		    ),
		    open && !view && !error && !treats
		      ? h(
		          'div',
		          { style: { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 } },
		          line('正在读她和挂件的状态…'),
		          h(
		            'button',
		            { type: 'button', onClick: load, style: Object.assign({}, UI_BUTTON, { fontSize: FONT_XS }) },
		            '重新读取',
		          ),
		        )
		      : null,
		    open && error ? line(error, 'bad') : null,
		    open && view
		      ? h(
		          'div',
		          { style: { padding: '2px 0 8px' } },
		          h(
		            'div',
		            { style: { fontSize: FONT_SM, lineHeight: 1.8, paddingBottom: ROW_GAP } },
		            '现在是 ',
		            h('b', null, String(view.points)),
		            ' / ',
		            String(AFFINITY_MAX),
		            '（这是界面上限；挂件自己允许更大，但这边只放到六位数）',
		          ),
		          h(
		            'div',
		            { style: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: ROW_GAP, paddingBottom: ROW_GAP } },
		            stepButton('+1', 1),
		            stepButton('+10', 10),
		            stepButton('+100', 100),
		            stepButton('-10', -10),
		            stepButton('归零', 'zero'),
		          ),
		          h(
		            'div',
		            { style: { display: 'flex', flexDirection: narrow ? 'column' : 'row', gap: ROW_GAP, alignItems: 'stretch' } },
		            h('input', {
		              type: 'text',
		              inputMode: 'numeric',
		              maxLength: 6,
		              'aria-label': '亲密度（最多六位数）',
		              value: draft,
		              // 先剔非数字再截六位：用户粘「12a34567」也只会得到一个合法值。
		              onChange: (event) => setDraft(digitsOnly(event.target.value, 6)),
		              style: Object.assign({}, UI_FIELD, { flex: 1, minWidth: 0 }),
		            }),
		            h(
		              'button',
		              {
		                type: 'button',
		                onClick: () => apply(draft),
		                disabled: busy,
		                style: Object.assign({}, UI_BUTTON, {
		                  background: 'var(--dsw-alias-bg-l2, rgba(255,255,255,0.08))',
		                  cursor: busy ? 'default' : 'pointer',
		                }),
		              },
		              busy ? '正在写入…' : '写成这个数',
		            ),
		          ),
		          notice ? line(notice) : null,
		          line('改之前会先备份一份 pet.json.bak；失败会还原，不会把她的点数冲掉。'),
		        )
		      : null,
		    // 三、小鱼干：和亲密度同一张卡、同一个开关（展开一次两样都看到）。
		    open
		      ? h(
		          'div',
		          {
		            style: {
		              marginTop: CARD_GAP,
		              paddingTop: CARD_GAP,
		              borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08))',
		            },
		          },
		          h(
		            'div',
		            { style: { fontSize: FONT_TITLE, paddingBottom: 2 } },
		            '小鱼干',
		          ),
		          open && !treats && !treatsError ? line('正在读她有几条小鱼干…') : null,
		          open && treatsError ? line(treatsError, 'bad') : null,
		          treats
		            ? h(
		                'div',
		                { style: { padding: '2px 0 8px' } },
		                h(
		                  'div',
		                  { style: { fontSize: FONT_SM, lineHeight: 1.8, paddingBottom: ROW_GAP } },
		                  '现在有 ',
		                  h('b', null, String(treats.treats)),
		                  ' / ',
		                  String(treatsCapOf(treats)),
		                  '（最多 ' + treatsCapOf(treats) + ' 条，这个上限是挂件自己定的，不是我们改的）',
		                ),
		                h(
		                  'div',
		                  { style: { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: ROW_GAP, paddingBottom: ROW_GAP } },
		                  treatsStepButton('+1', 1),
		                  treatsStepButton('+10', 10),
		                  treatsStepButton('+100', 100),
		                  treatsStepButton('归零', 'zero'),
		                ),
		                h(
		                  'div',
		                  { style: { display: 'flex', flexDirection: narrow ? 'column' : 'row', gap: ROW_GAP, alignItems: 'stretch' } },
		                  h('input', {
		                    type: 'text',
		                    inputMode: 'numeric',
		                    maxLength: 3,
		                    'aria-label': '小鱼干（最多三位数）',
		                    value: treatsDraft,
		                    // 只剔非数字，不在这里截断：maxLength 3 已经挡住手敲第 4 位，
		                    // 而粘贴进来的「1200」得原样留着，交给 applyTreats 夹到 999——
		                    // 直接 slice 成「120」会把用户想写的数字悄悄改小十倍。
		                    onChange: (event) => setTreatsDraft(digitsOnly(event.target.value)),
		                    style: Object.assign({}, UI_FIELD, { flex: 1, minWidth: 0 }),
		                  }),
		                  h(
		                    'button',
		                    {
		                      type: 'button',
		                      onClick: () => applyTreats(treatsDraft),
		                      disabled: treatsBusy,
		                      style: Object.assign({}, UI_BUTTON, {
		                        background: 'var(--dsw-alias-bg-l2, rgba(255,255,255,0.08))',
		                        cursor: treatsBusy ? 'default' : 'pointer',
		                      }),
		                    },
		                    treatsBusy ? '正在写入…' : '写成这个数',
		                  ),
		                ),
		                treatsNotice ? line(treatsNotice) : null,
		                line('改之前会先备份一份 pet.json.bak；失败会还原，不会把小鱼干弄丢。'),
		              )
		            : null,
		        )
		      : null,
		  )
		}

		function DiaryHelpCard(props) {
		  const codes = Object.keys(COPY.problem)
		  // 2026-10-24 用户原话：「这些都要写清楚」。下面四条都用大白话写，别上术语。
		  const qa = [
		    {
		      key: 'doc',
		      q: '日记本文件夹里那个 AI娘日记记录.md 是什么？',
		      a: '那是她的「账本」——记着设置、今天聊了多少、最近写过哪几篇。它不是日记。真正的日记是按日期一天一个文件，就在同一个文件夹里。',
		    },
		    {
		      key: 'memory',
		      q: '要装记忆插件吗？',
		      a: '不用。日记直接读 DSH 自己的会话日志（就在 ~/.dsh/sessions 里），不依赖任何记忆插件。',
		    },
		    {
		      key: 'archive',
		      q: '会话归档了还能写吗？',
		      a: '能。归档只是从侧边栏藏起来，文件还在磁盘上，照样能扫到、照样能写进日记。',
		    },
		    {
		      key: 'cutoff',
		      q: '为什么晚上写的那篇算前一天？',
		      a: '每天 21:00 之前算当天，21:00 之后算第二天。21:00 定时写的那篇，写的是刚刚结束的那一天。',
		    },
		  ]
		  return h(
		    DiaryCard,
		    { title: COPY.sections.help },
		    // 四条大白话问答：用户问得最多的就是这四件，直接摊开写，不让用户自己猜。
		    h(
		      'div',
		      { style: { padding: '2px 0 4px' } },
		      qa.map((item) =>
		        h(
		          'div',
		          { key: item.key, style: { padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.06))' } },
		          h('div', { style: { fontSize: FONT_SM, paddingBottom: 2 } }, item.q),
		          h('div', { style: Object.assign({ fontSize: FONT_XS, lineHeight: 1.7 }, UI_MUTED) }, item.a),
		        ),
		      ),
		    ),
		    h(
		      'div',
		      { style: Object.assign({ padding: '8px 0', fontSize: FONT_XS, lineHeight: 1.65 }, UI_MUTED) },
		      '没生效怎么查：在浏览器里打开 ',
		      h('a', { href: BRIDGE + '/debug', target: '_blank', rel: 'noreferrer', style: UI_LINK }, BRIDGE + '/debug'),
		      '（和页面同一个地址），看 stage 是不是 ready、attached 里有没有当前会话。',
		    ),
		    h(
		      'details',
		      null,
		      h('summary', { style: { cursor: 'pointer', fontSize: FONT_SM, padding: '6px 0' } }, '错误码对照表（默认折叠）'),
		      h(
		        'div',
		        { style: { paddingBottom: 8 } },
		        codes.map((code) =>
		          h(
		            'div',
		            { key: code, style: { display: 'flex', gap: ROW_GAP, padding: '2px 0', fontSize: FONT_XS, lineHeight: 1.5 } },
		            h('code', { style: Object.assign({ flex: 'none', minWidth: 150 }, UI_MONO) }, code),
		            h('span', { style: UI_MUTED }, COPY.problem[code]),
		          ),
		        ),
		      ),
		    ),
		  )
		}

		/**
		 * 日记面板（设置页里那一块）。
		 *
		 * 用户要的四件事：开关、日记本文件夹、几点写、谁来写。全部走宿主桥，
		 * 浏览器这边不碰文件系统。
		 *
		 * 失败一定说出来：写日记最难受的形态是「没反应」——不知道是没到点、
		 * 还是读不到今天的对话、还是执笔跑挂了。所以每个宿主错误码都有中文话术。
		 */
		function DiaryPanel(props) {
		  const narrow = props && props.narrow === true
		  const identity = props && props.identity ? props.identity : null
		  const snapshot = useDiarySnapshot()
		  const snap = snapshot.snap
		  const [action, setAction] = useState('')
		  // 成功提示要贴在被操作的那一行旁边（t7 F7）：{text, where='dir'|'doc'|'time'|'schedule'|'diarist'|'today'}
		  const [note, setNote] = useState(null)
		  const [localProblem, setLocalProblem] = useState('')
		  const [recoveredDismissed, setRecoveredDismissed] = useState(false)
		  const [forceRepick, setForceRepick] = useState(false)
		  const [freshDir, setFreshDir] = useState('')
		  const [refreshing, setRefreshing] = useState(false)
		  const [todayProblem, setTodayProblem] = useState('')
		  const noteTimerRef = useRef(0)
		  const todayTimerRef = useRef(0)
		  const lastActionRef = useRef(null)

		  useEffect(
		    () => () => {
		      clearTimeout(noteTimerRef.current)
		      clearTimeout(todayTimerRef.current)
		    },
		    [],
		  )

		  const flash = (text, where) => {
		    setNote({ text: text, where: where || 'schedule' })
		    clearTimeout(noteTimerRef.current)
		    noteTimerRef.current = setTimeout(() => setNote(null), 4000)
		  }
		  const noteAt = (where) => (note && note.text && note.where === where ? note.text : '')

		  const config = (snap && snap.config) || FACTORY_DIARY_CONFIG
		  const doc = (snap && snap.doc) || null
		  const today = (snap && snap.today) || null
		  const busy = (snap && snap.busy) || { writing: false, writingSince: null, picking: false }
		  const failure = snap && snap.failure ? snap.failure : null
		  const migrated = snap && snap.migrated ? snap.migrated : null
		  const recent = snap && Array.isArray(snap.recent) ? snap.recent : snap && Array.isArray(snap.files) ? snap.files : []
		  const dirState = config.dirState || (config.dir ? 'ok' : 'none')
		  const dirMissing = dirState === 'missing'
		  const recovered = snap && snap.dirRecovered && typeof snap.dirRecovered === 'object' ? snap.dirRecovered : null
		  const suggestions = snap && Array.isArray(snap.dirSuggestions) ? snap.dirSuggestions.slice(0, 3) : []
		  const dirMarker = snap && typeof snap.dirMarker === 'string' ? snap.dirMarker : ''
		  const showRecovered = !!(recovered && !recoveredDismissed)
		  const showDirCard = forceRepick || (!recovered && dirMissing)
		  const writing = busy.writing === true || action === 'write'

		  // 「知道了」按 dirRecovered.at 记住：刷新页面也不重复弹同一次认回。
		  useEffect(() => {
		    if (!recovered) return
		    const at = recovered.at || ''
		    if (at && readRecoverDismissed() === at) setRecoveredDismissed(true)
		  }, [recovered && recovered.at])

		  const patchConfig = (next) => {
		    if (!next) return
		    snapshot.setSnap((prev) => (prev ? Object.assign({}, prev, { config: next }) : prev))
		  }
		  const updateToday = (next) => {
		    if (!next) return
		    snapshot.setSnap((prev) => (prev ? Object.assign({}, prev, { today: next }) : prev))
		  }

		  // 首屏只读记录文档；「二」段还没统计过（stale/unknown）时补一次 /diary/today——
		  // 不阻塞首屏、后台标签页不发、回前台仍 stale 再补一次（docs §c:539 / t15 F17）。
		  // 失败不静默也不抽风：最多试 2 次（下次快照变化 / 回前台时再试），两次都没成
		  // 就在「今天」卡下面留一行灰字，而不是把「刷新统计」按钮一直转圈。
		  const staleTriesRef = useRef(0)
		  const [statsQuiet, setStatsQuiet] = useState('')
		  useEffect(() => {
		    if (!snap || !snap.today) return undefined
		    const staleNow = () => {
		      const t = snap.today || {}
		      return t.stale === true || t.state === 'unknown'
		    }
		    if (!staleNow() || staleTriesRef.current >= 2) return undefined
		    let cancelled = false
		    let retryTimer = 0
		    const ask = () => {
		      if (typeof document !== 'undefined' && document.hidden) return
		      bridgeRequest('/diary/today', undefined, { timeoutMs: DIARY_STATS_TIMEOUT_MS })
		        .then((value) => {
		          if (cancelled || !value) return
		          staleTriesRef.current = 0
		          setStatsQuiet('')
		          updateToday(value)
		        })
		        .catch(() => {
		          /* 失败不打扰也不会一直重试：第 2 次再失败就留一行灰字，让用户自己决定。 */
		          if (cancelled) return
		          staleTriesRef.current += 1
		          if (staleTriesRef.current >= 2) setStatsQuiet('统计没拉下来，点「刷新统计」再试一次')
		          else retryTimer = setTimeout(ask, 1500)
		        })
		    }
		    ask()
		    const onVisible = () => {
		      if (!cancelled && staleNow() && staleTriesRef.current < 2) ask()
		    }
		    try {
		      document.addEventListener('visibilitychange', onVisible)
		    } catch {
		      /* 没有 document：只补这一次 */
		    }
		    return () => {
		      cancelled = true
		      if (retryTimer) clearTimeout(retryTimer)
		      try {
		        document.removeEventListener('visibilitychange', onVisible)
		      } catch {
		        /* 同上 */
		      }
		    }
		  }, [snap])

		  const savePatch = (patch, done) => {
		    setAction('save')
		    setLocalProblem('')
		    setNote(null)
		    lastActionRef.current = () => savePatch(patch, done)
		    bridgeRequest('/diary', patch)
		      .then((value) => {
		        if (value && value.config) patchConfig(value.config)
		        flash(done, whereFromPatch(patch))
		      })
		      .catch((error) => setLocalProblem(explain(error, 'save')))
		      .then(() => setAction(''))
		  }

		  const pickFolder = () => {
		    setAction('pick')
		    setLocalProblem('')
		    lastActionRef.current = () => pickFolder()
		    bridgeRequest('/diary/pick-dir', {}, { timeoutMs: DIARY_PICK_TIMEOUT_MS })
		      .then((value) => {
		        const dir = value && value.dir ? String(value.dir) : ''
		        flash('日记本就定在这里了：' + dir, 'dir')
		        setFreshDir(dir)
		        setForceRepick(false)
		        setRecoveredDismissed(true)
		        snapshot.reload()
		      })
		      .catch((error) => {
		        const code = String((error && error.message) || '')
		        if (code === 'cancelled') return
		        setLocalProblem(explain(error, 'pick'))
		      })
		      .then(() => setAction(''))
		  }

		  const rebuildFolder = () => {
		    const dir = config.dir
		    if (!dir) {
		      setForceRepick(true)
		      setLocalProblem(COPY.s1.noDir)
		      return
		    }
		    setAction('rebuild')
		    setLocalProblem('')
		    lastActionRef.current = () => rebuildFolder()
		    bridgeRequest('/diary', { dir: dir, autoCreate: true })
		      .then((value) => {
		        if (value && value.config) patchConfig(value.config)
		        flash('已重新建好日记本：' + dir, 'dir')
		        setFreshDir(dir)
		        setForceRepick(false)
		        snapshot.reload()
		      })
		      .catch((error) => setLocalProblem(explain(error, 'save')))
		      .then(() => setAction(''))
		  }

		  const reloadDoc = () => {
		    setAction('reload')
		    setLocalProblem('')
		    bridgeRequest('/diary/reload', {})
		      .then((value) => {
		        snapshot.apply(value)
		        flash('已重新读取记录文档', 'doc')
		      })
		      .catch((error) => setLocalProblem(explain(error, 'reload')))
		      .then(() => setAction(''))
		  }

		  const writeNow = () => {
		    setAction('write')
		    setLocalProblem('')
		    setTodayProblem('')
		    lastActionRef.current = () => writeNow()
		    bridgeRequest('/diary/write', {}, { timeoutMs: DIARY_WRITE_TIMEOUT_MS })
		      .then((value) => {
		        const file = value && value.file ? String(value.file) : ''
		        const chars = value && typeof value.chars === 'number' ? value.chars : 0
		        flash('写好了：' + file + '（' + chars + ' 字）', 'today')
		        snapshot.reload()
		      })
		      .catch((error) => setLocalProblem(explain(error, 'write')))
		      .then(() => setAction(''))
		  }

		  const refreshToday = () => {
		    setRefreshing(true)
		    setTodayProblem('')
		    setStatsQuiet('')
		    staleTriesRef.current = 0
		    let tries = 0
		    const ask = () => {
		      bridgeRequest('/diary/today?refresh=1', undefined, { timeoutMs: DIARY_STATS_TIMEOUT_MS })
		        .then((value) => {
		          if (!value) {
		            setRefreshing(false)
		            return
		          }
		          updateToday(value)
		          if (value.state === 'scanning' && tries < 20) {
		            tries += 1
		            todayTimerRef.current = setTimeout(ask, 1500)
		            return
		          }
		          setRefreshing(false)
		          if (value.state === 'scanning') setTodayProblem('统计有点慢，点「刷新统计」再试一次。')
		        })
		        .catch((error) => {
		          setRefreshing(false)
		          setTodayProblem(explain(error, 'stats'))
		        })
		    }
		    ask()
		  }

		  // 「知道了」：只关横幅，不发任何请求（docs §c S1a）。
		  const dismissRecovered = () => {
		    const at = (recovered && recovered.at) || ''
		    if (at) rememberRecoverDismissed(at)
		    setRecoveredDismissed(true)
		  }

		  // 「不是我那个」：真正告诉宿主（不自动认回 + dir 回到 from），然后用返回的快照整体替换。
		  const rejectRecovered = () => {
		    const to = (recovered && recovered.to) || ''
		    if (!to) {
		      setRecoveredDismissed(true)
		      setForceRepick(true)
		      setLocalProblem('认回的目标路径读不到，请手动选一次文件夹。')
		      return
		    }
		    setAction('reject')
		    setLocalProblem('')
		    lastActionRef.current = () => rejectRecovered()
		    bridgeRequest('/diary/reject-dir', { to: to }, { timeoutMs: DIARY_STATS_TIMEOUT_MS })
		      .then((value) => {
		        const at = (recovered && recovered.at) || ''
		        if (at) rememberRecoverDismissed(at)
		        setRecoveredDismissed(true)
		        setForceRepick(true)
		        if (value && typeof value === 'object') snapshot.apply(value)
		        else snapshot.reload()
		      })
		      .catch((error) => setLocalProblem(explain(error, 'save')))
		      .then(() => setAction(''))
		  }

		  // S1b：用户点「用它」= 正常确认目录（不是自动认回），走 POST /diary {dir}。
		  const useSuggestion = (dir) => {
		    if (!dir) return
		    savePatch({ dir: dir }, '已换成这个文件夹：' + dir)
		  }

		  // 读设置期间别把出厂值当成用户配置说「日记关着」（t7 F11）。
		  const status = snap ? summaryOf(config, today, busy, !!localProblem) : { tone: 'warn', text: '正在读设置…' }
		  const docPath = doc && typeof doc.path === 'string' ? doc.path : config.dir ? config.dir + '/AI娘日记记录.md' : ''
		  const failureForCard = localProblem ? null : failure
		  let writeDisabledReason = ''
		  if (writing) writeDisabledReason = '她正在写，等这一篇写完'
		  else if (dirMissing) writeDisabledReason = '先找到日记本才能写'
		  else if (config.dirState === 'none' || !config.dir) writeDisabledReason = '先选日记本文件夹才能写'
		  const writeDisabled = writing || dirMissing || !config.dir

		  // S1a 自动认回：淡绿 + 左边绿条，不是错误（docs §c S1a，t7 F5）。
		  const recoveredBanner = showRecovered
		    ? h(
		        'div',
		        {
		          role: 'status',
		          'aria-live': 'polite',
		          style: {
		            marginTop: 8,
		            padding: '10px 12px',
		            borderRadius: 8,
		            borderLeft: '3px solid #2fb344',
		            background: 'rgba(47,179,68,0.10)',
		            fontSize: 12,
		            lineHeight: 1.65,
		          },
		        },
		        h('div', { style: { fontWeight: 600 } }, COPY.recovered.text + (recovered.to || '')),
		        h(
		          'div',
		          { style: Object.assign({ marginTop: 4 }, UI_MUTED) },
		          COPY.recovered.rename + (recovered.from || '（不确定）') + '。',
		        ),
		        h('div', { style: UI_MUTED }, COPY.recovered.stillThere),
		        recovered.persisted === false
		          ? h('div', { style: Object.assign({ marginTop: 4, fontSize: 11 }, UI_MUTED) }, COPY.recovered.persisted)
		          : null,
		        h(
		          'div',
		          { style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' } },
		          actionButton(action === 'reject' ? '处理中…' : COPY.recovered.reject, rejectRecovered, {
		            disabled: action === 'reject',
		            title: '把新名字记进「不自动认回」，然后回到重新选文件夹的流程',
		            ariaLabel: COPY.recovered.reject,
		            style: { fontSize: 11 },
		          }),
		          actionButton(COPY.recovered.know, dismissRecovered, {
		            title: '只收起这条提示，不改任何设置',
		            ariaLabel: COPY.recovered.know,
		            style: { fontSize: 11 },
		          }),
		        ),
		      )
		    : null

		  const dirCard = showDirCard
		    ? h(
		        'div',
		        {
		          style: {
		            marginTop: 10,
		            padding: '10px 12px',
		            borderLeft: '3px solid #d6a210',
		            borderRadius: 8,
		            background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.04))',
		            fontSize: 12,
		            lineHeight: 1.65,
		          },
		        },
		        h('div', { style: { fontWeight: 600 } }, dirMissing ? COPY.s1.title + (config.dir || '（空）') : COPY.recovered.hint),
		        dirMissing ? h('div', { style: Object.assign({ marginTop: 4 }, UI_MUTED) }, COPY.s1.body) : null,
		        dirMissing ? h('div', { style: Object.assign({ marginTop: 4 }, UI_MUTED) }, COPY.s1.pick) : null,
		        dirMissing ? h('div', { style: UI_MUTED }, COPY.s1.rebuild) : null,
		        h(
		          'div',
		          { style: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' } },
		          actionButton(action === 'pick' ? '选着…' : COPY.s1.pickButton, pickFolder, {
		            disabled: action === 'pick',
		          }),
		          actionButton(action === 'rebuild' ? '正在建…' : COPY.s1.rebuildButton, rebuildFolder, {
		            disabled: action === 'rebuild' || !config.dir,
		          }),
		        ),
		        freshDir
		          ? h('div', { style: { marginTop: 6, fontSize: 11, color: '#2fb344' } }, COPY.s1.found + freshDir)
		          : null,
		        // S1b：找回来的疑似本子（点「用它」= 正常确认目录，不是自动认回）。
		        suggestions.length
		          ? h(
		              'div',
		              { style: { marginTop: 8, padding: '6px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.04)', fontSize: 11, lineHeight: 1.6 } },
		              suggestions.map((item, index) => {
		                const dir = item && typeof item.dir === 'string' ? item.dir : ''
		                const reason = item && typeof item.reason === 'string' ? item.reason : ''
		                return h(
		                  'div',
		                  { key: 'sug' + index, style: { marginTop: index ? 4 : 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
		                  h('span', { style: Object.assign({ flex: '1 1 220px', wordBreak: 'break-all' }, UI_MUTED) },
		                    COPY.recovered.suggestion,
		                    h('code', { style: UI_MONO }, dir),
		                    reason ? '（' + reason + '）' : ''),
		                  actionButton(COPY.recovered.useIt, () => useSuggestion(dir), {
		                    disabled: action !== '' || !dir,
		                    title: '把这个文件夹当成日记本（原来的日记不动）',
		                    style: { fontSize: 11 },
		                  }),
		                )
		              }),
		            )
		          : null,
		        localProblem
		          ? h(
		              'div',
		              { style: { marginTop: 6, fontSize: 11, color: 'var(--dsw-alias-label-error, #ff6b6b)' } },
		              localProblem,
		            )
		          : null,
		      )
		    : null

		  return h(
		    'div',
		    { style: { marginTop: 4 } },
		    recoveredBanner,
		    // 还没读到真设置时，整页先把话说明白：下面全是出厂值，别让人把「关着」当成真读过（t7 F11）。
		    !snap
		      ? h(
		          'div',
		          {
		            role: 'note',
		            style: Object.assign({ marginTop: 4, marginBottom: 2, fontSize: 11, lineHeight: 1.6 }, UI_MUTED),
		          },
		          '下面是出厂值，正在读取你的日记设置…（读到之前这些开关只是样子，点了也不会写盘）',
		        )
		      : null,
		    h(DiaryStatusCard, { tone: status.tone, text: status.text }),
		    identity,
		    dirCard,
		    // 卡片顺序（2026-10-24 用户要求）：她现在的状态 → 日记设置 → 最近的日记。
		    // 以前「她现在的状态」排在三张设置卡后面，一屏里先看到的是开关，看不到她今天怎么样。
		    h(DiaryTodayCard, {
		      today: today,
		      busy: busy,
		      failure: failureForCard,
		      problem: localProblem && !showDirCard ? localProblem : '',
		      todayProblem: todayProblem,
		      statsQuiet: statsQuiet,
		      narrow: narrow,
		      refreshing: refreshing,
		      writing: writing,
		      writeDisabled: writeDisabled,
		      writeDisabledReason: writeDisabledReason,
		      docPath: docPath,
		      actionBusy: action !== '',
		      onRefresh: refreshToday,
		      onWrite: writeNow,
		      note: noteAt('today'),
		      onRetry: () => {
		        const fn = lastActionRef.current
		        if (typeof fn === 'function') fn()
		        else writeNow()
		      },
		    }),
		    h(DiaryDirCard, {
		      config: config,
		      doc: doc,
		      narrow: narrow,
		      action: action,
		      migrated: migrated,
		      onPick: pickFolder,
		      onRebuild: rebuildFolder,
		      onReload: reloadDoc,
		      dirMarker: dirMarker,
		      noteDir: noteAt('dir'),
		      noteDoc: noteAt('doc'),
		    }),
		    h(DiaryScheduleCard, {
		      config: config,
		      narrow: narrow,
		      // 还没读到配置时，卡片里不许断言「现在关着」（体感审 L1）
		      reading: !snap,
		      onSave: savePatch,
		      onToggleEnabled: () => savePatch({ enabled: config.enabled !== true }, config.enabled ? '日记已关掉' : '日记已打开'),
		      onToggleAutoCreate: () =>
		        savePatch({ autoCreate: config.autoCreate === false }, config.autoCreate === false ? '已改成自动新建本子' : '已关掉自动新建本子'),
		      note: noteAt('schedule'),
		      noteTime: noteAt('time'),
		    }),
		    h(DiaryDiaristCard, { config: config, today: today, narrow: narrow, onSave: savePatch, note: noteAt('diarist') }),
		    h(DiaryRecentCard, { recent: recent }),
		    snapshot.problem
		      ? h(
		          'div',
		          { style: { marginTop: 6, fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-error, #ff6b6b)' } },
		          snapshot.problem,
		        )
		      : null,
		  )
		}

		function PluginSettings(props) {
		  const subject = props && props.subject
		  // 两种座位都用这一份 UI：
		  //   ① plugins.detail.section —— 插件详情页里（有 subject，要自己认领）；
		  //   ② settings.section —— 设置面板里的独立一页（没有 subject，forceShow 直接画）。
		  // 之所以要 ②：用户原话「在设置界面没看到你这个插件。所以，能不能改？怎么改？我一点
		  // 都不知道」——把日记目录这种日常配置埋在"设置 → 插件 → 找到它 → 打开详情"四层下面，
		  // 等于没有。设置页第一层就得能看见。
		  // 包名 2026-10-24 改成 dsh-pet-cuteness-plugin：新旧两个名字都认，这样还没升级的旧安装
		  // 也能认领这一页——认不出来就是「设置页里找不到这个插件」，而且是静默的。
		  const isMine =
		    (props && props.forceShow === true) ||
		    (subject &&
		      (subject.kind === 'bundle' || subject.kind === 'row') &&
		      !!subject.pkg &&
		      ['dsh-ai-waifu', 'dsh-pet-cuteness', 'dsh-pet-cuteness-plugin'].includes(subject.pkg.name))
		  // ⚠️ hook 必须先于所有 return 调用，否则换到别的插件页时 hook 数量变化会炸掉这条 entry。
		  const [state, setFlags] = useToggleFlags('')
		  const [saved, setSaved] = useState('')
		  const [failed, setFailed] = useState('')
		  const [slow, setSlow] = useState(false)
		  const narrow = useNarrow()

		  // 不是本插件的详情页就什么都不画（槽的契约：对无关 subject 返回 null）。
		  if (!isMine) return null

		  // 读到之前也照样把界面画出来（用出厂值），读到再更新。
		  // 用户实测：点「设置 → 大肥鱼的后台」时卡在两分钟的黑屏提示上没出来。
		  // 原因是原先把整页 gate 在一个 fetch 上——桥一旦排队/超时，界面就永远白等，
		  // 而且看不出是卡住还是坏了。乐观渲染至少让页面可用，读不到也只是"值可能不是最新的"。
		  useEffect(() => {
		    if (state) return undefined
		    const timer = setTimeout(() => setSlow(true), READ_SLOW_MS)
		    return () => clearTimeout(timer)
		  }, [state])

		  const defaults = state ? state.defaults : CLIENT_DEFAULT_FLAGS
		  const liveFlags = state ? state.flags : CLIENT_DEFAULT_FLAGS
		  const muted = UI_MUTED

		  const row = (key, label, hint) =>
		    h(
		      'div',
		      {
		        key: key,
		        style: {
		          display: 'flex',
		          flexDirection: narrow ? 'column' : 'row',
		          alignItems: narrow ? 'stretch' : 'flex-start',
		          justifyContent: 'space-between',
		          gap: narrow ? 6 : 16,
		          padding: '10px 0',
		          borderTop: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08))',
		        },
		      },
		      h(
		        'div',
		        { style: { minWidth: 0, flex: '1 1 auto' } },
		        h('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-primary, #fff)' } }, label),
		        h('div', { style: Object.assign({ marginTop: 2, fontSize: 11, lineHeight: 1.5 }, muted) }, hint),
		      ),
		      h(
		        'div',
		        { style: { flex: 'none', alignSelf: narrow ? 'flex-start' : 'auto' } },
		        h(MiniToggle, {
		          on: defaults[key] === true,
		          accent: CARD_ACCENT.deepseek,
		          label: defaults[key] === true ? '默认开启' : '默认关闭',
		          showState: false,
		          title: label + '：' + (defaults[key] === true ? '默认开启' : '默认关闭') + '（点一下切换）',
		          onClick: () => {
		            if (!state) {
		              // 还没读到就点了：先重试读取，别让人以为点坏了。
		              flagStore.load()
		              setFailed('还在读宿主的状态，先没记下这一下；读到以后点一次就生效。')
		              return
		            }
		            const before = { defaults: defaults, flags: liveFlags }
		            const next = core.toggleFlag(defaults, key)
		            // 先广播（输入框那排胶囊立刻同步），再写盘；写失败回滚并明说。
		            setFlags({ defaults: next, flags: liveFlags })
		            setSaved('')
		            setFailed('')
		            writeDefaults(next)
		              .then(() =>
		                setSaved('已保存。语气与中文思考对之后新开的会话生效；当前会话请用输入框左边的胶囊单独开关。'),
		              )
		              .catch((error) => {
		                setFlags(before)
		                setFailed(WRITE_FAILED)
		                try {
		                  console.warn('[dsh-pet-cuteness-plugin] 默认值写入失败', error)
		                } catch {
		                  /* 控制台不可用也不能崩 */
		                }
		              })
		          },
		        }),
		      ),
		    )

		  const identity = h(
		    DiaryCard,
		    { title: COPY.sections.identity },
		    row(
		      'persona',
		      '人设语气',
		      '把「你是谁」写进系统提示词，让她按人格说话。默认关闭；打开后对之后新开的会话生效，会增加每次请求约 2 KB 的 token 开销。',
		    ),
		    row(
		      'thinking',
		      '中文思考',
		      '要求模型直接用简体中文思考，而不是先想英文再翻译。默认关闭；打开后对之后新开的会话生效。',
		    ),
		    h(
		      'div',
		      { style: Object.assign({ padding: '0 0 10px', fontSize: 11, lineHeight: 1.6 }, muted) },
		      '这里改的是默认值，对之后新开的会话生效。当前会话想单独开关，用输入框左边那排胶囊。',
		    ),
		  )

		  return h(
		    UI.Page,
		    null,
		    // 页头：标题 + 一句话说清这页干什么（用户要求「别写长」）。
		    // 文案不许改：这是「设置 → 大肥鱼的后台」里唯一告诉用户"这页是干嘛的"的一句。
		    h(UI.PageHeader, {
		      title: '大肥鱼的后台',
		      subtitle: '这是大肥鱼的后台；日记与挂件都在这一页管。',
		    }),
		    slow && !state
		      ? h(
		          'div',
		          {
		            style: {
		              padding: '6px 0 8px',
		              fontSize: FONT_XS,
		              lineHeight: 1.6,
		              color: 'var(--dsw-alias-label-secondary, rgba(255,255,255,0.6))',
		            },
		          },
		          '宿主那边还没回来，下面是出厂默认值。点一次开关会重新读一遍；要是连点两次都没反应，刷新页面或重启 App。',
		        )
		      : null,
		    h(DiaryPanel, { narrow: narrow, identity: identity }),
		    saved ? h('div', { style: { marginTop: 6, fontSize: FONT_XS, color: CARD_ACCENT.deepseek } }, saved) : null,
		    failed ? h('div', { style: { marginTop: 6, fontSize: FONT_XS, color: 'var(--dsw-alias-label-error, #ff6b6b)' } }, failed) : null,
		    h(
		      'div',
		      { style: Object.assign({ marginTop: ROW_GAP, fontSize: FONT_XS, lineHeight: 1.6 }, muted) },
		      '右下角的鲸鱼娘由 dsh-pet 出镜；本插件负责她的人设语气、中文思考、台词和日记。没生效怎么查：在浏览器里打开 /api/dsh-pet-cuteness-plugin/debug（和页面同一个地址），看 stage 是不是 ready、attached 里有没有当前会话。stage 不是 ready 说明宿主服务没挂上，刷新页面或重启 App。',
		    ),
		    // 与挂件的联动（状态 + 亲密度 + 小鱼干）。放在日记设置下面、帮助前面。
		    h(AffinityEditor, { key: 'affinity' }),
		    // 帮助与说明放最后：记录文档是什么 + 四条大白话问答都在这里。
		    h(DiaryDocCard, null),
		    h(DiaryHelpCard, null),
		  )
		}

		/**
		 * 设置面板里的独立一页（settings.section）。
		 * 用户点「设置 → 大肥鱼的后台」就直接到这里，不用在插件列表里翻。
		 */
		function SettingsPage(props) {
		  return h(PluginSettings, { forceShow: true, close: props && props.close })
		}

		/**
		 * 从会话快照里读当前模型。
		 * 注意 `useSessions` 的快照里**没有 sessionId 字段**（宿主 projectList 只 set
		 * ids/byId/phase/projectionsBySession），所以不能读 list.sessionId。
		 * M0 退化为"谁在跑就是谁，再退最近更新"。
		 */
		function readModel(list) {
		  try {
		    if (!list || typeof list !== 'object') return ''
		    const byId = list.byId && typeof list.byId === 'object' ? list.byId : {}
		    const ids = Array.isArray(list.ids) ? list.ids : Object.keys(byId)
		    let rowId = ids.find((id) => byId[id] && byId[id].running) || ''
		    if (!rowId) {
		      let bestAt = -Infinity
		      for (const id of ids) {
		        const at = typeof byId[id]?.updatedAt === 'number' ? byId[id].updatedAt : -Infinity
		        if (at > bestAt) { bestAt = at; rowId = id }
		      }
		    }
		    if (!rowId) return ''
		    const slot = (list.projectionsBySession || {})[rowId]
		    const values = (slot && slot.values) || {}
		    const picked = core.readSelection({ values })
		    return picked && typeof picked.model === 'string' ? picked.model : ''
		  } catch {
		    return ''
		  }
		}

		function apply(ctx) {
		  // ── 这里曾经注册 shell.overlay（右下角自绘挂件）───────────────
		  // 2026-10-22 决策变更：砍掉自绘挂件，改由 dsh-pet 的鲸鱼娘出镜，本插件只保留
		  // 「语气注入 + 开关 + 设置页」。留着这段注册会让右下角出现两只角色、两套气泡，
		  // 所以整块删除，不要再加回来（见 docs/设计方案v3.md §一 决策变更）。
		  // 输入框左边的三项开关。
		  // 选这个槽是因为它是**唯一**同时满足两个条件的座位：
		  //   ① session 作用域（宿主直接给 sessionId）→ "每个对话各自开关"天然成立；
		  //   ② 在输入框工具行里 → 用户每次打字都能看见，不用翻设置。
		  // order 取 40：排在 lume-persona(10) 之后、skills-management(60) 之前，
		  // 不和别人抢位置（这几个 occupant 都不是我们能控制的）。
		  ctx.effect(
		    () =>
		      ctx.slots.inject('conversation.input.left', () =>
		        ctx.slots.register(
		          {
		            name: 'conversation.input.left',
		            id: 'ai-waifu-toggles',
		            order: 40,
		          },
		          ToggleBar,
		        ),
		      ),
		    'dsh-pet-cuteness-plugin: composer toggles',
		  )

		  // 台词气泡分两层，因为**会话 id 只有会话作用域的槽给**，而"贴着她头顶"只有
		  // root 作用域的 overlay 做得到（dock 会被输入框宽度和布局框住）：
		  //   ① dock 里放一个空组件，把 sessionId 递到模块变量（linesSessionId）；
		  //   ② overlay 里放气泡本体，读那个变量 + 轮询宠物位置。
		  // 上一版只做了①，用户实测反馈「挂件可以移动，但气泡不跟着，钉在右下角」。
		  ctx.effect(
		    () =>
		      ctx.slots.inject('conversation.input.dock', () =>
		        ctx.slots.register(
		          {
		            name: 'conversation.input.dock',
		            id: 'ai-waifu-lines',
		            order: 40,
		            label: 'AI 娘的嘀咕',
		          },
		          LinesSessionBridge,
		        ),
		      ),
		    'dsh-pet-cuteness-plugin: lines session bridge',
		  )

		  // order 取 55：让开 dsh-pet 自己的立绘层，只跟在它旁边冒一句话。
		  ctx.effect(
		    () =>
		      ctx.slots.inject('shell.overlay', () =>
		        ctx.slots.register(
		          {
		            name: 'shell.overlay',
		            id: 'ai-waifu-lines-bubble',
		            order: 55,
		            label: 'AI 娘的嘀咕',
		          },
		          LinesBubbleOverlay,
		        ),
		      ),
		    'dsh-pet-cuteness-plugin: lines bubble overlay',
		  )

		  // 插件详情页里的「默认开启」设置。
		  // 选 plugins.detail.section 而不是自建页面：用户找插件设置就是打开插件页，
		  // 多一个入口等于多一个他找不到的地方。这个槽的契约允许对无关 subject 返回 null。
		  ctx.effect(
		    () =>
		      ctx.slots.inject('plugins.detail.section', () =>
		        ctx.slots.register(
		          {
		            name: 'plugins.detail.section',
		            id: 'ai-waifu-settings',
		            order: 80,
		            // 2026-10-24 用户改名：侧边栏/插件详情显示「大肥鱼的后台」。
		            label: '大肥鱼的后台',
		          },
		          PluginSettings,
		        ),
		      ),
		    'dsh-pet-cuteness-plugin: plugin settings section',
		  )

		  // 设置面板第一层的独立一页（「设置 → 大肥鱼的后台」）。
		  // 为什么还要这一条：插件详情页那个入口在「设置 → 插件 → 列表里找到它 → 点开详情」
		  // 四层之下，用户原话是「在设置界面没看到你这个插件……怎么改？我一点都不知道」。
		  // 日记目录、语气、思考这些是要随手改的，必须在设置第一层就能点开。
		  // settings.section 是 root 作用域的 list 槽，ownerProps 只有 close；id 必须用我们自己的。
		  ctx.effect(
		    () =>
		      ctx.slots.inject('settings.section', () =>
		        ctx.slots.register(
		          {
		            name: 'settings.section',
		            id: 'ai-waifu-settings-page',
		            order: 140,
		            label: '大肥鱼的后台',
		          },
		          SettingsPage,
		        ),
		      ),
		    'dsh-pet-cuteness-plugin: settings page',
		  )
		}

		exports.apply = apply
		exports.inject = ['slots']
		exports.core = core
		// 卸载清理：宿主销毁插件时调用，把本插件写过的 localStorage 抹掉。
		// 用户的原话是「卸了重装她还带着上次的冷却记录，重装第一天就是哑的」。
		exports.clearLocalState = clearPrefs
		return module.exports
	},
})
