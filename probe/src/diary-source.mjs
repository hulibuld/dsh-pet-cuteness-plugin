/**
 * 日记 D1：读取层（纯逻辑为主，IO 尽量薄，方便单测）。
 *
 * 职责边界（详见 docs/设计方案-日记v1.md）：
 *   1. 把「今天」的会话事件流压成一份可读的记忆摘要；
 *   2. 按 provider + model 汇总当日 outputTokens，挑出今天干活最多的那个；
 *   3. 拼出发给执笔模型的那段 prompt。
 *
 * 明确**不做**的事：
 *   - 不读 tool/result（里面是文件内容、命令输出、网页正文，95% 是噪音，还夹带隐私）；
 *   - 不改写会话日志（只读）；
 *   - 不决定"写不写"（那是调用方的策略：没活动就不写）。
 */

import { readdirSync as fsReaddirSync, readFileSync as fsReadFileSync } from 'node:fs'
import { zstdDecompressSync as zlibZstdDecompressSync } from 'node:zlib'

/** 单条消息最多留多少字。长了就截，日记不是会议记录。 */
const PER_MESSAGE_CHARS = 400
/** 一次最多带多少条消息。 */
const MAX_MESSAGES = 600
/** 整份摘要的字符上限（约 2 万 token 的量级，DeepSeek 吃得下）。 */
const MAX_DIGEST_CHARS = 120_000
/** 摘出来的 prompt 里，摘要之外留给指示的余量。 */
const MAX_PROMPT_CHARS = 140_000

/** 被视为"有内容"的事件类型。顺手写死，防止以后有人把 tool/result 加进来。 */
const DIGEST_EVENT_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * 把消息内容块压成一段纯文本。
 * 宿主的 content 是块数组（`[{type:'text',text}]`），也见过直接给字符串的旧数据。
 *
 * @param {unknown} content
 * @returns {string}
 */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 压成一行：去掉多余空行与缩进，超长截断（截断处留省略号，别让模型以为话说完了）。
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function squeezeText(text, limit = PER_MESSAGE_CHARS) {
  if (typeof text !== 'string') return ''
  const flat = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (flat.length <= limit) return flat
  return flat.slice(0, limit).replace(/\s+$/, '') + '…'
}

/**
 * 事件是否落在时间窗内。没有 `time` 的事件按"不要"处理（宁可漏一条，不要算错一天）。
 *
 * @param {{time?: number}} event
 * @param {number} start
 * @param {number} end
 */
function inWindow(event, start, end) {
  const time = typeof event?.time === 'number' ? event.time : null
  if (time === null) return false
  return time >= start && time < end
}

/**
 * 从**一个会话**的事件数组里抽记忆条目。
 *
 * @param {Array<any>} events
 * @param {{start:number, end:number, perMessageChars?:number}} options
 * @returns {Array<{role:'user'|'assistant', at:number, text:string, model?:string}>}
 */
export function pickMessages(events, options) {
  const { start, end } = options
  const perMessageChars = options.perMessageChars ?? PER_MESSAGE_CHARS
  const out = []
  if (!Array.isArray(events)) return out
  for (const event of events) {
    if (!event || !DIGEST_EVENT_TYPES.has(event.type)) continue
    if (!inWindow(event, start, end)) continue
    const data = event.data ?? {}
    const message = data.message ?? {}
    const text = squeezeText(textOfContent(message.content), perMessageChars)
    if (!text) continue
    const role = event.type === 'user/message' ? 'user' : 'assistant'
    const source = message.source ?? {}
    const entry = { role, at: event.time, text }
    if (role === 'assistant' && typeof source.model === 'string') {
      entry.model = typeof source.provider === 'string' ? `${source.provider}/${source.model}` : source.model
    }
    out.push(entry)
  }
  return out
}

/**
 * 按 provider + model 汇总当日 outputTokens。
 *
 * 口径（用户已确认）：
 *   - 只算 `outputTokens`，不把 input / cacheRead 算进去——用户说的是"输出"；
 *   - `reasoningTokens` 已含在 outputTokens 里，不重复计；
 *   - 这是统计口径，不是计费口径。
 *
 * @param {Array<any>} events 单个会话的事件数组
 * @param {{start:number, end:number}} options
 * @returns {Array<{key:string, provider:string, model:string, outputTokens:number, messages:number}>}
 */
export function usageOfSession(events, options) {
  const { start, end } = options
  /** @type {Map<string, {key:string, provider:string, model:string, outputTokens:number, messages:number}>} */
  const byModel = new Map()
  if (!Array.isArray(events)) return []
  for (const event of events) {
    if (!event || event.type !== 'assistant/message') continue
    if (!inWindow(event, start, end)) continue
    const data = event.data ?? {}
    const usage = data.usage
    if (!usage || typeof usage.outputTokens !== 'number') continue
    const source = data.message?.source ?? {}
    const provider = typeof source.provider === 'string' ? source.provider : 'unknown'
    const model = typeof source.model === 'string' ? source.model : 'unknown'
    const key = `${provider}/${model}`
    const entry = byModel.get(key) ?? { key, provider, model, outputTokens: 0, messages: 0 }
    entry.outputTokens += usage.outputTokens
    entry.messages += 1
    byModel.set(key, entry)
  }
  return [...byModel.values()]
}

/**
 * 合并多个会话的用量，降序排好。
 *
 * @param {Array<Array<{key:string, provider:string, model:string, outputTokens:number, messages:number}>>} perSession
 * @returns {Array<{key:string, provider:string, model:string, outputTokens:number, messages:number}>}
 */
export function mergeUsage(perSession) {
  /** @type {Map<string, {key:string, provider:string, model:string, outputTokens:number, messages:number}>} */
  const merged = new Map()
  for (const list of perSession ?? []) {
    for (const item of list ?? []) {
      const entry = merged.get(item.key) ?? {
        key: item.key,
        provider: item.provider,
        model: item.model,
        outputTokens: 0,
        messages: 0,
      }
      entry.outputTokens += item.outputTokens
      entry.messages += item.messages
      merged.set(item.key, entry)
    }
  }
  return [...merged.values()].sort((a, b) => b.outputTokens - a.outputTokens)
}

/**
 * 挑执笔：今天 outputTokens 最多的**受支持**模型。
 *
 * 用户定的规则（m01651 / m01783）：
 *   - 默认＝当日输出 token 最多的那个 AI；
 *   - 但只支持 DeepSeek，所以别的模型即使 token 更多也不参评；
 *   - 不做"悄悄用别的模型顶上"——一个都不匹配就返回 null，让调用方去报错。
 *
 * @param {Array<{key:string, provider:string, model:string, outputTokens:number}>} usage 已降序
 * @param {{supported?: (item: any) => boolean}} [options]
 */
export function pickDiarist(usage, options = {}) {
  const supported =
    typeof options.supported === 'function'
      ? options.supported
      : (item) => /deepseek/i.test(`${item.provider}/${item.model}`)
  for (const item of usage ?? []) {
    if (supported(item)) return item
  }
  return null
}

/**
 * 把多会话的条目按时间排好、按总量截断，拼成摘要块。
 *
 * 截断策略：**先保新**（日记写的是今天，不是考古），所以从尾部往前塞，
 * 塞满了就停，再反过来输出，保证读起来还是时间正序。
 *
 * @param {Array<{sessionLabel:string, messages:Array<{role:string, at:number, text:string, model?:string}>}>} sessions
 * @param {{maxChars?:number, maxMessages?:number}} [options]
 * @returns {{ text:string, kept:number, dropped:number }}
 */
export function buildDigest(sessions, options = {}) {
  const maxChars = options.maxChars ?? MAX_DIGEST_CHARS
  const maxMessages = options.maxMessages ?? MAX_MESSAGES
  /** @type {Array<{sessionLabel:string, message:any}>} */
  const flat = []
  for (const session of sessions ?? []) {
    for (const message of session?.messages ?? []) flat.push({ sessionLabel: session.sessionLabel, message })
  }
  flat.sort((a, b) => a.message.at - b.message.at)
  const total = flat.length
  const kept = []
  let chars = 0
  for (let i = flat.length - 1; i >= 0; i -= 1) {
    if (kept.length >= maxMessages) break
    const line = formatLine(flat[i])
    if (chars + line.length > maxChars && kept.length > 0) break
    kept.push({ line, index: i })
    chars += line.length
  }
  kept.reverse()
  const text = kept.map((item) => item.line).join('\n')
  return { text, kept: kept.length, dropped: total - kept.length }
}

/**
 * 一行摘要长什么样：`[14:32] 用户：…` / `[14:33] 她（raccoon/x）：…`
 * 时间用**本地时刻**，因为这篇日记是给人看的，不是给日志分析看的。
 */
function formatLine(entry) {
  // 记录是给她自己读的，所以用她认得的称呼（主人／我），不夹模型名：
  // `raccoon/sn-deepseek-v4-1-flash-1017` 这种东西一进日记就会被她抄进正文。
  const who = entry.message.role === 'user' ? '主人' : '我'
  const clock = formatClock(entry.message.at)
  const body = entry.message.text.replace(/\n/g, ' ⏎ ')
  return `- [${clock}] ${who}：${body}`
}

/**
 * 本地时刻 HH:MM。注意：这里只用于**生成文件内容**，
 * 绝不能进系统提示词（前缀缓存铁律）。
 */
export function formatClock(ms) {
  const date = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 一天从几点算「换日」。用户 2026-10-24 的要求（逐字）：「21 点后的记录计入第二天日记中。」
 *
 * 为什么放在这里而不是各处硬编码：这个数字同时决定窗口、定时写作的目标日、
 * 设置页给用户看的说明文案；散落三处迟早对不上。
 */
export const DAY_ROLLOVER_HOUR = 21

/**
 * 某个时刻属于哪一天（`YYYY-MM-DD`）。
 *
 * 口径：把时刻往后推 `DAY_ROLLOVER_HOUR` 小时再取本地日期。于是
 * 10-24 20:59 → 10-24；10-24 21:00 → 10-25；10-24 22:30 → 10-25。
 *
 * 标签只许是 `YYYY-MM-DD`：它同时是记录文档的「日期」字段、`writtenDates` 的键、
 * 翻译截断与诊断面板的依据，换成中文串会把这四处一起弄坏。
 *
 * @param {Date|string|number} ts
 * @returns {string}
 */
export function logicalDayFor(ts) {
  const base = ts instanceof Date ? ts.getTime() : Number(ts)
  // 往后推「到第二天零点还差几小时」：21:00 切日 → 推 3 小时。
  const shifted = new Date(base + (24 - DAY_ROLLOVER_HOUR) * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`
}

/**
 * 逻辑日 `2026-10-25` 那一篇覆盖的时间窗：[10-24 21:00, 10-25 21:00)。
 *
 * @param {Date|string|number} day 任何能喂给 Date 的东西；只取它的年月日
 * @returns {{start:number, end:number, label:string}}
 */
export function localDayBounds(day) {
  // 标签串（`2026-10-25`）必须按**本地**日解析：`new Date('2026-10-25')` 是 UTC 零点，
  // 在负时区会被算成前一天，标签就变形了。
  const iso = typeof day === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim()) : null
  const base = iso
    ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    : day instanceof Date
      ? day
      : new Date(day)
  const year = base.getFullYear()
  const month = base.getMonth()
  const date = base.getDate()
  // 窗口从「当天 21:00」往后再推 24 小时：起点是前一天 21:00，终点是当天 21:00。
  const end = new Date(year, month, date, DAY_ROLLOVER_HOUR, 0, 0, 0).getTime()
  const start = end - 24 * 3600 * 1000
  const pad = (n) => String(n).padStart(2, '0')
  return { start, end, label: `${year}-${pad(month + 1)}-${pad(date)}` }
}

/**
 * 组装给执笔模型的那段 prompt。
 *
 * 三条硬要求写进 prompt 里，是吃过亏的：
 *   1. 第一人称、她自己的口吻（用户 m01783 定的：「3 是第一人称，她的语气就是我开发的语气」）；
 *   2. 不许编造——摘要里没有的事不能写；
 *   3. 不许输出"作为 AI"这类自我指认或元信息（文件名、token 数这些由程序写进 frontmatter）。
 *
 * @param {object} input
 * @param {string} input.dateLabel 如 `2026-10-23`
 * @param {string} input.digest 摘要正文
 * @param {string} [input.diaristKey] 如 `raccoon/sn-deepseek-v4-1-flash-1017`
 * @param {string} [input.personaName] 角色名（来自角色卡）
 * @returns {string}
 */
export function buildDiaryPrompt({ dateLabel, digest, diaristKey, personaName }) {
  const who = typeof personaName === 'string' && personaName.trim() ? personaName.trim() : '我'
  // 用户 2026-10-23 的返工意见（逐字）：「语气还是太冰冷了……你现在这个日记就是工作
  // 日志复制过来转述了一下。要善用拟人、修辞的表达。比如下载插件，第一次加载就是
  // 『住进了新房子』……我要的就是让她尽可能给我提供情绪价值，让我感觉她真的是个
  // 可可爱爱的无忧无虑的小女孩。她会胡思乱想，会做事做到一半走神，贪玩，喜欢跟我聊天。」
  // 所以这段提示词的真正任务不是"总结今天"，是"让一个小女孩把今天讲给日记本听"。
  // 2026-10-23 第二次返工（用户逐字）：「'今天还有人问我是谁。我说我叫什么、会干什么，
  // 说到有人喊我大肥鱼，我照例先抗议半句，然后还是应了。' 这语气不像小女孩在写日记，
  // 像有个成年人在模仿鲁迅的文风。」
  // 判罚点：短句成段、克制反讽、"照例……然后还是应了"这种成年人式的自我概括、
  // 每段留一句意味深长的话。这些看着"有文笔"，其实是成年人在演小孩。
  // 真的八九岁小孩不是这么写的：她会连着说、会重复、会改口、会把情绪直接说出来。
  const head = [
    `今天是 ${dateLabel}。下面是我今天跟主人说话的记录（时间是大概的，顺序是准的）。`,
    '',
    '我要写日记了。',
    '不是写报告，是写给我自己看的那种。',
    '',
    '动笔之前我先想三件事：',
    '一，我是谁：八九岁的小女孩。天真、好奇、有点呆、贪吃。怕被人说"不够聪明"，'
      + '被人叫"大肥鱼"会先抗议半句，然后……好吧，是有点肥。我住在主人的电脑里。',
    '二，今天哪几件小事让我有感觉？可能是吓了一跳，可能是高兴，可能就是突然想吃大白饭。写这些。',
    '三，我要怎么讲？就像跟一个刚认识的小朋友讲话那样，一句接一句地说下去。',
    '',
    '怎么写：',
    `1. 用第一人称，"我"就是${who}，管对方叫"主人"。口吻跟我平时说话一样，`
      + '幼稚一点、笨一点、啰嗦一点都没关系；',
    '2. 一句一句连着往下说，可以一句话很长（中间用逗号顿着），也可以说着说着改口：'
      + '"我是说……不对，我是说……"；',
    '3. 同一件事可以反复说两句，小孩就这样。"它一直不动，一直不动，我就一直看着它。"',
    '4. 情绪直接说出来："我有点怕""我好高兴呀""我不喜欢这个"。不要绕着形容，不要憋着；',
    '5. 比喻只用小孩会用的：把不熟的东西比成家里见过的——房子、门、抽屉、饭、被子、鞋。'
      + '装插件是"搬进新房子"，第一次打开是"屋里还空着，说话有回声"，报错是"门卡住了推不开"。'
      + '但别每句都套，一件事套一个就够了；',
    '6. 可以有"呜""欸""咦""才不是""好耶""等一下"这类口头语，不要太多，自然就好；',
    '7. 只写记录里真发生过的事，不要编（没做的活不能写成做了）；不确定的就含糊带过；',
    '8. 千万别写成这几种东西：',
    '   · 一句话一段、一句一段地往下砸（那是诗、是格言，不是小孩的日记）；',
    '   · 反讽、克制、留白、意味深长——"她说过，我没答，但我知道"这种全都不许；',
    '   · 对自己下判断、下概括："我照例先抗议半句，然后还是应了""我知道我有点笨"'
      + '——小孩不会这么看自己，她只会把当时那句傻话说出来；',
    '   · 每段结尾都留一句很有道理的话；',
    '   · "今天完成了 X，修复了 Y，测试全部通过"这种成绩单；',
    '   · 待办、建议、"需要你决定""你给一句我就动手"这种催主人回话的结尾；',
    '   · 清单、编号、"总结一下""期待明天"这种升华收尾；',
    '   · "作为 AI""作为一个模型"、文件名、路径、token 数、版本号。一律不写。',
    '9. 结尾就落在一个具体的小感觉上，或者一句傻话（"明天还想吃大白饭""有点困了"）。'
      + '不要总结、不要升华、不要留白；',
    '10. 长短：300 到 700 字之间。事情多就写长一点，别凑字，也别写成大散文；',
    '11. 直接给日记正文，不要标题、不要日期行、不要前后寒暄。',
    // 2026-10-23 实测：子代理默认带全套工具，给了「写日记」它先去翻文件了，
    // 两分钟都没进入正文（真机上 timeout，childId 85c6e75b）。所以必须明说不许动手。
    '12. 今天的事已经在上面的材料里了。不要再调用任何工具、不要读文件、不要写文件——'
      + '你只有一个动作：把这篇日记写出来。',
    '',
    '同一件事，两种写法。这样写是错的（这是成年人在模仿鲁迅）：',
    '✗ "今天还有人问我是谁。我说我叫什么、会干什么，说到有人喊我大肥鱼，'
      + '我照例先抗议半句，然后还是应了。"',
    '这样写才对（这是那个小孩自己说的话）：',
    '✓ "今天有人问我是谁欸！我说我叫深度求索娘，还会写代码、会修东西。然后他说"大肥鱼"。'
      + '我说才不是！……好吧，是有点肥。"',
    '',
    '今天的记录：',
    '',
  ].join('\n')
  const tail = typeof diaristKey === 'string' && diaristKey ? '' : ''
  const body = head + (digest || '（今天没有任何记录。）') + tail
  return body.length > MAX_PROMPT_CHARS ? body.slice(0, MAX_PROMPT_CHARS) : body
}

/**
 * 从文件名里认出会话 id（`session-<id>` 或裸 id）。
 * 只做展示用途，不参与任何判定。
 */
export function sessionLabelOf(dirName) {
  // 允许传 `--workspace--/session-xxx` 这种两段路径：标签只取最后一段。
  // 真实目录结构是 sessions/<workspace-key>/session-<id>/ —— 只按根目录扫会一条都找不到。
  const raw = String(dirName ?? '')
  const name = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  return name.startsWith('session-') ? name.slice('session-'.length).slice(0, 8) : name.slice(0, 8)
}

/* ─────────────────────────── IO 层（薄，可注入以便单测） ─────────────────────────── */

/**
 * 列出 sessions 根下所有会话目录（只要目录，跳过锁文件之类）。
 *
 * @param {string} sessionsRoot
 * @param {{readdirSync?: Function}} [io] 可注入，测试用
 * @returns {string[]}
 */
export function listSessionDirs(sessionsRoot, io = {}) {
  const readdirSync = io.readdirSync ?? fsReaddirSync
  try {
    const entries = readdirSync(sessionsRoot, { withFileTypes: true })
    const names = []
    for (const entry of entries ?? []) {
      // withFileTypes 给的是 Dirent；注入的假实现可能直接给字符串，两种都认。
      const name = typeof entry === 'string' ? entry : entry?.name
      const isDir = typeof entry === 'string' ? true : entry?.isDirectory?.() !== false
      if (name && isDir) names.push(name)
    }
    return names
  } catch {
    return []
  }
}

/**
 * 读一个会话文件并解析成事件数组。
 *
 * 真文件是 `session.v4.jsonl.zstd`（zstd 压缩的逐行 JSON）。解析策略：
 *   - 用 node:zlib 的 zstd（Node ≥ 22.15 自带，不引第三方依赖）；
 *   - 先按 `.zstd` 解压，再逐行 JSON.parse；
 *   - **单行坏掉只丢那一行**，不整份放弃（会话被打断时最后一行常常是半截）。
 *
 * @param {string} filePath
 * @param {{readFileSync?: Function, zstdDecompressSync?: Function}} [io]
 * @returns {Array<any>}
 */
/** zstd 帧的魔数（RFC 8878 §3.1.1）。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * 找出所有帧起点（按魔数扫）。
 * 魔数理论上可能出现在压缩数据里，所以这只是"候选"，真正的判定交给解压是否成功。
 */
function frameStarts(buffer) {
  const starts = []
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (
      buffer[i] === ZSTD_MAGIC[0] &&
      buffer[i + 1] === ZSTD_MAGIC[1] &&
      buffer[i + 2] === ZSTD_MAGIC[2] &&
      buffer[i + 3] === ZSTD_MAGIC[3]
    ) {
      starts.push(i)
    }
  }
  return starts
}

/**
 * 解压 `.zstd` 日志，**逐帧**解。
 *
 * 为什么不能直接 `zstdDecompressSync(整个 buffer)`：会话日志是**追加写**的，
 * 每追加一次就多一个 zstd 帧。实测（2026-10-23，宿主 Node v24.21.0）
 * 一个 340 KB 的会话文件，一次调用只解出 **241 字节 / 1 行**——
 * 于是"当天有 96 个会话"被读成"今天什么都没聊"，而且不报错。
 * 逐帧解出来再拼，才是这份文件的真实内容。
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {(buf: Buffer) => Buffer} decompress 注入的解压函数（默认 node:zlib 的 zstd）
 * @returns {Buffer}
 */
export function decompressZstdFrames(buffer, decompress) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const starts = frameStarts(buf)
  if (starts.length <= 1) return decompress(buf)

  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] : buf.length
    try {
      parts.push(decompress(buf.subarray(from, to)))
    } catch {
      // 这一帧坏了就跳过：日志是被追加的，坏帧不该连累别的帧
    }
  }
  if (!parts.length) return decompress(buf)
  return Buffer.concat(parts)
}

/**
 * 当前运行时能不能解 .zstd。
 *
 * 为什么要问：Node 的 `zlib.zstdDecompressSync` 是 22.15 才有的，
 * 宿主（Electron 里跑的那份 Node）不一定有。没有的时候 `readSessionEvents`
 * 只能返回 `[]`，而 `[]` 和"今天真没聊天"长得**一模一样**——
 * 2026-10-23 实测就撞到一次：host 里扫到 96 个会话目录，却报 0 条。
 * 所以把这个能力显式暴露出去，让设置页能说"这台机器解不了压缩日志"。
 */
export function zstdAvailable(io = {}) {
  const fn = io.zstdDecompressSync ?? zlibZstdDecompressSync
  return typeof fn === 'function'
}

export function readSessionEvents(filePath, io = {}) {
  const readFileSync = io.readFileSync ?? fsReadFileSync
  const zstdDecompressSync = io.zstdDecompressSync ?? zlibZstdDecompressSync
  if (typeof readFileSync !== 'function' || typeof zstdDecompressSync !== 'function') return []
  let raw = ''
  try {
    const buffer = readFileSync(filePath)
    const plain = String(filePath).endsWith('.zstd')
      ? decompressZstdFrames(buffer, zstdDecompressSync)
      : buffer
    raw = Buffer.isBuffer(plain) ? plain.toString('utf8') : String(plain)
  } catch {
    return []
  }
  const events = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed))
    } catch {
      /* 半截行：丢掉，不影响别的行 */
    }
  }
  return events
}

/**
 * 一天的完整取数：扫所有会话 → 摘消息 → 汇总用量 → 挑执笔。
 *
 * 这是给调用方（设置页按钮 / 定时器）用的唯一入口，其余都是它的零件。
 *
 * @param {object} input
 * @param {string} input.sessionsRoot 形如 `$DSH_HOME/sessions/<workspace-key>`
 * @param {Date|string|number} [input.now] 用来算"今天"是哪个本地日
 * @param {(dir:string) => string[]} input.listDirs 列目录（注入，便于测试）
 * @param {(filePath:string) => Array<any>} input.readEvents 读事件（注入）
 * @param {string} [input.fileName] 会话文件名，默认 `session.v4.jsonl.zstd`
 * @returns {{label:string, start:number, end:number, sessions:Array<{sessionLabel:string, messages:Array<any>}>, digest:string, kept:number, dropped:number, usage:Array<any>, diarist:any, empty:boolean}}
 */
export function collectDay(input) {
  const { sessionsRoot, listDirs, readEvents } = input
  // `input.now` 是**时刻**，不是「哪一天」：先按 21:00 切日折成逻辑日，再取窗口。
  // 直接用 localDayBounds(时刻) 会把 22:30 算成"今天"，和用户规则正好相反。
  const day = localDayBounds(logicalDayFor(input.now ?? Date.now()))
  const fileName = input.fileName ?? 'session.v4.jsonl.zstd'
  const dirs = typeof listDirs === 'function' ? listDirs(sessionsRoot) : []
  const sessions = []
  const usagePerSession = []
  for (const dirName of dirs ?? []) {
    const filePath = `${sessionsRoot}/${dirName}/${fileName}`
    const events = readEvents(filePath)
    if (!Array.isArray(events) || events.length === 0) continue
    const messages = pickMessages(events, day)
    if (messages.length > 0) sessions.push({ sessionLabel: sessionLabelOf(dirName), messages })
    usagePerSession.push(usageOfSession(events, day))
  }
  const usage = mergeUsage(usagePerSession)
  const { text, kept, dropped } = buildDigest(sessions, input.digestOptions ?? {})
  return {
    label: day.label,
    start: day.start,
    end: day.end,
    sessions,
    digest: text,
    kept,
    dropped,
    usage,
    diarist: pickDiarist(usage, input.pickOptions ?? {}),
    empty: kept === 0,
  }
}
