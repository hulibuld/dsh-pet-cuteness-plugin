/**
 * 台词层（v1）：把模型**思考过程里的人话**摘出来，显示在输入框上方。
 *
 * 为什么不再手写台词库（2026-10-22 用户决策）：
 *   上一版打算给 dsh-pet 写 voice pack，估算下来 15 个角色卡要新写约 2500 条文案，
 *   而且 dsh-pet 的台词池只在启动时读一次、`announce` 又只认余额/花费/配额三种 kind，
 *   写着也推不到屏幕上。用户的原话是「把 AI 在思维链里面的一些思考过程和语气词直接
 *   放到会话框里面」——所以台词层不造新内容，**只摘模型自己说过的话**。
 *
 * 这个模块是纯函数 + 一个内存环形缓冲，不 import 任何宿主包、不发网络请求。
 * 接线在 `index.js`（订阅 reasoning 流），显示在浏览器半（输入框上方气泡）。
 *
 * 三条硬纪律：
 *   1. **不改写、不追加请求**：只读 reasoning-delta 的文本，零成本、零幻觉风险。
 *   2. **绝不进系统提示词**：台词是输出侧的装饰，混进提示词会打穿前缀缓存。
 *   3. **摘不出来就不说话**：宁可一条不显示，也不要显示 "让我检查一下 config.json"。
 *      这条最要紧——技术句一旦漏出去，"她在嘀咕"立刻变成"她在念日志"。
 */

/** 摘句规则的数值。测试与 UI 都读这一份，别各写一份魔数。 */
export const LINE_LIMITS = Object.freeze({
  /** 太短的不是话（"嗯" 只有 1 个字，但它恰恰是最像人的——所以下限给 2） */
  minLength: 2,
  /** 太长的不是嘀咕，是段话。输入框上方一条气泡装不下 */
  maxLength: 30,
  /** 一个 model step 最多出几句：多了会刷屏，反而像故障 */
  perStep: 3,
  /** 每个会话留多少句（浏览器半按 cursor 递增拉取，留多了只是浪费内存） */
  bufferSize: 40,
  /** 同一句话多久之内不再重复（毫秒）。20 分钟：一整天不重复 */
  dedupeWindowMs: 20 * 60 * 1000,
  /** 相邻两句最短间隔（毫秒）。1.5 秒：两条连着闪会看不清 */
  minGapMs: 1500,
})

/**
 * 语气词与"人味"标记。命中就加分——这是得分项而不是过滤项：
 * 我们不是在找关键词，是在**从一堆文言般的推理里挑更像人话的那句**。
 */
export const MOOD_MARKERS = Object.freeze([
  '嗯',
  '唔',
  '啊',
  '诶',
  '欸',
  '咦',
  '哦',
  '呀',
  '吧',
  '呢',
  '啦',
  '嘛',
  '唉',
  '哎呀',
  '糟糕',
  '好耶',
  '不对',
  '等等',
  '好像',
  '大概',
  '有点',
  '其实',
  '让我想想',
  '是不是',
  '会不会',
])

/** 第一人称：出现就是"她在说话"，不是"文档在陈述"。 */
const FIRST_PERSON = Object.freeze(['我', '咱'])

/**
 * 判"技术味"：命中任何一条就整句丢掉。
 *
 * 这些字符出现在推理里通常意味着后面跟着一段代码、路径、URL、JSON 或参数表，
 * 读出来只会让用户以为插件坏了。
 */
const TECHNICAL_CHARS = Object.freeze([
  'http',
  '/',
  '\\',
  '：',
  ':',
  '=',
  '{',
  '}',
  '<',
  '>',
  '`',
  '#',
  '*',
  '|',
  '→',
  '->',
  '()',
  '[]',
])

/**
 * 句子切分：先按"话完了"，再按逗号切长句。
 *
 * ⚠️ 用 lookbehind 把**标点留在句尾**，不用 split 把标点吃掉。
 * 这条不是洁癖：吃标点会把「诶？」切成一个「诶」（1 个字，被长度下限过滤掉），
 * 而「诶？」恰恰是最像"她在嘀咕"的一句话。第一次实跑就踩到了这个坑。
 */
const SENTENCE_BREAKERS = /(?<=[。！？；…!?;\n])\s*/
const CLAUSE_BREAKERS = /(?<=[，,、])\s*/
/**
 * 二级切分：一个分句还是太长时，在冒号/破折号处再切一刀。
 *
 * 2026-10-24 拿真实会话日志回放时看到的：`tooLong` 一档就吃掉七千多个候选，
 * 大头是「一句话里带个冒号，后半截是代码/列表」——整条按 30 字上限丢掉，
 * 前半截本来完全可以说。切一刀之后前半截独立判，后半截照样被技术味闸拦掉。
 */
const SECONDARY_BREAKERS = /(?<=[：:—–])\s*/u

/**
 * 英文句号也是句子边界——**但必须后面跟空白**。
 *
 * 2026-10-24 回放真实会话时撞到的最大一档：本机模型现在整段用英文推理，
 * 而原来的句子边界表里只有中文标点和 `!?;`，没有 `.`。于是一整段英文推理
 * 从头到尾切不开，变成一条 400 字的"分句"→ 被判 tooLong → 全丢。
 * 要求后面跟空白，是为了不把 `index.js`、`v1.2`、`config.json` 切碎。
 */
const ASCII_SENTENCE_BREAKERS = /(?<=[.!?])\s+/

/**
 * 英文语气词白名单。
 *
 * 为什么需要它：模型有时整段用英文推理（本机 upgrade 之后实测 139k 字母 vs 3.9k 汉字），
 * 而「英文占比 > 50% 判技术味」这条闸会把 "Hmm." "Wait." "Okay." 全判死——
 * 于是推理帧成千上万，一句台词都摘不出来，只剩角色卡台词在顶上。
 * 这几句恰恰是"她在嘀咕"，放行不放行属于可读性判断，不属于技术味判断。
 * 白名单刻意只收语气词：`import React from react` 这种一个词都进不来。
 */
export const INTERJECTIONS = Object.freeze([
  'hmm',
  'hm',
  'huh',
  'wait',
  'oh',
  'ah',
  'ok',
  'okay',
  'well',
  'no',
  'nope',
  'yes',
  'yeah',
  'right',
  'fine',
  'actually',
  'maybe',
  'sure',
  'good',
  'nice',
  'wow',
  'oops',
  'sorry',
  'alright',
  'now',
  'hmm',
])

/**
 * 一句**正常长度的英文独白**能不能当台词。
 *
 * 为什么要放行：本机模型整段用英文推理，实测一整场对话只有 3.9k 汉字对 139k 字母。
 * 若坚持"英文占比 > 50% 一律判技术味"，那推理流再通，气泡也几乎永远是空的，
 * 用户看到的就是"气泡跟我的工作任务无关"——因为只剩角色卡在说话。
 *
 * 边界卡得很死：4–8 个词、句首大写、只含字母与撇号、没有数字、没有全大写标识符。
 * 于是 "Let me load the relevant skills."（她自己真的这么想）能过，
 * "settings page"（碎片）、"config.json"（路径）、"ABCDEF"（标识符）都过不了。
 * @param {string} text 已 tidy 的句子
 * @returns {boolean}
 */
export function looksLikePlainEnglish(text) {
  if (typeof text !== 'string' || !text) return false
  if (text.length > LINE_LIMITS.maxLength) return false
  if (!/^[A-Z][A-Za-z'’ ]*[.!?]?$/.test(text)) return false
  const words = text.replace(/[.!?]$/, '').trim().split(/\s+/).filter(Boolean)
  if (words.length < 4 || words.length > 8) return false
  for (const word of words) {
    if (word.length > 1 && word === word.toUpperCase()) return false
  }
  return true
}

/**
 * 整句是否只是"一声哼"：全英文语气词，没有别的词。
 * @param {string} text 已 tidy 的句子
 * @returns {boolean}
 */
export function looksLikeMutter(text) {
  if (typeof text !== 'string' || !text) return false
  if (text.length > 16) return false
  if (!/^[A-Za-z'’\-\s,.!?]+$/.test(text)) return false
  const words = text.toLowerCase().replace(/[,.!?'’\-]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || words.length > 2) return false
  return words.every((word) => INTERJECTIONS.includes(word))
}

/**
 * 去掉干扰字符：markdown 列表符、引号、括号、多余空白。
 *
 * 只做"外面一层"的清理，不动句子内部——内部的文字是模型的原话，
 * 改一个字就不再是"她自己说的"了。
 *
 * @param {string} raw
 * @returns {string}
 */
export function tidyLine(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw.replace(/\s+/g, ' ').trim()
  // 列表符/编号：`- `、`* `、`1. `、`（1）`
  text = text.replace(/^[-*+>]\s+/, '')
  text = text.replace(/^\(?\d{1,2}[).、]\s*/, '')
  // 外层包裹：引号、书名号、括号、方括号（成对时）
  let changed = true
  while (changed && text.length > 2) {
    changed = false
    const pairs = [
      ['「', '」'],
      ['『', '』'],
      ['“', '”'],
      ['‘', '’'],
      ['"', '"'],
      ['(', ')'],
      ['（', '）'],
      ['[', ']'],
      ['【', '】'],
    ]
    for (const [open, close] of pairs) {
      if (text.startsWith(open) && text.endsWith(close) && text.length > 2) {
        text = text.slice(open.length, text.length - close.length).trim()
        changed = true
      }
    }
  }
  // 尾随的逗号/顿号要剥掉：「嗯，」「这里好像不对，」读出来会多半个停顿。
  // 句号/问号/叹号保留——它们正是"语气"的一部分。
  text = text.replace(/[，,、]+$/, '').trim()
  // 落单的引号/括号：上面只剥成对的，单个的会留在句首句尾（实跑里出现过 `"嗯`）。
  // 气泡里带半个引号看起来像坏掉了，所以边缘的引号一律清掉。
  const EDGE_QUOTES = /^["'“”‘’「」『』【】（）()\[\]]+/
  const EDGE_QUOTES_END = /["'“”‘’「」『』【】（）()\[\]]+$/
  text = text.replace(EDGE_QUOTES, '').replace(EDGE_QUOTES_END, '').trim()
  return text
}

export const REJECTION_KEYS = Object.freeze([
  'tooShort',
  'tooLong',
  'technical',
  'dup',
  'perStep',
  'noBoundary',
  'gap',
  'other',
])

/** 一份全零的拒绝原因账本；`/debug` 直接展开它。 */
export function emptyRejections() {
  const out = {}
  for (const key of REJECTION_KEYS) out[key] = 0
  return out
}

/**
 * 每一档留几条**样本**（原句前 40 字）。
 *
 * 只有计数还是得靠猜"到底哪类句子被吃了"：`tooLong` 44 条，是代码块还是长句？
 * 样本能把下一轮从"统计推断"变成"看现场"。只留 3 条，不涨内存也不泄多。
 */
const SAMPLE_LIMIT = 3
const SAMPLE_CHARS = 40

/**
 * @param {object} stats
 * @param {string} reason
 * @param {string} line
 */
function recordSample(stats, reason, line) {
  if (!stats || typeof stats !== 'object') return
  if (!stats.samples || typeof stats.samples !== 'object') stats.samples = {}
  const bucket = Array.isArray(stats.samples[reason]) ? stats.samples[reason] : (stats.samples[reason] = [])
  const text = String(line ?? '').slice(0, SAMPLE_CHARS)
  if (!text || bucket.length >= SAMPLE_LIMIT) return
  if (bucket.includes(text)) return
  bucket.push(text)
}

/**
 * 保证 `stats.rejected` 存在且字段齐全（老 stats 对象也能补全，不抛）。
 * @param {object} target
 * @returns {Record<string, number>}
 */
function ensureRejections(target) {
  if (!target || typeof target !== 'object') return emptyRejections()
  if (!target.rejected || typeof target.rejected !== 'object') target.rejected = emptyRejections()
  const rejected = target.rejected
  for (const key of REJECTION_KEYS) {
    if (!Number.isFinite(rejected[key])) rejected[key] = 0
  }
  return rejected
}

/**
 * 这句话**为什么**被拒（`null` = 可以显示）。
 *
 * 2026-10-24 用户报「气泡全是台词库」时，`/debug` 只有一个 pushed 总数，
 * 没人知道几千个推理帧到底死在哪一档。所以把 `isSpeakable` 的每一道闸拆成可数的原因——
 * 判定本身一个字没改，只是把它摊开。
 *
 * @param {string} line 已 tidy 的句子
 * @returns {null | 'tooLong' | 'tooShort' | 'other' | 'technical'}
 */
export function rejectionOf(line) {
  if (typeof line !== 'string') return 'other'
  const text = line.trim()
  if (!text) return 'tooShort'
  if (text.length > LINE_LIMITS.maxLength) return 'tooLong'
  // 长度下限，但单个语气词（「嗯」「诶」「唔」）要放行——
  // 「嗯」单独冒出来恰恰最像人在嘀咕，一律按 2 字下限砍掉是设计错误。
  const loneMood = text.length === 1 && MOOD_MARKERS.includes(text)
  if (text.length < LINE_LIMITS.minLength && !loneMood) return 'tooShort'
  // 纯标点/纯符号
  if (!/[\p{L}\p{N}]/u.test(text)) return 'other'
  const lower = text.toLowerCase()
  for (const bad of TECHNICAL_CHARS) {
    if (lower.includes(bad)) return 'technical'
  }
  // 数字打头：多半是列表项或计数
  if (/^\d/.test(text)) return 'other'
  // 一声英文哼（"Hmm." "Wait."）：不是技术词，是她真的在嘀咕
  if (looksLikeMutter(text)) return null
  // 一句正常长度的英文独白（"Let me load the relevant skills."）：同上
  if (looksLikePlainEnglish(text)) return null
  // 英文占比过高：那是代码或术语，不是她在嘀咕
  const ascii = (text.match(/[A-Za-z0-9]/g) ?? []).length
  if (ascii / text.length > 0.5) return 'technical'
  // 全大写的标识符
  if (/^[A-Z_]+$/.test(text)) return 'technical'
  return null
}

/**
 * 这句话能不能当台词显示。
 * @param {string} line 已经 tidy 过的句子
 * @returns {boolean}
 */
export function isSpeakable(line) {
  return rejectionOf(line) === null
}

/**
 * 给一句候选打分。分高者优；同分按出现顺序（稳定）。
 * @param {string} line
 * @returns {number}
 */
export function scoreLine(line) {
  const text = typeof line === 'string' ? line : ''
  let score = 0
  for (const marker of MOOD_MARKERS) {
    if (text.includes(marker)) score += 2
  }
  for (const pronoun of FIRST_PERSON) {
    if (text.includes(pronoun)) score += 1
  }
  if (/[？！?!]/.test(text)) score += 1
  // 4–20 字最像一句嘀咕；1 字太少，20 字以上开始像陈述
  if (text.length >= 4 && text.length <= 20) score += 1
  return score
}

/**
 * 把一段 reasoning 文本切成候选句。
 * @param {string} text
 * @param {{stats?: object}} [options] 传了就往 stats.rejected 里按原因计数
 * @returns {string[]} 已 tidy、已过滤的句子（保持原文顺序）
 */
export function splitCandidates(text, options = {}) {
  const rejected = options.stats ? ensureRejections(options.stats) : null
  if (typeof text !== 'string' || !text) return []
  if (
    rejected &&
    !SENTENCE_BREAKERS.test(text) &&
    !CLAUSE_BREAKERS.test(text) &&
    !ASCII_SENTENCE_BREAKERS.test(text)
  ) {
    // 整段没有句读：既切不出完整句，也就谈不上"太短/太长"。单独计一档，
    // 否则这一档会被混进 tooLong 里看不出来。
    rejected.noBoundary += 1
  }
  const out = []
  for (const sentence of text.split(SENTENCE_BREAKERS)) {
    if (!sentence.trim()) continue
    for (const part of sentence.split(ASCII_SENTENCE_BREAKERS)) {
      if (!part.trim()) continue
      for (const clause of part.split(CLAUSE_BREAKERS)) {
      if (!clause.trim()) continue
        // 太长就再切一刀（冒号/破折号），否则整条按 tooLong 丢掉，
        // 连前面那半句人话也一起没了。
        const pieces = tidyLine(clause).length > LINE_LIMITS.maxLength ? clause.split(SECONDARY_BREAKERS) : [clause]
        for (const piece of pieces) {
          if (!piece.trim()) continue
          const line = tidyLine(piece)
          const reason = rejectionOf(line)
          if (reason === null) out.push(line)
          else if (rejected) {
            rejected[reason] += 1
            recordSample(options.stats, reason, line)
          }
        }
      }
    }
  }
  return out
}

/**
 * 一步推理 → 最多 `limit` 句台词。
 *
 * 排序规则：先按分数取前 N，再**按原顺序**输出——气泡要按她真正想到的先后冒出来，
 * 分数只用来决定"哪几句值得说"。
 *
 * @param {string} text
 * @param {{limit?: number, stats?: object}} [options]
 * @returns {string[]}
 */
export function extractLines(text, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : LINE_LIMITS.perStep
  const rejected = options.stats ? ensureRejections(options.stats) : null
  const candidates = splitCandidates(text, options.stats ? { stats: options.stats } : {})
  if (candidates.length === 0) return []
  if (rejected && candidates.length > limit) {
    rejected.perStep += candidates.length - limit
    recordSample(options.stats, 'perStep', candidates.slice(limit).join(' / '))
  }
  const ranked = candidates
    .map((line, index) => ({ line, index, score: scoreLine(line) }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index))
    .slice(0, limit)
  return ranked.sort((a, b) => a.index - b.index).map((item) => item.line)
}

/**
 * 造一个按会话分桶的台词环形缓冲。
 *
 * 为什么要缓冲而不是直接推给浏览器：桥是**一问一答**的 HTTP，宿主没法主动推送。
 * 所以宿主这头排队，浏览器半长轮询拉取。这也是为什么台词是"装饰性"的：
 * 拉不到最多不说话，不能影响任何主流程。
 *
 * @param {object} [options]
 * @param {() => number} [options.now] 时间源（测试注入用）
 * @param {number} [options.bufferSize]
 * @param {number} [options.dedupeWindowMs]
 * @param {number} [options.minGapMs]
 */
/**
 * 台词尾巴上偶尔挂的颜文字。
 *
 * 用户要求：「台词和语气（即思考过程和回复里）可以加一些颜文字之类的」。
 * 语气那半边在系统提示词里已经写了（`src/persona-text.mjs` 的「颜文字」条款）；
 * 这一份是给**台词气泡**用的——模型思考时自己很少打颜文字，光靠摘原句就只有文字。
 *
 * 两条自我约束：
 *   1. 用**句子内容算出来的哈希**决定挂不挂、挂哪个，不用 `Math.random()`：
 *      同一句话永远得到同一个结果，好测、复现得出、刷新页面也不会跳。
 *   2. 只在句尾追加，不改原句一个字——台词必须还是"她真说过的那些字"。
 */
export const KAOMOJI = [
  '(｡･ω･｡)',
  '(>_<)',
  '(￣▽￣)',
  '(・ω・)',
  '(ˇωˇ)',
  '(๑•̀ㅂ•́)و',
  '(´-ω-)',
  '(๑>؂<๑)',
]

/** 句子 → 稳定的非负整数。只用来做"挂不挂 / 挂哪个"的决定。 */
function hashOf(text) {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0
  return Math.abs(hash)
}

/**
 * 给一句台词决定要不要挂颜文字。
 *
 * @param {string} line 已经通过 isSpeakable 的句子
 * @param {{ratio?: number}} [options] ratio = 挂的比例（0–1），默认 0.35
 * @returns {string}
 */
export function decorateLine(line, options = {}) {
  if (typeof line !== 'string' || !line) return line
  // 用户口径（m01783）：「颜文字可以多加，没必要定死」→ 默认比例从 0.35 提到 0.6。
  const ratio = typeof options.ratio === 'number' ? options.ratio : 0.6
  if (ratio <= 0) return line
  // 句子里已经有表情符号（模型自己打了）就不再叠一层，一屏两个笑脸很蠢。
  if (/[｡ωﾟ▽•̀ᴗ＾^＿◡◠]/.test(line)) return line
  const hash = hashOf(line)
  if (hash % 100 >= Math.round(ratio * 100)) return line
  return line + ' ' + KAOMOJI[hash % KAOMOJI.length]
}

export function createLineFeed(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const bufferSize = positiveInt(options.bufferSize, LINE_LIMITS.bufferSize)
  const dedupeWindowMs = positiveInt(options.dedupeWindowMs, LINE_LIMITS.dedupeWindowMs)
  const minGapMs = positiveInt(options.minGapMs, LINE_LIMITS.minGapMs, true)

  /** @type {Map<string, {seq: number, items: Array<{id:number,text:string,at:number}>, recent: Map<string, number>, lastAt: number, lastCursor: number}>} */
  const buckets = new Map()
  /** @type {Array<{sessionId: string, resolve: () => void}>} */
  const waiters = []
  /**
   * feed 自己的账本：入队句数 + 每一档拒绝原因。
   * `index.js` 的 `/debug` 直接读 `feed.stats`——它是"台词层到底怎么了"的唯一现场。
   */
  const feedStats = { pushed: 0, rejected: emptyRejections() }

  function bucketOf(sessionId) {
    const key = typeof sessionId === 'string' ? sessionId : ''
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { seq: 0, items: [], recent: new Map(), lastAt: 0, lastCursor: 0 }
      buckets.set(key, bucket)
    }
    return bucket
  }

  function wake(sessionId) {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].sessionId !== sessionId) continue
      const waiter = waiters.splice(i, 1)[0]
      try {
        waiter.resolve()
      } catch {
        /* 等的人已经走了 */
      }
    }
  }

  return {
    /**
     * 把一步推理的文本推进队列。返回这次真正入队的句子（便于日志与测试）。
     *
     * `opts.stats` 传进来就顺手记账：每次拒绝都落到 `stats.rejected.<原因>`。
     * 没有这本账，"/debug 上只有 pushed=21" 就只能靠猜是谁吃掉的（2026-10-24 实撞）。
     *
     * @param {string} sessionId
     * @param {string} text
     * @param {{limit?: number, stats?: object}} [opts]
     * @returns {string[]}
     */
    push(sessionId, text, opts = {}) {
      if (typeof sessionId !== 'string' || !sessionId) return []
      // 默认记到 feed 自己的账本：卡片垫句这类调用不传 stats，也不能成为账外黑影。
      const stats = opts.stats && typeof opts.stats === 'object' ? opts.stats : feedStats
      const rejected = ensureRejections(stats)
      const lines = extractLines(text, { limit: opts.limit, stats })
      if (lines.length === 0) return []
      const bucket = bucketOf(sessionId)
      const at = now()
      // 间隔限制是"这一次推送"的属性，不是"每一句"的属性。
      // 老写法把闸门放在循环里、用 accepted.length === 0 当条件，结果一旦这次推送
      // 撞上间隔，后面所有句子都会被同一条闸拦掉——记账也记不出来（全是 continue）。
      if (bucket.lastAt > 0 && at - bucket.lastAt < minGapMs) {
        if (rejected) {
          rejected.gap += 1
          recordSample(stats, 'gap', text)
        }
        return []
      }
      const accepted = []
      for (const line of lines) {
        // 去重按**原句**算，展示用装饰过的（颜文字不影响"这句说过没"）。
        const seenAt = bucket.recent.get(line)
        if (typeof seenAt === 'number' && at - seenAt < dedupeWindowMs) {
          if (rejected) {
            rejected.dup += 1
            recordSample(stats, 'dup', line)
          }
          continue
        }
        bucket.seq += 1
        bucket.items.push({ id: bucket.seq, text: decorateLine(line), at })
        bucket.recent.set(line, at)
        accepted.push(line)
      }
      if (accepted.length === 0) return []
      feedStats.pushed += accepted.length
      bucket.lastAt = at
      // 环形截断：只留最近 bufferSize 条
      if (bucket.items.length > bufferSize) bucket.items.splice(0, bucket.items.length - bufferSize)
      // 过期去重表：避免长期运行时 Map 无限增长
      if (bucket.recent.size > 200) {
        for (const [text2, seenAt2] of bucket.recent) {
          if (at - seenAt2 > dedupeWindowMs) bucket.recent.delete(text2)
        }
      }
      wake(sessionId)
      return accepted
    },

    /**
     * 读 cursor 之后的新台词。
     * @param {string} sessionId
     * @param {number} cursor
     * @returns {{cursor: number, lines: Array<{id:number,text:string,at:number}>}}
     */
    read(sessionId, cursor) {
      const bucket = buckets.get(typeof sessionId === 'string' ? sessionId : '')
      if (!bucket) return { cursor: 0, lines: [] }
      const from = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0
      // 游标比队列还靠前 = 游标是上一代 feed 留下的（插件重载、宿主重启都会让 seq 归零），
      // 这时 `id > from` 永远不成立，气泡会**无声永久停住**，只有切会话（客户端把 cursor
      // 重置成 0）才恢复 —— 用户 2026-10-25 报的「几分钟后就不说话了」正是这个。
      // 处理方式：把游标对齐到队尾，不重放旧句（重放会一次灌 40 条）。
      if (from > bucket.seq) {
        bucket.lastCursor = bucket.seq
        return { cursor: bucket.seq, lines: [] }
      }
      const lines = bucket.items.filter((item) => item.id > from)
      // 读一次 = 到 cursor 为止的句子浏览器都拿到了，队列清空（pending 的语义）。
      bucket.lastCursor = bucket.seq
      return { cursor: bucket.seq, lines }
    },

    /**
     * 还有多少句没被浏览器捞走。
     * 卡片垫句的"队列必须空"闸门靠它——队列里还有她的思考没播完，就不许插台词库。
     * @param {string} sessionId
     * @returns {number}
     */
    pending(sessionId) {
      const bucket = buckets.get(typeof sessionId === 'string' ? sessionId : '')
      if (!bucket) return 0
      return Math.max(0, bucket.seq - bucket.lastCursor)
    },

    /** 台词层的累计账本（入队句数 + 拒绝原因）。只读快照，调用方不要改。 */
    get stats() {
      return feedStats
    },

    /**
     * 长轮询：等到有新台词或超时。**永远 resolve**，不 reject——
     * 桥里一个 reject 就是一次 500，浏览器半会把它当故障写进 console。
     *
     * @param {string} sessionId
     * @param {number} cursor
     * @param {number} timeoutMs
     * @returns {Promise<void>}
     */
    wait(sessionId, cursor, timeoutMs) {
      // 只探一眼，**不改** lastCursor：长轮询空转不该被当成"浏览器把队列读空了"，
      // 否则卡片垫句的"队列必须空"闸门会被一次超时白送。
      const probe = buckets.get(typeof sessionId === 'string' ? sessionId : '')
      const from = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0
      // 游标过期（见 read 里的同类判断）：立刻返回，让 read 去做自愈对齐，
      // 别让浏览器在这里白等满一个超时周期（用户体感就是"卡住十几秒"）。
      if (probe && from > probe.seq) return Promise.resolve()
      if (probe && probe.items.some((item) => item.id > from)) return Promise.resolve()
      const key = typeof sessionId === 'string' ? sessionId : ''
      const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 15000) : 0
      if (ms === 0) return Promise.resolve()
      return new Promise((resolve) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          const index = waiters.findIndex((item) => item.resolve === done)
          if (index >= 0) waiters.splice(index, 1)
          done()
        }, ms)
        // setTimeout 在无宿主环境（单测）里也要能回收，unref 存在才调用
        if (typeof timer?.unref === 'function') timer.unref()
        waiters.push({ sessionId: key, resolve: done })
      })
    },

    /** 清空某个会话（会话结束/清理时用）。 */
    clear(sessionId) {
      buckets.delete(typeof sessionId === 'string' ? sessionId : '')
    },

    /** 诊断用：某会话当前排了多少句。 */
    size(sessionId) {
      const bucket = buckets.get(typeof sessionId === 'string' ? sessionId : '')
      return bucket ? bucket.items.length : 0
    },
  }
}

/**
 * 正整数解析，坏值回落默认。
 * @param {unknown} value
 * @param {number} fallback
 * @param {boolean} [allowZero]
 */
function positiveInt(value, fallback, allowZero = false) {
  if (!Number.isInteger(value)) return fallback
  if (value > 0) return value
  if (allowZero && value === 0) return 0
  return fallback
}

/**
 * 从角色卡的台词桶里把可用句子摊平。
 *
 * 角色卡里的 `lines` 是 `{ bucket: [{ text, shape }, ...] }`，但早期几版存的是纯字符串；
 * 两种都得认，否则换一张卡就整桶静默。
 *
 * 为什么需要它：光靠推理流摘句，用户在跑工具/命令的那几十秒里是**一条都没有**的，
 * 挂件看着像死了。工具期和长思考期就用角色卡自己的台词补，成本为零。
 */
export function cardLineTexts(card, buckets) {
  const out = []
  for (const bucket of buckets) {
    const items = card?.lines?.[bucket]
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const text = typeof item === 'string' ? item : item?.text
      if (typeof text === 'string' && text.trim().length > 0) out.push(text.trim())
    }
  }
  return out
}

/**
 * 轮转取一句（不随机）。
 *
 * 随机会撞车：多个会话同时抽同一句、刷新页面又换一句。轮转按会话自己走，
 * 同一份台词不会紧接着重复，行为可预测、也能单测。
 */
export function rotateLine(list, index) {
  if (!Array.isArray(list) || list.length === 0) return ''
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0
  return list[i % list.length]
}
