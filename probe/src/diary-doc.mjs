/**
 * 日记 D4：记录文档的**纯文本层**（渲染 / 解析 / 局部改写）。
 *
 * 为什么要有这一层：把「日记到底怎么配的、今天什么情况、最近写过哪几篇、哪次没写成」
 * 从一堆 JSON + 目录扫描里收回到**一份人能看懂、也能手改的 Markdown** 里。
 * 用户原话是「连改文件夹名字都不行吗？」——只要状态是人可读的单一文件，
 * 出问题时他自己打开就能看懂，我们也不用靠扫盘去猜。
 *
 * 这个模块**零依赖、不碰磁盘、不读 process/env**：
 *   - 宿主半（src/diary-store.mjs）拿它做读写；
 *   - 文本层可以原样内联进浏览器（设置页要显示同一份字段），所以连 node: 都不许 import。
 *
 * 文档形状是**契约**（docs/重做方案.md §a.3 / §a.4），改字段等于改契约：
 *   一、设置（可以手改）        ← 唯一允许手改的段落
 *   二、今天（程序自己写）      ← 今日统计缓存
 *   三、最近的日记（程序自己写） ← 索引，替代 readdir + 逐个读文件
 *   四、最近一次没写成（程序自己写）
 *   五、待办理（程序自己写）    ← 写入中的事务标记，用于崩溃后重试
 */

/** 记录文档的格式代际。改结构就 +1，旧文档会被就地升级。 */
export const DIARY_DOC_SCHEMA = 2

/** 文档固定放在日记本里，文件名不允许用户改（改名等于丢索引）。 */
export const DIARY_DOC_FILE = 'AI娘日记记录.md'

/** 段落标题：**只按「一、二、三…」认段**，后面的字允许用户改。 */
export const DOC_SECTION_LABELS = Object.freeze({
  config: '一、设置',
  today: '二、今天',
  recent: '三、最近的日记',
  failure: '四、最近一次没写成',
  pending: '五、待办理',
})

/** 段落编号 → 段 key。只认序号，正文随用户改都不影响解析。 */
const SECTION_ORDER = Object.freeze({ 一: 'config', 二: 'today', 三: 'recent', 四: 'failure', 五: 'pending' })

/** 「一、设置」里的字段名。这些是**权威字段**，别处不再存一份。 */
export const DOC_CONFIG_LABELS = Object.freeze({
  enabled: '打开日记',
  dir: '日记本文件夹',
  time: '每天几点写',
  diarist: '谁来写',
  autoCreate: '自动新建本子',
  schema: '记录格式',
  updatedAt: '上次改动',
  recovered: '已自动认回',
  // 增补 2026-10-24（方案 §a.9.3）：改名认回的两道"别乱认"闸门
  dirManualAt: '本子最后手动指定',
  dirRejected: '不自动认回',
})

/** 「最近日记」表格最多留多少行。够看一年，又不至于把文档撑大。 */
export const DOC_RECENT_LIMIT = 30

/* ───────────────────────────── 小工具 ───────────────────────────── */

const pad2 = (value) => String(value).padStart(2, '0')

/** `YYYY-MM-DD HH:MM:SS`（本地时区，只给人看，不参与判定）。 */
export function formatStamp(input = Date.now()) {
  const date = input instanceof Date ? input : new Date(Number(input) || Date.now())
  if (Number.isNaN(date.getTime())) return ''
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  )
}

/**
 * 时间输入归一。设置页允许手打 `9:5`、`21：00` 这种，但要给明确反馈而不是静默改。
 *
 * @returns {{ok:boolean, value?:string, suggestion?:string, reason?:string}}
 */
export function normalizeTimeInput(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, reason: '时间是空的' }
  let hours
  let minutes
  const colon = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(text)
  if (colon) {
    hours = Number(colon[1])
    minutes = Number(colon[2])
  } else {
    const compact = /^(\d{1,2})\s*(\d{2})$/.exec(text)
    if (!compact) return { ok: false, reason: '要写成 21:00 这样（24 小时制）' }
    hours = Number(compact[1])
    minutes = Number(compact[2])
  }
  const suggestion = `${pad2(hours)}:${pad2(minutes)}`
  if (hours > 23 || minutes > 59) {
    return { ok: false, reason: '这个时间不存在（24 小时制，00:00–23:59）', suggestion }
  }
  return { ok: true, value: suggestion, changed: suggestion !== text }
}

/** 切块：`## ` 开头的算新段，前面那段（标题/说明）heading 为 null。 */
function splitBlocks(text) {
  const blocks = []
  let current = { heading: null, lines: [] }
  for (const line of String(text ?? '').split('\n')) {
    if (/^##\s/.test(line)) {
      blocks.push(current)
      current = { heading: line, lines: [] }
    } else {
      current.lines.push(line)
    }
  }
  blocks.push(current)
  return blocks
}

/** 从标题行认段 key（只认序号：`## 一、…`）。认不出返回 null。 */
function sectionKeyOf(heading) {
  if (typeof heading !== 'string') return null
  const match = /^##\s*([一二三四五])\s*[、.]/.exec(heading)
  return match ? SECTION_ORDER[match[1]] ?? null : null
}

/* ────────────── 增补 2026-10-24：改名认回要用的纯函数（§a.9） ────────────── */

/**
 * 路径列表的读写：`不自动认回` 那一行是给人看的，所以要能手打进 `; ` 分隔。
 *
 * 只做「分段 + 去空白 + 去重」，**绝不做路径规范化**（resolve / 去尾斜杠 / 大小写）：
 * 用户写下的路径要原样保留，否则 macOS 上大小写不敏感的文件系统会把两条不同的路认成一条。
 */
export function parsePathList(text) {
  if (Array.isArray(text)) return dedupePaths(text)
  return dedupePaths(String(text ?? '').split(/[;；\n]/))
}

/** 路径列表 → 文档里那一行（`;` 分隔）。空列表返回空串，调用方据此决定要不要画这一行。 */
export function renderPathList(list) {
  return dedupePaths(Array.isArray(list) ? list : parsePathList(list)).join(';')
}

function dedupePaths(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const value = String(item ?? '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** 身份标记文件的默认字段（首次写盘用；已有文件只补缺，不覆盖）。 */
export const DIARY_MARKER_DEFAULTS = Object.freeze({
  plugin: 'dsh-ai-waifu',
  purpose: '这个文件是日记本的身份标记：文件夹被改名或移动后，插件靠它把日记本认回来。删掉不影响已有的日记，只是改名后要手动重选一次。',
})

/**
 * 身份标记的**判定 + 缺字段补齐**（纯函数；IO 留在 store 的 `ensureDiaryMarker` 里）。
 *
 * 判定只有一条硬规则（方案 §a.9.1）：`plugin` 字段去空白、转小写之后必须等于
 * `dsh-ai-waifu`。坏 JSON、缺 `plugin` 一律**不算**日记本——宁可认不回来，也不能认错本子。
 *
 * @param {object|null} parsed 已经 JSON.parse 过的内容
 * @param {{today?:string}} options today: 'YYYY-MM-DD'，补 createdAt 用
 * @returns {{valid:boolean, marker:object, missing:string[]}}
 */
export function supplementMarkerFields(parsed, { today = '' } = {}) {
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  const plugin = String(source.plugin ?? '').trim()
  const valid = plugin.toLowerCase() === 'dsh-ai-waifu'
  const defaults = {
    plugin: DIARY_MARKER_DEFAULTS.plugin,
    purpose: DIARY_MARKER_DEFAULTS.purpose,
    createdAt: today || '',
  }
  const missing = []
  const marker = { ...source }
  for (const [key, value] of Object.entries(defaults)) {
    const current = source[key]
    const blank = current === undefined || current === null || String(current).trim() === ''
    if (!blank) continue
    // createdAt 不知道今天是哪天就先不补：留空比写错日期好
    if (key === 'createdAt' && !value) {
      missing.push(key)
      continue
    }
    marker[key] = value
    missing.push(key)
  }
  return { valid, marker, missing }
}

/** 收尾：统一去掉末尾空白、补一个换行。**所有**写文档的出口都必须过这一道。 */
function finishDoc(text) {
  return `${String(text ?? '').replace(/\s+$/, '')}\n`
}

/** 把某一段的正文换掉；段不存在就按标准顺序补上。 */
function replaceSectionBody(text, key, bodyLines) {
  const blocks = splitBlocks(text)
  const label = DOC_SECTION_LABELS[key]
  const body = ['', ...bodyLines, '']
  let replaced = false
  const next = []
  for (const block of blocks) {
    if (sectionKeyOf(block.heading) === key) {
      // 标题原样留着：用户可能在段名后面加了自己的备注，不该被我们抹掉
      next.push({ heading: block.heading, lines: body })
      replaced = true
      continue
    }
    next.push(block)
  }
  if (!replaced) {
    // 缺段：按契约顺序插进去（找不到位置就追加到末尾，前面补空行）
    const desired = ['config', 'today', 'recent', 'failure', 'pending']
    const order = desired.indexOf(key)
    let insertAt = next.length
    for (let index = 0; index < next.length; index += 1) {
      const otherKey = sectionKeyOf(next[index].heading)
      if (otherKey && desired.indexOf(otherKey) > order) {
        insertAt = index
        break
      }
    }
    next.splice(insertAt, 0, { heading: `## ${label}`, lines: body })
  }
  const lines = []
  for (const block of next) {
    if (block.heading !== null) lines.push(block.heading)
    lines.push(...block.lines)
  }
  // 压掉连续空行（用户在段间多敲几个回车不该让文档越长越乱）
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * 「每天几点写」的出厂值，唯一真源。
 *
 * 它必须等于 `src/diary-source.mjs` 的 `DAY_ROLLOVER_HOUR`（21）：
 * 切日点和默认写作时刻是同一个概念，两处写成两个数字迟早对不上
 * （`tests/diary-source.test.mjs` 里有一条断言钉住两者相等）。
 * 放在这里而不是 diary-source：本模块要原样内联进浏览器，不能 import node: 或别的模块。
 */
export const DAY_ROLLOVER_TIME = '21:00'

/* ───────────────────────────── 渲染 ───────────────────────────── */

function renderConfigLines(config = {}) {
  const dir = typeof config.dir === 'string' && config.dir.trim() ? config.dir.trim() : ''
  const diarist = typeof config.diarist === 'string' && config.diarist.trim() ? config.diarist.trim() : ''
  const time = config.time || DAY_ROLLOVER_TIME
  const lines = [
    `- ${DOC_CONFIG_LABELS.enabled}：${config.enabled === true ? '是' : '否'}`,
    `- ${DOC_CONFIG_LABELS.dir}：${dir || '（还没选）'}`,
    `- ${DOC_CONFIG_LABELS.time}：${time}`,
    `- ${DOC_CONFIG_LABELS.diarist}：${diarist || '自动'}`,
    `- ${DOC_CONFIG_LABELS.autoCreate}：${config.autoCreate === false ? '否' : '是'}`,
    `- ${DOC_CONFIG_LABELS.schema}：${Number(config.schema) || DIARY_DOC_SCHEMA}`,
    `- ${DOC_CONFIG_LABELS.updatedAt}：${config.updatedAt || formatStamp()}`,
  ]
  if (config.recovered && config.recovered.to) {
    const from = config.recovered.from ? `（原：${config.recovered.from}）` : ''
    lines.push(`- ${DOC_CONFIG_LABELS.recovered}：${config.recovered.to}${from}`)
  }
  // 这两行只在有值时才画：没有就不占地方，用户手改时也不必先学格式
  if (config.dirManualAt) lines.push(`- ${DOC_CONFIG_LABELS.dirManualAt}：${config.dirManualAt}`)
  const rejected = renderPathList(config.dirRejected ?? [])
  if (rejected) lines.push(`- ${DOC_CONFIG_LABELS.dirRejected}：${rejected}`)
  return lines
}

function renderTodayLines(today) {
  if (!today || !today.label) {
    return ['- 还没统计过（打开设置页会自动算一次）']
  }
  const diarist = typeof today.diarist === 'string' ? today.diarist : today.diarist?.key ?? ''
  const usage = Array.isArray(today.topUsage) ? today.topUsage : []
  const usageText = usage
    .map((entry) => `${entry?.key ?? ''}（${Number(entry?.outputTokens) || 0}）`)
    .filter((text) => text && !text.startsWith('（'))
    .join('，')
  return [
    `- 日期：${today.label}`,
    `- 今天有几段对话：${Number(today.sessions) || 0}`,
    `- 可用内容：${Number(today.kept) || 0} 条`,
    `- 今天写了多少字：${Number(today.outputTokens) || 0}`,
    `- 今天会是谁写：${diarist || '自动'}`,
    `- 候选执笔：${usageText || '—'}`,
    `- 今天已经写过：${today.written === true ? '是' : '否'}`,
    `- 统计于：${today.scannedAt || formatStamp()}`,
  ]
}

/** 表格单元格：竖线会切坏表格，换行会切坏行，都要先压掉。 */
function cell(value) {
  return String(value ?? '')
    .replace(/\|/g, '｜')
    .replace(/[\r\n]+/g, ' ')
    .trim()
}

function renderRecentLines(rows) {
  const list = Array.isArray(rows) ? rows.slice(0, DOC_RECENT_LIMIT) : []
  const head = ['| 日期 | 字数 | 谁写的 | 摘要 | 文件 |', '| --- | --- | --- | --- | --- |']
  if (!list.length) return [...head, '| — | — | — | 还没有写过 | — |']
  const body = list.map(
    (row) =>
      `| ${cell(row?.label)} | ${Number(row?.chars) || 0} | ${cell(row?.diarist || '自动')} | ${cell(row?.summary)} | ${cell(row?.file)} |`,
  )
  return [...head, ...body]
}

function renderFailureLines(failure) {
  if (!failure) return ['- 没有失败记录']
  return [
    `- 时间：${failure.at || formatStamp()}`,
    `- 错误码：${failure.code || 'internal'}`,
    `- 原因：${cell(failure.reason)}`,
    `- 处理：${cell(failure.hint || '看一眼文件夹还在不在、能不能写，然后再点一次「现在就写」')}`,
  ]
}

function renderPendingLines(pending) {
  if (!pending) return ['- 没有待办理的事']
  const lines = []
  if (pending.kind === 'move') {
    lines.push(`- 正在搬本子：${pending.dir || ''}`)
  } else {
    const label = pending.label ? `：${pending.label}` : ''
    lines.push(`- 正在写${label}`)
    if (pending.dir) lines.push(`- 文件：${pending.dir}`)
  }
  lines.push(`- 开始于：${pending.since || formatStamp()}`)
  return lines
}

/** 整份渲染。首次生成、迁移、段全丢时重建都用它。 */
export function renderDiaryDoc(state = {}) {
  const config = state.config && typeof state.config === 'object' ? state.config : {}
  const lines = [
    '# AI 娘的日记本记录',
    '',
    '这份文件是 AI 娘自己的记录：设置写在这儿，今天的情况、最近写过哪几篇、哪次没写成也写在这儿。',
    '只有「一、设置」需要你改；其余段落是程序自己维护的，手改会让她认不出来。',
    '',
    `## ${DOC_SECTION_LABELS.config}（可以手改）`,
    '',
    ...renderConfigLines(config),
    '',
    `## ${DOC_SECTION_LABELS.today}（程序自己写，别手改）`,
    '',
    ...renderTodayLines(state.today),
    '',
    `## ${DOC_SECTION_LABELS.recent}（程序自己写）`,
    '',
    ...renderRecentLines(state.recent),
    '',
    `## ${DOC_SECTION_LABELS.failure}（程序自己写）`,
    '',
    ...renderFailureLines(state.failure),
    '',
    `## ${DOC_SECTION_LABELS.pending}（程序自己写；空着就是没事）`,
    '',
    ...renderPendingLines(state.pending),
  ]
  return finishDoc(lines.join('\n'))
}

/* ───────────────────────────── 解析 ───────────────────────────── */

const BOOL_TRUE = new Set(['是', 'true', '开', '打开', 'on', '1', 'yes'])

function parseBool(raw, fallback = false) {
  return parseBoolStrict(raw, fallback).value
}

/**
 * 严格版的布尔解析：**认不出来要能说**（Q4）。
 *
 * 老版本把「打开日记：好」这种手滑直接当 false，用户看到的是"设置没了"，却没有任何提示。
 * 时间那行早就这么做（`timeValid`），布尔字段照同一套：给个可用值 + 留一条 warning。
 */
function parseBoolStrict(raw, fallback = false) {
  const text = String(raw ?? '').trim().toLowerCase()
  if (!text) return { ok: true, value: fallback }
  if (BOOL_TRUE.has(text)) return { ok: true, value: true }
  if (text === '否' || text === 'false' || text === '关' || text === 'off' || text === '0' || text === 'no') {
    return { ok: true, value: false }
  }
  return { ok: false, value: fallback }
}

function parseNumber(raw) {
  const match = /-?\d+(?:\.\d+)?/.exec(String(raw ?? '').replace(/,/g, ''))
  return match ? Number(match[0]) : 0
}

/** `- 键：值` → {key, value}；认不出返回 null。中英文冒号都认。 */
function splitFieldLine(line) {
  const match = /^\s*-\s*([^：:]+)[：:]\s*(.*)$/.exec(String(line ?? ''))
  return match ? { key: match[1].trim(), value: match[2].trim() } : null
}

function isBlankDoc(text) {
  return typeof text !== 'string' || !text.trim()
}

/**
 * 解析整份文档。**永不 throw**——用户手改坏了也要能回一个可用的状态。
 *
 * @returns {{config:object, today:object|null, recent:Array<object>, failure:object|null, pending:object|null, tampered:boolean, warnings:string[], hasFingerprint:boolean, schema:number, sections:string[]}}
 */
export function parseDiaryDoc(text) {
  const warnings = []
  const sections = []
  const config = {
    enabled: false,
    dir: '',
    time: DAY_ROLLOVER_TIME,
    diarist: '',
    autoCreate: true,
    schema: DIARY_DOC_SCHEMA,
    updatedAt: '',
    recovered: null,
    timeInvalid: false,
    timeValid: true,
    // 增补 2026-10-24：改名认回用得上，但不许进前端契约（前端传了也不收）
    dirManualAt: '',
    dirRejected: [],
  }
  let today = null
  let failure = null
  let pending = null
  const recent = []
  const todayFields = new Map()

  if (isBlankDoc(text)) {
    warnings.push('记录文档是空的，已经按默认值处理')
    return { config, today, recent, failure, pending, tampered: false, hasFingerprint: false, schema: DIARY_DOC_SCHEMA, sections, warnings }
  }

  for (const block of splitBlocks(text)) {
    const key = sectionKeyOf(block.heading)
    if (!key) continue
    sections.push(key)
    const body = block.lines

    if (key === 'config') {
      for (const line of body) {
        const field = splitFieldLine(line)
        if (!field) continue
        switch (field.key) {
          case DOC_CONFIG_LABELS.enabled: {
            const parsed = parseBoolStrict(field.value, false)
            config.enabled = parsed.value
            config.enabledValid = parsed.ok
            if (!parsed.ok) warnings.push(`「${DOC_CONFIG_LABELS.enabled}」不是 是/否：${field.value}（按「否」用）`)
            break
          }
          case DOC_CONFIG_LABELS.dir: {
            const value = field.value.replace(/（还没选）|\(还没选\)/g, '').trim()
            config.dir = value
            break
          }
          case DOC_CONFIG_LABELS.time: {
            const normalized = normalizeTimeInput(field.value)
            // 能救就救（9:5 → 09:05），救不了才回落 21:00；
            // 但 timeValid 一律按**手写的原文**算，设置页要能提示「这行格式不对」
            config.timeValid = /^([01]\d|2[0-3]):[0-5]\d$/.test(field.value)
            if (normalized.ok) config.time = normalized.value
            else config.time = DAY_ROLLOVER_TIME
            if (!config.timeValid) {
              config.timeInvalid = true
              warnings.push(`「每天几点写」不是 HH:MM 格式：${field.value}（按 ${config.time} 用）`)
            }
            break
          }
          case DOC_CONFIG_LABELS.diarist: {
            const value = field.value.replace(/^自动$/, '').trim()
            config.diarist = value
            break
          }
          case DOC_CONFIG_LABELS.autoCreate: {
            const parsed = parseBoolStrict(field.value, true)
            config.autoCreate = parsed.value
            config.autoCreateValid = parsed.ok
            if (!parsed.ok) {
              warnings.push(`「${DOC_CONFIG_LABELS.autoCreate}」不是 是/否：${field.value}（按「是」用）`)
            }
            break
          }
          case DOC_CONFIG_LABELS.schema: {
            const parsed = Number(String(field.value).trim())
            config.schema = Number.isFinite(parsed) && parsed > 0 ? parsed : DIARY_DOC_SCHEMA
            if (config.schema !== parsed) warnings.push(`「${DOC_CONFIG_LABELS.schema}」不是数字：${field.value}（按 ${DIARY_DOC_SCHEMA} 用）`)
            break
          }
          case DOC_CONFIG_LABELS.updatedAt:
            config.updatedAt = field.value
            break
          case DOC_CONFIG_LABELS.recovered: {
            const match = /^(.*?)（原：(.+)）$/.exec(field.value)
            config.recovered = match ? { to: match[1].trim(), from: match[2].trim() } : { to: field.value, from: '' }
            break
          }
          case DOC_CONFIG_LABELS.dirManualAt: {
            // 时间戳解析失败当空：认回抑制窗失效，但别让整份文档报错——留一条 warning 让用户看得见
            const stamp = field.value.trim()
            const valid = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(stamp)
            config.dirManualAt = valid ? stamp : ''
            if (!valid) warnings.push(`「${DOC_CONFIG_LABELS.dirManualAt}」不是时间：${stamp}（这一项忽略）`)
            break
          }
          case DOC_CONFIG_LABELS.dirRejected:
            config.dirRejected = parsePathList(field.value)
            break
          default:
            warnings.push(`不认识的设置项：${field.key}`)
        }
      }
      continue
    }

    if (key === 'today') {
      for (const line of body) {
        const field = splitFieldLine(line)
        if (!field) continue
        todayFields.set(field.key, field.value)
      }
      continue
    }

    if (key === 'recent') {
      for (const line of body) {
        const trimmed = String(line ?? '').trim()
        if (!trimmed.startsWith('|')) continue
        const cells = trimmed.split('|').slice(1, -1).map((item) => item.trim())
        if (cells.length < 5) continue
        if (/^日期$/.test(cells[0]) || /^-+$/.test(cells[0])) continue
        const label = cells[0]
        if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) continue
        recent.push({
          label,
          chars: parseNumber(cells[1]),
          diarist: cells[2] === '自动' ? '' : cells[2],
          summary: cells[3],
          file: cells[4] === '—' ? '' : cells[4],
        })
      }
      continue
    }

    if (key === 'failure') {
      const fields = new Map()
      for (const line of body) {
        const field = splitFieldLine(line)
        if (field) fields.set(field.key, field.value)
      }
      if (fields.size) {
        failure = {
          at: fields.get('时间') || '',
          code: fields.get('错误码') || 'internal',
          reason: fields.get('原因') || '',
          hint: fields.get('处理') || '',
        }
      }
      continue
    }

    if (key === 'pending') {
      let kind = ''
      let label = ''
      const fields = new Map()
      for (const line of body) {
        const field = splitFieldLine(line)
        if (!field) continue
        if (field.key.startsWith('正在搬本子')) {
          kind = 'move'
        } else if (field.key.startsWith('正在写')) {
          kind = 'write'
          // `- 正在写：2026-10-24` —— 冒号后面才是日期，别去 key 里找
          const match = /(\d{4}-\d{2}-\d{2})/.exec(field.value)
          if (match) label = match[1]
        }
        fields.set(field.key, field.value)
      }
      if (kind) {
        const dir = kind === 'move' ? fields.get('正在搬本子') ?? '' : fields.get('文件') ?? ''
        pending = { kind, dir, label, since: fields.get('开始于') || '' }
      }
      continue
    }
  }

  for (const key of Object.keys(DOC_SECTION_LABELS)) {
    if (!sections.includes(key)) warnings.push(`缺了一段：${DOC_SECTION_LABELS[key]}`)
  }

  if (todayFields.size && todayFields.get('日期')) {
    const diaristRaw = todayFields.get('今天会是谁写') || ''
    const candidate = [...(todayFields.get('候选执笔') || '').matchAll(/([^\s，,（(]+)[（(](\d+)[）)]/g)]
    today = {
      label: todayFields.get('日期') || '',
      sessions: parseNumber(todayFields.get('今天有几段对话')),
      kept: parseNumber(todayFields.get('可用内容')),
      outputTokens: parseNumber(todayFields.get('今天写了多少字')),
      diarist: /^自动$/.test(diaristRaw) ? '' : diaristRaw,
      topUsage: candidate.map((match) => ({ key: match[1], outputTokens: Number(match[2]) })),
      written: parseBool(todayFields.get('今天已经写过'), false),
      scannedAt: todayFields.get('统计于') || '',
    }
  }

  // 不再往文档里塞「指纹」注释（t4/F14）：程序段被人手改过也没关系——下次写入会按程序
  // 自己算的覆盖，硬碰硬比留个隐形标记让人猜更实在。字段留着，老调用方不用改。
  const hasFingerprint = false
  const tampered = false

  // 段落顺序错乱不算错，但要让 UI 能提示"这份文档不是我们写的"
  if (config.schema > DIARY_DOC_SCHEMA) warnings.push(`记录文档格式比插件新（${config.schema}），请升级插件`)

  return { config, today, recent, failure, pending, tampered, hasFingerprint, schema: config.schema, sections, warnings }
}

/* ───────────────────────────── 局部改写 ───────────────────────────── */

function ensureDoc(text, state = {}) {
  if (!isBlankDoc(text)) return String(text)
  return renderDiaryDoc(state)
}

/** 改「一、设置」。这是唯一允许外部（设置页）驱动的写入。 */
export function patchConfigSection(text, config) {
  const base = ensureDoc(text, { config })
  const body = replaceSectionBody(base, 'config', renderConfigLines(config ?? {}))
  return finishDoc(body)
}

/**
 * 改「二、今天」。
 *
 * 注意：**内容没变时返回的字符串和输入完全相同**——上层（writeTextAtomic）
 * 据此跳过落盘，避免每分钟刷一次用户桌面上那个文件的 mtime。
 */
export function patchTodaySection(text, today) {
  const base = ensureDoc(text, { today })
  return finishDoc(replaceSectionBody(base, 'today', renderTodayLines(today)))
}

/** 改「三、最近的日记」。rows 是**完整列表**（不是增量），按日期倒序截断。 */
export function patchRecentSection(text, rows) {
  const base = ensureDoc(text, { recent: rows })
  const sorted = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && /^\d{4}-\d{2}-\d{2}$/.test(String(row.label ?? '')))
    .sort((left, right) => String(right.label).localeCompare(String(left.label)))
    .slice(0, DOC_RECENT_LIMIT)
  return finishDoc(replaceSectionBody(base, 'recent', renderRecentLines(sorted)))
}

/** 往「最近日记」里插一行（同一天写两次就更新那一行，不重复）。 */
export function appendRecentRow(text, row) {
  if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.label ?? ''))) return String(text ?? '')
  const current = parseDiaryDoc(text).recent.filter((item) => item.label !== row.label)
  return patchRecentSection(text, [row, ...current])
}

export function patchFailureSection(text, failure) {
  const base = ensureDoc(text, { failure })
  return finishDoc(replaceSectionBody(base, 'failure', renderFailureLines(failure)))
}

export function patchPendingSection(text, pending) {
  const base = ensureDoc(text, { pending })
  return finishDoc(replaceSectionBody(base, 'pending', renderPendingLines(pending)))
}

/**
 * 把「最近日记」行整理成可展示/可回传的列表：
 * 补上文件是否还在（`exists` 由调用方给，这里只做形状）。
 */
export function recentRowsOf(doc, { exists } = {}) {
  const rows = Array.isArray(doc?.recent) ? doc.recent : []
  return rows.map((row) => {
    const file = row.file || ''
    let present = null
    if (file && typeof exists === 'function') {
      try {
        present = Boolean(exists(file))
      } catch {
        present = null
      }
    }
    return { ...row, file, present }
  })
}
