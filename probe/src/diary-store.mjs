/**
 * 日记 D3：落盘层（指针文件、记录文档、写入、备份、读索引）。
 *
 * 三条规矩，全部来自"用户东西不能丢"：
 *   1. 同名文件**先备份再覆盖**，`.bak` 只有一份，不堆成 .bak.1 .bak.2；
 *   2. 写入失败必须回传原因，不许 `catch {}` 吞掉（前端要能看见"没存上"）；
 *   3. 配置里的路径、时间、执笔全都要过校验，坏配置宁可拒绝也不猜。
 *
 * 重做之后多了两条：
 *   4. **记录文档是唯一状态源**：`<日记本>/AI娘日记记录.md`（方案 §a），
 *      plugin-data 里那个 JSON 只剩一个指针 `{schema:2, docPath}`；
 *   5. **先写文档，再动实际路径**（方案 §a.5）：写文档失败就一个字节都别动
 *      ——用户最怕的是"文件夹里多了半篇日记，记录却说没写"。
 *
 * IO 全部可注入，测试不碰真实磁盘。
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  renameSync,
  unlinkSync,
  statSync,
  accessSync,
  constants as fsConstants,
} from 'node:fs'
import { join, dirname, basename, isAbsolute } from 'node:path'
import { homedir as osHomedir } from 'node:os'

import {
  DAY_ROLLOVER_TIME,
  DIARY_DOC_FILE,
  DIARY_DOC_SCHEMA,
  DOC_RECENT_LIMIT,
  formatStamp,
  normalizeTimeInput,
  parseDiaryDoc,
  parsePathList,
  patchFailureSection,
  patchPendingSection,
  patchRecentSection,
  patchTodaySection,
  renderDiaryDoc,
  supplementMarkerFields,
} from './diary-doc.mjs'

/** 配置文件放在 plugin-data 里，和开关文件同级。 */
export const DIARY_CONFIG_FILE = 'dsh-ai-waifu-diary.json'

/** 默认值：默认关闭、没选目录、21:00、执笔留空（= 自动按当日 token 最多选）。 */
export const DEFAULT_DIARY_CONFIG = Object.freeze({
  enabled: false,
  dir: '',
  time: DAY_ROLLOVER_TIME,
  diarist: '',
  writtenDates: {},
})

/** `HH:MM`，24 小时制，00:00–23:59。 */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/
/** 只认 YYYY-MM-DD，别的一律当脏数据。 */
const LABEL_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** 日期标签校验，落盘层的统一入口。 */
export function assertLabel(label) {
  if (!LABEL_PATTERN.test(String(label ?? ''))) throw new Error(`diary: 日期标签不合法：${label}`)
  return String(label)
}

/**
 * 把任意输入归一成合法配置。**不认识的东西直接丢掉**，不保留、不猜。
 *
 * `writtenDates` 只保留 `{ '<YYYY-MM-DD>': true }` 形态——它是"哪天已经写过"的幂等台账，
 * 一旦被脏数据污染，同一天就可能写两篇。
 */
export function normalizeDiaryConfig(value) {
  const source = value && typeof value === 'object' ? value : {}
  const config = {
    enabled: source.enabled === true,
    dir: typeof source.dir === 'string' ? source.dir.trim() : '',
    time: TIME_PATTERN.test(String(source.time ?? '')) ? String(source.time) : DEFAULT_DIARY_CONFIG.time,
    diarist: typeof source.diarist === 'string' ? source.diarist.trim() : '',
    writtenDates: {},
  }
  const written = source.writtenDates && typeof source.writtenDates === 'object' ? source.writtenDates : {}
  for (const key of Object.keys(written)) {
    if (LABEL_PATTERN.test(key) && written[key] === true) config.writtenDates[key] = true
  }
  return config
}

/** 读配置文本；坏 JSON 回落到默认值（并让调用方知道是回落了）。 */
export function parseDiaryConfig(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { config: normalizeDiaryConfig(DEFAULT_DIARY_CONFIG), corrupted: false }
  }
  try {
    const parsed = JSON.parse(text)
    return { config: normalizeDiaryConfig(parsed), corrupted: false }
  } catch {
    return { config: normalizeDiaryConfig(DEFAULT_DIARY_CONFIG), corrupted: true }
  }
}

/** 写回磁盘用，稳定缩进便于人肉检查。 */
export function serializeDiaryConfig(config) {
  return `${JSON.stringify(normalizeDiaryConfig(config), null, 2)}\n`
}

/**
 * 校验一份配置变更（POST /diary 用）。
 *
 * 只认 `enabled / dir / time / diarist` 四个键；
 * 出现别的键**整单拒绝**，因为静默忽略会让人以为设置生效了。
 *
 * @param {object} patch
 * @param {object} [options]
 * @param {(path: string) => boolean} [options.isDirectory] 目录校验（注入，测试不碰磁盘）
 * @returns {{ok:boolean, config?:object, reason?:string}}
 */
export function validateDiaryPatch(patch, { isDirectory } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, reason: '请求体必须是对象' }
  }
  const allowed = ['enabled', 'dir', 'time', 'diarist', 'autoCreate']
  const unknown = Object.keys(patch).filter((key) => !allowed.includes(key))
  if (unknown.length) return { ok: false, reason: `不认识的字段：${unknown.join('、')}` }

  const next = {}
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') return { ok: false, reason: 'enabled 必须是布尔值' }
    next.enabled = patch.enabled
  }
  if ('dir' in patch) {
    if (typeof patch.dir !== 'string') return { ok: false, reason: 'dir 必须是字符串' }
    const dir = patch.dir.trim()
    if (dir) {
      // 「自动新建本子」勾着时，不存在的目录是**正常请求**（S1 状态的主要出路就是拿旧路径重发）。
      // 存在性闸门因此放到 applyDiaryConfigPatch 里：父目录可写才 mkdir，失败回 bad-dir。
      // 否则这里先判死，那条"重新建一个"永远走不到建目录那一步（T16-F1 实测 400）。
      const willCreate = 'autoCreate' in patch && patch.autoCreate === true
      if (!willCreate && typeof isDirectory === 'function' && !isDirectory(dir)) {
        return { ok: false, reason: `目录不存在或不是文件夹：${dir}` }
      }
      next.dir = dir
    } else {
      next.dir = ''
    }
  }
  if ('time' in patch) {
    if (!TIME_PATTERN.test(String(patch.time ?? ''))) return { ok: false, reason: 'time 必须是 HH:MM（24 小时制）' }
    next.time = String(patch.time)
  }
  if ('diarist' in patch) {
    if (typeof patch.diarist !== 'string') return { ok: false, reason: 'diarist 必须是字符串' }
    next.diarist = patch.diarist.trim()
  }
  // 「重新建一个」勾选框（t4/F1：白名单漏了它，整条功能 400）。类型必须显式校验：
  // 字符串 'false' 会被 `!== false` 当成"要建"，那是给用户凭空长目录。
  if ('autoCreate' in patch) {
    if (typeof patch.autoCreate !== 'boolean') return { ok: false, reason: 'autoCreate 必须是布尔值' }
    next.autoCreate = patch.autoCreate
  }
  return { ok: true, config: next }
}

/** 日记文件完整路径。 */
export function diaryPath(dir, label) {
  const safeLabel = assertLabel(label)
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('diary: 没设置日记本目录')
  return join(dir, `${safeLabel}.md`)
}

/** 备份路径：`2026-10-22.md` → `2026-10-22.md.bak`（只有一份，不堆积）。 */
export function backupPathFor(filePath) {
  return `${filePath}.bak`
}

/**
 * 原子写：先建目录，再备份旧文件，最后覆盖。
 *
 * @returns {{ok:boolean, file?:string, backup?:string, reason?:string}}
 */
export function writeDiaryFile({ dir, label, content, io = {} }) {
  const exists = io.exists ?? existsSync
  const mkdir = io.mkdir ?? ((path) => mkdirSync(path, { recursive: true }))
  const copy = io.copy ?? copyFileSync
  const write = io.write ?? writeFileSync

  let file
  try {
    file = diaryPath(dir, label)
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
  try {
    mkdir(dirname(file))
  } catch (error) {
    return { ok: false, reason: `建不了目录：${error?.message ?? error}` }
  }
  let backup
  try {
    if (exists(file)) {
      backup = backupPathFor(file)
      copy(file, backup)
    }
  } catch (error) {
    // 备份失败就不覆盖：宁可这次不写，也不能把用户原来的日记弄没了
    return { ok: false, reason: `备份失败，这次没写：${error?.message ?? error}` }
  }
  try {
    write(file, content, 'utf8')
  } catch (error) {
    return { ok: false, reason: `写不进去：${error?.message ?? error}` }
  }
  return { ok: true, file, backup }
}

/**
 * 列最近的日记文件（按文件名倒序 = 按日期倒序），带摘要行。
 *
 * 只读 `*.md`，`*.bak` 一律不进列表（那是备份，不是日记）。
 */
export function listDiaryFiles({ dir, io = {}, limit = 10 } = {}) {
  const readdir = io.readdir ?? readdirSync
  const read = io.read ?? ((path) => readFileSync(path, 'utf8'))
  if (typeof dir !== 'string' || !dir.trim()) return []
  let names = []
  try {
    const entries = readdir(dir)
    names = entries
      .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
      .filter((name) => typeof name === 'string' && /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
  } catch {
    return []
  }
  names.sort()
  const recent = names.slice(-Math.max(1, limit)).reverse()
  return recent.map((name) => {
    const label = name.replace(/\.md$/, '')
    let summary = ''
    try {
      const text = read(join(dir, name))
      summary = firstSentences(stripFrontmatter(text), 60)
    } catch {
      summary = ''
    }
    return { label, file: join(dir, name), summary }
  })
}

/** 去掉 `---` 包起来的 frontmatter。 */
export function stripFrontmatter(text) {
  if (typeof text !== 'string') return ''
  const match = /^---\n[\s\S]*?\n---\n?/.exec(text)
  if (!match) return text
  return text.slice(match[0].length)
}

/**
 * 取前 N 个字符当摘要，并把换行压成空格。
 * 摘要只给人看（设置页列表），不进提示词。
 */
export function firstSentences(text, limit = 60) {
  if (typeof text !== 'string') return ''
  const body = text
    .replace(/^#\s*[^\n]*\n+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (body.length <= limit) return body
  return `${body.slice(0, limit)}…`
}

/* ═══════════════ 记录文档 + 指针（docs/重做方案.md §a） ═══════════════ */

/** 指针文件的格式代际：`{schema:2, docPath}` 才算新格式，否则当老配置迁。 */
export const DIARY_POINTER_SCHEMA = 2

// 文本层的入口转出一份：宿主半只 import 这个模块就够了，不必两处都 import
export { DIARY_DOC_FILE, DIARY_DOC_SCHEMA, formatStamp, normalizeTimeInput, parseDiaryDoc }

/** 错误对象 → 一句能给人看的话（绝不吞成空串）。 */
export function reasonOf(error) {
  if (error === undefined || error === null) return '未知错误'
  if (typeof error === 'string') return error
  return String(error?.message ?? error)
}

/** 记录文档路径：配了目录就放日记本里（用户看得见），没配由调用方给兜底位置。 */
export function docPathFor(dir, fallback = '') {
  if (typeof dir === 'string' && dir.trim()) return join(dir.trim(), DIARY_DOC_FILE)
  return fallback
}

/** 老配置的备份名：`dsh-ai-waifu-diary.v1.json.bak`（只有一份，迁移时写一次）。 */
export function legacyBackupPathFor(file) {
  return String(file ?? '').replace(/\.json$/i, '') + '.v1.json.bak'
}

/**
 * 原子写文本：**先写 `.tmp-<pid>`，再 rename 覆盖**。
 *
 * 两条必须一起做：
 *   1. rename 才是原子的（写完一半崩掉，用户看到的还是旧文件，不是半篇）；
 *   2. **内容没变就跳过**——「二、今天」每分钟都要回写一次，若每次都落盘，
 *      用户桌面上那个文件的 mtime 会被一直刷，备份软件会跟着一直复制，`.bak` 也会被反复覆盖。
 *
 * @returns {{ok:boolean, file?:string, backup?:string, skipped?:boolean, reason?:string}}
 */
export function writeTextAtomic(file, text, io = {}) {
  if (typeof file !== 'string' || !file) return { ok: false, reason: '没有要写的路径' }
  const exists = io.exists ?? existsSync
  const read = io.read ?? ((path) => readFileSync(path, 'utf8'))
  const write = io.write ?? writeFileSync
  const rename = io.rename ?? renameSync
  const copy = io.copy ?? copyFileSync
  const mkdir = io.mkdir ?? ((path) => mkdirSync(path, { recursive: true }))
  const unlink = io.unlink ?? unlinkSync
  const pendingSuffix = io.pendingSuffix ?? `.tmp-${io.pid ?? process.pid}`
  const content = String(text ?? '')

  let previous = null
  try {
    if (exists(file)) previous = read(file)
  } catch {
    // 读不出来就当作"没有旧内容"：宁可多写一次，也不能因为读失败就跳过写
    previous = null
  }
  if (previous === content) return { ok: true, skipped: true, file }

  const tmp = `${file}${pendingSuffix}`
  try {
    mkdir(dirname(file))
  } catch (error) {
    return { ok: false, reason: `建不了目录：${reasonOf(error)}` }
  }
  try {
    write(tmp, content, 'utf8')
  } catch (error) {
    return { ok: false, reason: `写不了临时文件：${reasonOf(error)}` }
  }
  let backup
  try {
    if (previous !== null) {
      backup = backupPathFor(file)
      copy(file, backup)
    }
  } catch (error) {
    try {
      unlink(tmp)
    } catch {
      /* 临时文件删不掉不影响结论，反正没覆盖原文件 */
    }
    return { ok: false, reason: `备份失败，这次没写：${reasonOf(error)}` }
  }
  try {
    rename(tmp, file)
  } catch (error) {
    try {
      unlink(tmp)
    } catch {
      /* 同上 */
    }
    return { ok: false, reason: `覆盖不了原文件：${reasonOf(error)}` }
  }
  return { ok: true, file, backup, skipped: false }
}

/** 读记录文档。读不到不抛：`exists:false` 交给上层决定"重建"还是"报错"。 */
export function readDiaryDocFile(file, io = {}) {
  const read = io.read ?? ((path) => readFileSync(path, 'utf8'))
  const exists = io.exists ?? existsSync
  if (typeof file !== 'string' || !file) return { exists: false, text: '', error: '' }
  try {
    if (!exists(file)) return { exists: false, text: '', error: '' }
  } catch {
    return { exists: false, text: '', error: '' }
  }
  try {
    return { exists: true, text: read(file), error: '' }
  } catch (error) {
    return { exists: true, text: '', error: reasonOf(error) }
  }
}

/**
 * 读指针文件。**永不 throw**，并且把"是老格式"这件事说清楚：
 * 老格式（没有 schema:2 的 dir/enabled/...）由调用方决定什么时候迁。
 */
export function readDiaryPointer({ file, io = {} } = {}) {
  const read = io.read ?? ((path) => readFileSync(path, 'utf8'))
  const exists = io.exists ?? existsSync
  const result = { exists: false, schema: 0, docPath: '', legacy: null, corrupted: false }
  if (typeof file !== 'string' || !file) return result
  try {
    if (!exists(file)) return result
  } catch {
    return result
  }
  result.exists = true
  let text = ''
  try {
    text = read(file)
  } catch {
    result.corrupted = true
    return result
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    result.corrupted = true
    return result
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    result.corrupted = true
    return result
  }
  const schema = Number(parsed.schema)
  if (schema >= DIARY_POINTER_SCHEMA && typeof parsed.docPath === 'string' && parsed.docPath) {
    result.schema = schema
    result.docPath = parsed.docPath
    return result
  }
  result.schema = Number.isFinite(schema) && schema > 0 ? schema : 1
  result.legacy = parsed
  return result
}

/** 写指针（同样走原子写；内容没变就跳过）。 */
export function writeDiaryPointer({ file, docPath, io = {} } = {}) {
  const payload = `${JSON.stringify({ schema: DIARY_POINTER_SCHEMA, docPath }, null, 2)}\n`
  return writeTextAtomic(file, payload, io)
}

/**
 * 把老的 `dsh-ai-waifu-diary.json` 迁进记录文档。
 *
 * 顺序（方案 §a.7）：先生成文档 → 再写指针 → 最后留一份 `.v1.json.bak`。
 * **旧 JSON 本身一个字节都不动**（用户可能正在手改，也可能想自己回滚）。
 */
export function migrateLegacyDiary({ legacy, pointerFile, docFile, todayLabel = '', io = {}, now = Date.now() } = {}) {
  const read = io.read ?? ((path) => readFileSync(path, 'utf8'))
  // 先留旧文件的原文：下面会把指针改成 {schema:2,docPath}，改完再读就成了新内容
  let legacyRaw = ''
  try {
    legacyRaw = String(read(pointerFile))
  } catch {
    legacyRaw = ''
  }
  const config = normalizeDiaryConfig(legacy ?? {})
  const writtenDates = config.writtenDates ?? {}
  const exists = io.exists ?? existsSync
  const recent = Object.keys(writtenDates)
    .filter((label) => writtenDates[label] === true)
    // 台账里记着写过、文件其实已经被删/搬走了的日期不往「三、最近的日记」里写：
    // 列表上点一下打开一个不存在的文件，比少一行难解释得多
    .filter((label) => !config.dir || safeExists(join(config.dir, `${label}.md`), exists))
    .sort()
    .reverse()
    .slice(0, DOC_RECENT_LIMIT)
    .map((label) => ({
      label,
      chars: 0,
      diarist: config.diarist || '',
      summary: '（从旧配置迁入）',
      file: config.dir ? join(config.dir, `${label}.md`) : '',
    }))
  const today = todayLabel
    ? {
        label: todayLabel,
        sessions: 0,
        kept: 0,
        outputTokens: 0,
        diarist: '',
        topUsage: [],
        written: writtenDates[todayLabel] === true,
        scannedAt: '',
      }
    : null
  const docConfig = {
    enabled: config.enabled === true,
    dir: config.dir,
    time: config.time,
    diarist: config.diarist,
    autoCreate: true,
    schema: DIARY_DOC_SCHEMA,
    updatedAt: formatStamp(now),
    recovered: null,
  }
  const text = renderDiaryDoc({ config: docConfig, today, recent, failure: null, pending: null })
  const docWrite = writeTextAtomic(docFile, text, io)
  if (!docWrite.ok) {
    return { ok: false, code: 'doc-write-failed', reason: docWrite.reason, docFile, config: docConfig, recent, today }
  }
  const pointerWrite = writeDiaryPointer({ file: pointerFile, docPath: docFile, io })
  if (!pointerWrite.ok) {
    return { ok: false, code: 'pointer-write-failed', reason: pointerWrite.reason, docFile, config: docConfig, recent, today }
  }
  // 旧 JSON 留一份逐字备份：迁移出问题时用户还能自己捡回来
  let backup = ''
  const write = io.write ?? writeFileSync
  if (legacyRaw !== '') {
    try {
      backup = legacyBackupPathFor(pointerFile)
      write(backup, legacyRaw, 'utf8')
    } catch {
      backup = ''
    }
  }
  return { ok: true, docFile, config: docConfig, recent, today, backup, docText: text }
}

/* ─────────────── 目录状态 / 身份标记 / 改名认回 ─────────────── */

/**
 * 目录的可用状态。分开报是为了设置页能说人话（方案 §c S1）：
 *   ok       可控
 *   none     还没选
 *   missing  路径不存在（**可能就是被改名了**）
 *   not-dir  指向的是文件
 *   unreadable / unwritable  存在但进不去/写不了
 */
export function dirStateOf(dir, io = {}) {
  const stat = io.stat ?? statSync
  const access = io.access ?? accessSync
  if (typeof dir !== 'string' || !dir.trim()) return 'none'
  let info
  try {
    info = stat(dir)
  } catch (error) {
    const code = String(error?.code ?? '')
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable'
  }
  if (typeof info?.isDirectory === 'function' && info.isDirectory() === false) return 'not-dir'
  try {
    access(dir, fsConstants.W_OK)
  } catch {
    return 'unwritable'
  }
  return 'ok'
}

/* ─────────── 增补 2026-10-24：日记本身份标记 + 改名自动认回（方案 §a.9） ─────────── */

/** 身份标记文件名。点开头 → Finder 默认不显示，不碍眼。 */
export const DIARY_MARKER_FILE = '.dsh-ai-waifu-diary-root.json'
/** 标记里 `plugin` 字段必须是这个值（唯二硬判据，另一条是"能 JSON.parse"）。 */
export const DIARY_MARKER_PLUGIN = 'dsh-ai-waifu'
// 兼容早期实现的名字（同一个文件，同一套判定）
export const DIARY_ROOT_MARKER_FILE = DIARY_MARKER_FILE
export const DIARY_ROOT_MARKER_PLUGIN = DIARY_MARKER_PLUGIN

/** 认回结果的缓存时长：设置页轮询时同一目录 120s 内只扫一次。 */
export const RECOVERY_CACHE_TTL_MS = 120000
/** 一次认回的预算：超了就放弃（扫到一半也立即停），宁可回 missing 也不能卡住事件循环。 */
export const RECOVERY_BUDGET_MS = 40
/** 用户刚手动指定过目录的抑制窗：10 分钟内不许自动认回。 */
export const RECOVERY_MANUAL_WINDOW_MS = 10 * 60000
/** 一层扫描最多看多少个目录项（按 UTF-8 字节序取前 N，保证确定性）。 */
export const RECOVERY_SCAN_LIMIT = 500

const recoverCache = new Map()

/** 测试用：清掉认回缓存（真机上不需要，120s 自己会过期）。 */
export function resetRecoveryCache() {
  recoverCache.clear()
}

function safeExists(file, exists) {
  try {
    return Boolean(exists(file))
  } catch {
    return false
  }
}

/** 读日记本身份标记；不是我们的标记（或坏了）一律当没有。 */
export function readDiaryMarker(dir, io = {}) {
  const read = io.read ?? ((path) => readFileSync(path, 'utf8'))
  const exists = io.exists ?? existsSync
  if (typeof dir !== 'string' || !dir.trim()) return null
  const file = join(dir, DIARY_MARKER_FILE)
  if (!safeExists(file, exists)) return null
  let parsed
  try {
    parsed = JSON.parse(read(file))
  } catch {
    return null
  }
  const judged = supplementMarkerFields(parsed)
  if (!judged.valid) return null
  return { ...judged.marker, file }
}

/** 兼容别名（旧名字，判定完全相同）。 */
export const readDiaryRootMarker = readDiaryMarker

/**
 * 给一个"被确认过的日记本"打上身份证。
 *
 * **只补缺字段，不覆盖已有字段**（用户/未来版本加的东西不许被抹掉）；
 * 字段已经齐了就一个字都不写（`unchanged`），避免每次确认目录都改一次 mtime。
 * **永不 throw**：标记写不进去不能连累"确认目录"这件事（方案 §a.9.1）。
 *
 * @returns {{ok:boolean, written:'created'|'patched'|'unchanged'|'failed', file?:string, reason?:string}}
 */
export function ensureDiaryMarker({ dir, io = {}, now = Date.now() } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) return { ok: false, written: 'failed', reason: '没有目录' }
  const read = io.read ?? ((path) => readFileSync(path, 'utf8'))
  const exists = io.exists ?? existsSync
  const write = io.write ?? writeFileSync
  const mkdir = io.mkdir ?? ((path) => mkdirSync(path, { recursive: true }))
  const file = join(dir, DIARY_MARKER_FILE)
  const today = new Date(Number(now) || Date.now()).toISOString().slice(0, 10)

  let current = null
  if (safeExists(file, exists)) {
    try {
      current = JSON.parse(read(file))
    } catch {
      current = null // 坏文件：当成"要整份补一遍"，但仍然是补，不是覆盖别的字段
    }
  }
  const judged = supplementMarkerFields(current, { today })
  // 同名文件但 plugin 不对：这是我们的文件名，就该写回我们的身份
  if (!judged.valid) judged.marker.plugin = DIARY_MARKER_PLUGIN

  const before = current && typeof current === 'object' ? JSON.stringify(current) : ''
  if (before && before === JSON.stringify(judged.marker)) {
    return { ok: true, file, written: 'unchanged' }
  }
  try {
    mkdir(dir)
    write(file, `${JSON.stringify(judged.marker, null, 2)}\n`, 'utf8')
  } catch (error) {
    return { ok: false, file, written: 'failed', reason: `写不了身份标记：${reasonOf(error)}` }
  }
  return { ok: true, file, written: current ? 'patched' : 'created' }
}

/** 兼容别名。 */
export const ensureDiaryRootMarker = ensureDiaryMarker

/**
 * 在父目录里列一层"带身份证、且能写"的子目录（**绝不递归**）。
 *
 * 过滤条件（方案 §a.9.2）：名字不以 `.` 开头、是真目录、不是符号链接（不跟随）、
 * 可写（只读的备份盘不算"还能接着写日记的本子"）、标记文件命中。
 *
 * @returns {{dirs:string[], truncated:boolean, scanned:number}}
 */
export function listMarkerDirs(parent, { io = {}, limit = RECOVERY_SCAN_LIMIT } = {}) {
  const readdir = io.readdir ?? readdirSync
  const access = io.access ?? accessSync
  const result = { dirs: [], truncated: false, scanned: 0 }
  if (typeof parent !== 'string' || !parent.trim()) return result
  let entries = []
  try {
    entries = readdir(parent, { withFileTypes: true })
  } catch {
    return result
  }
  const names = []
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry?.name
    if (typeof name !== 'string' || !name || name.startsWith('.')) continue
    if (typeof entry?.isDirectory === 'function' && entry.isDirectory() === false) continue
    if (typeof entry?.isSymbolicLink === 'function' && entry.isSymbolicLink() === true) continue
    names.push(name)
  }
  // 按 UTF-8 字节序排：同一批候选永远得到同一个扫描顺序（可单测、可复现）
  names.sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
  if (names.length > limit) {
    result.truncated = true
    names.length = limit
  }
  for (const name of names) {
    result.scanned += 1
    const candidate = join(parent, name)
    try {
      access(candidate, fsConstants.W_OK)
    } catch {
      continue
    }
    if (!readDiaryMarker(candidate, io)) continue
    result.dirs.push(candidate)
  }
  return result
}

/**
 * 扫根闸门：这个父目录**许不许**被扫一层。
 *
 * 这是"绝不扫全盘、绝不扫桌面以外"的机械保证（方案 §a.9.2 闸门 2）：
 *   - 必须是绝对路径，且至少三段（`/Users/某个人` 才两段 → 不许扫，太浅了）；
 *   - 排除 `/`、`/Users`、`/Volumes`、`/home`、`/private`、`/tmp`、`/var` 这类"一扫码全机"的根；
 *   - 排除家目录本身（用户桌面在它下面，但那是另一层）；
 *   - Windows 上排除盘符根（`C:\`）。
 *
 * 独立导出是为了让单测直接打它——藏在 `recoverDiaryDir` 里就没法逐条证明了。
 */
export function isWithinScanRoot(parent, { homedir: home = osHomedir() } = {}) {
  if (typeof parent !== 'string' || !parent.trim()) return false
  if (!isAbsolute(parent)) return false
  const cleaned = parent.replace(/[/\\]+$/, '') || parent
  // 盘符根 / 文件系统根：下面再扫一层就是全盘
  if (/^[a-zA-Z]:$/.test(cleaned) || cleaned === '/') return false
  const normalized = cleaned.replace(/\\/g, '/')
  const forbidden = new Set(['', '/', '/users', '/volumes', '/home', '/root', '/private', '/tmp', '/var', '/applications', '/library', '/system'])
  if (forbidden.has(normalized.toLowerCase())) return false
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length < 3) return false
  if (typeof home === 'string' && home.trim()) {
    const homeClean = home.replace(/[/\\]+$/, '').replace(/\\/g, '/')
    if (normalized === homeClean) return false
    // 家目录的上一级（/Users）已经在 forbidden 里挡掉了
  }
  return true
}

/** 'YYYY-MM-DD HH:MM:SS' → 毫秒；看不懂就返回 Infinity（等于"没有抑制窗"）。 */
function stampMs(stamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(stamp ?? '').trim())
  if (!match) return Infinity
  const at = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
  ).getTime()
  return Number.isNaN(at) ? Infinity : at
}

/** 编辑距离（截断到 n 字符，避免长路径把事件循环拖死）。 */
function levenshtein(left, right) {
  const a = String(left ?? '')
  const b = String(right ?? '')
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let previous = new Array(b.length + 1)
  let current = new Array(b.length + 1)
  for (let index = 0; index <= b.length; index += 1) previous[index] = index
  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row
    for (let col = 1; col <= b.length; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1
      current[col] = Math.min(previous[col] + 1, current[col - 1] + 1, previous[col - 1] + cost)
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[b.length]
}

/** 候选里"这个本子"的实证篇数：「三」段里哪些日记真的在它里面。 */
function evidenceHits(candidate, recent, io) {
  const exists = io.exists ?? existsSync
  const labels = (Array.isArray(recent) ? recent : [])
    .map((row) => String(row?.label ?? ''))
    .filter((label) => /^\d{4}-\d{2}-\d{2}$/.test(label))
  if (!labels.length) return 0
  let hits = 0
  for (const label of labels) {
    if (safeExists(join(candidate, `${label}.md`), exists)) hits += 1
  }
  return hits
}

/**
 * 证据闸门：只有标记、既没有历史日记也没有记录文档的空壳目录 → 不算候选。
 * 「三」段为空（全新本子）时，至少要看到 `AI娘日记记录.md` 跟着搬过来了。
 */
function hasEvidence(candidate, recent, io) {
  const exists = io.exists ?? existsSync
  const labels = (Array.isArray(recent) ? recent : [])
    .map((row) => String(row?.label ?? ''))
    .filter((label) => /^\d{4}-\d{2}-\d{2}$/.test(label))
  if (labels.length) return evidenceHits(candidate, recent, io) > 0
  return safeExists(join(candidate, DIARY_DOC_FILE), exists)
}

/**
 * 候选目录的**记录文档自己说**本子在哪儿。
 *
 * 只在自己那份文档已经丢了（只能重建）时才要求这一条：那时候「最近日记」「不自动认回」
 * 这些证据全没了，光靠"旁边有个带标记的日记本"就搬过去，很容易认成别人的本子。
 * 真被改名的那本，它自己的记录文档里写的还是旧路径——这一条正是"还是同一个人"的凭证。
 */
function claimsDir(candidate, wantDir, io) {
  const read = readDiaryDocFile(docPathFor(candidate), io)
  if (!read.exists || String(read.text).trim() === '') return false
  let parsed = null
  try {
    parsed = parseDiaryDoc(read.text)
  } catch {
    return false
  }
  const claims = String(parsed?.config?.dir ?? '').replace(/[/\\]+$/, '')
  return claims !== '' && claims === wantDir
}

/** 四级比较器（方案 §a.9.2）：base 粗排 → 前 8 名算全路径 → 实证篇数多者优先 → 字节序兜底。 */
function rankCandidates(original, candidates, recent, io, startedAt) {
  const originalBase = basename(original).slice(0, 128)
  const scored = []
  for (const candidate of candidates) {
    // 预算闸：扫到一半发现超时也立即停，别再算距离
    if (Date.now() - startedAt > RECOVERY_BUDGET_MS) return { dir: '', budget: true }
    scored.push({
      candidate,
      base: levenshtein(originalBase, basename(candidate).slice(0, 128)),
      hits: evidenceHits(candidate, recent, io),
    })
  }
  scored.sort((left, right) => left.base - right.base || compareBytes(left.candidate, right.candidate))
  const head = scored.slice(0, 8)
  const originalFull = original.slice(0, 512)
  for (const item of head) item.full = levenshtein(originalFull, item.candidate.slice(0, 512))
  head.sort(
    (left, right) =>
      left.base - right.base ||
      left.full - right.full ||
      right.hits - left.hits ||
      compareBytes(left.candidate, right.candidate),
  )
  return { dir: head[0]?.candidate ?? '', budget: false }
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(String(left ?? ''), 'utf8'), Buffer.from(String(right ?? ''), 'utf8'))
}

/**
 * 改名认回（方案 §a.9.2）。**只在 `dirStateOf(dir) === 'missing'` 时调用**，别处不许调。
 *
 * 四道闸门（任一不满足 → 一次 readdir 都不发）：
 *   1. `dir` 是绝对路径、有父目录可扫；
 *   2. 父目录过扫根闸门（`isWithinScanRoot`）；
 *   3. 用户 10 分钟内手动指定过本子 → 他的意图比启发式权威；
 *   4. 120s 内已经扫过 → 直接用缓存。
 *
 * 然后：一层 readdir（≤500 项）→ 标记命中 → 证据闸门 → 四级比较器挑最像的那个。
 *
 * @param {{dir:string, io?:object, now?:number, recent?:Array, manualAt?:string, rejected?:string[]}} options
 * @returns {{ok:boolean, dir?:string, from:string, candidates:string[], suggestions:Array,
 *   reason?:string, cached?:boolean, elapsedMs:number}}
 */
export function recoverDiaryDir({ dir, io = {}, now = Date.now(), recent = [], manualAt = '', rejected = [], requireClaim = false } = {}) {
  const startedAt = Date.now()
  const at = Number(now) || Date.now()
  const elapsed = () => Date.now() - startedAt

  const fail = (reason, extra = {}) => ({
    ok: false,
    from: typeof dir === 'string' ? dir : '',
    reason,
    candidates: [],
    suggestions: [],
    elapsedMs: elapsed(),
    ...extra,
  })

  // 闸门 1：相对路径没有"父目录"可扫
  if (typeof dir !== 'string' || !dir.trim() || !isAbsolute(dir)) return fail('no-parent')
  const cleaned = dir.replace(/[/\\]+$/, '')
  const parent = dirname(cleaned)
  if (!parent || parent === cleaned) return fail('no-parent')

  // 闸门 2：扫根闸门
  if (!isWithinScanRoot(parent)) return fail('scan-root')

  // 闸门 3：抑制窗 —— 连 readdir 都不许发
  const manualMs = stampMs(manualAt)
  if (manualMs !== Infinity && at - manualMs >= 0 && at - manualMs < RECOVERY_MANUAL_WINDOW_MS) {
    return fail('suppressed')
  }

  // 闸门 4：缓存（命中就直接用，不重扫）
  const cached = recoverCache.get(cleaned)
  if (cached && at - cached.at < RECOVERY_CACHE_TTL_MS) {
    return { ...cached.value, cached: true, elapsedMs: elapsed() }
  }
  const remember = (value) => {
    recoverCache.set(cleaned, { at, value })
    return value
  }

  const listing = listMarkerDirs(parent, { io })
  const markers = listing.dirs.filter((candidate) => candidate !== cleaned)
  if (!markers.length) {
    return remember(fail('no-candidate', { scanned: listing.scanned, truncated: listing.truncated }))
  }

  const evidence = markers.filter((candidate) => hasEvidence(candidate, recent, io))
  // 文档已经丢了、只能重建时：还要候选自己的记录文档写着"本子就是那个旧路径"，才算同一个人
  const claimed = requireClaim ? evidence.filter((candidate) => claimsDir(candidate, cleaned, io)) : evidence
  if (!claimed.length) {
    const guesses = evidence.slice(0, 3).map((candidate) => ({
      dir: candidate,
      reason: '找到了日记，但没法确认就是这本',
    }))
    return remember(fail('no-evidence', { candidates: markers, suggestions: guesses, scanned: listing.scanned }))
  }

  const rejectedSet = new Set((Array.isArray(rejected) ? rejected : []).map((item) => String(item ?? '').trim()))
  const allowed = claimed.filter((candidate) => !rejectedSet.has(candidate))
  const suggestions = claimed
    .filter((candidate) => rejectedSet.has(candidate))
    .slice(0, 3)
    .map((candidate) => ({ dir: candidate, reason: '你之前说过「不是我那个」' }))
  if (!allowed.length) {
    return remember(fail('rejected', { candidates: claimed, suggestions }))
  }

  const ranked = rankCandidates(cleaned, allowed, recent, io, startedAt)
  if (!ranked.dir) {
    return remember(fail('budget', { candidates: claimed, suggestions }))
  }
  return remember({
    ok: true,
    dir: ranked.dir,
    from: dir,
    candidates: claimed,
    suggestions,
    elapsedMs: elapsed(),
  })
}

/** 配置校验通过之后，把变更合进文档配置（updatedAt 一定刷新，好让用户看见"改过"）。 */
export function mergeDocConfig(current, patch, { now = Date.now(), recovered = undefined } = {}) {
  const base = current && typeof current === 'object' ? current : {}
  const next = {
    enabled: base.enabled === true,
    dir: typeof base.dir === 'string' ? base.dir : '',
    time: base.time || DAY_ROLLOVER_TIME,
    diarist: typeof base.diarist === 'string' ? base.diarist : '',
    autoCreate: base.autoCreate !== false,
    schema: DIARY_DOC_SCHEMA,
    updatedAt: formatStamp(now),
    recovered: recovered === undefined ? base.recovered ?? null : recovered,
    // 增补 2026-10-24：这两项只由宿主写，前端传了也不收
    dirManualAt: typeof base.dirManualAt === 'string' ? base.dirManualAt : '',
    dirRejected: Array.isArray(base.dirRejected) ? base.dirRejected.slice() : [],
  }
  const changes = patch && typeof patch === 'object' ? patch : {}
  for (const key of ['enabled', 'dir', 'time', 'diarist', 'autoCreate']) {
    if (key in changes) next[key] = changes[key]
  }
  return next
}

/* ─────────────── 换本子：把旧本子里的日记搬到新位置（方案 §a.6 第 5 步） ─────────────── */

const OUR_DIARY_FILE = /^\d{4}-\d{2}-\d{2}\.md(\.bak)?$/

/**
 * 换日记本时，把旧目录里**属于日记本的东西**搬到新目录：`YYYY-MM-DD.md`、它们的 `.bak`，
 * 以及可选带上记录文档本身（`exclude` 里点名的不搬）。
 *
 * 三条硬线：
 *   1. **绝不覆盖**新目录里的同名文件（那是用户的东西）——跳过并在 `skipped` 里报出来；
 *   2. 跨卷（rename 抛 EXDEV）时先复制、**校验大小一致**、才删源文件；不一致就删掉半成品、
 *      整体失败——宁可这次换本子不成，也不能让用户的日记变成半截；
 *   3. 中途失败**整体回滚**：已经搬过去的再搬回来，并把失败的文件名报出去。
 *
 * 这条函数只搬文件，不碰指针、不碰记录文档内容（那是 index.js 的 §a.5 顺序）。
 */
export function moveDiaryDir({ from, to, exclude = [], io = {} } = {}) {
  const readdir = io.readdir ?? readdirSync
  const rename = io.rename ?? renameSync
  const copy = io.copy ?? copyFileSync
  const unlink = io.unlink ?? unlinkSync
  const exists = io.exists ?? existsSync
  const stat = io.stat ?? statSync
  if (typeof from !== 'string' || !from.trim() || typeof to !== 'string' || !to.trim()) {
    return { ok: false, reason: '没有要搬的目录', moved: [], skipped: [] }
  }
  if (from === to) return { ok: true, moved: [], skipped: [] }
  const skipSet = new Set(Array.isArray(exclude) ? exclude : [])
  let names = []
  try {
    names = readdir(from)
      .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
      .filter((name) => typeof name === 'string' && (name === DIARY_DOC_FILE || OUR_DIARY_FILE.test(name)))
      .filter((name) => !skipSet.has(name))
  } catch {
    // 旧目录不可读（被删/没权限）：没有可搬的，不算失败
    return { ok: true, moved: [], skipped: [] }
  }
  const moved = []
  const skipped = []
  let current = ''
  try {
    for (const name of names) {
      current = name
      const src = join(from, name)
      const dst = join(to, name)
      if (exists(dst)) {
        skipped.push(name)
        continue
      }
      try {
        rename(src, dst)
      } catch (error) {
        if (error?.code !== 'EXDEV') throw error
        // 跨卷：复制 → 比大小 → 才删源
        copy(src, dst)
        const sizeSrc = Number(stat(src)?.size ?? -1)
        const sizeDst = Number(stat(dst)?.size ?? -2)
        if (sizeSrc !== sizeDst) {
          try {
            unlink(dst)
          } catch {
            /* 半成品删不掉也只报失败，不影响源文件 */
          }
          throw new Error(`复制后大小不一致（${sizeSrc} ≠ ${sizeDst}）：${name}`)
        }
        unlink(src)
      }
      moved.push(name)
    }
  } catch (error) {
    // 回滚：把已经过去的搬回来
    const restored = []
    for (const name of moved.slice().reverse()) {
      try {
        rename(join(to, name), join(from, name))
        restored.push(name)
      } catch {
        /* 搬不回来就留在新位置，至少不丢 */
      }
    }
    return {
      ok: false,
      code: 'dir-move-failed',
      reason: `${reasonOf(error)}（${current}）`,
      failedName: current,
      restored,
      moved: [],
      skipped,
    }
  }
  return { ok: true, moved, skipped }
}

/* ─────────────── 写日记：先文档后实际路径（方案 §a.5） ─────────────── */

/**
 * 一次写日记的提交事务。
 *
 * 顺序是契约，不能换：
 *   ① 记录文档：把「二、今天」写实，并在「五、待办理」记上"正在写"（原子写）；
 *      —— 这一步失败就**原地停**，一个字都不许落到日记本里；
 *   ② 实际路径：重建目录（如果被删了）+ 落盘 `YYYY-MM-DD.md`（先 .bak 再覆盖）；
 *   ③ 收尾：成功就把新行写进「三、最近的日记」并清掉「待办理」；
 *      失败就把原因写进「四、最近一次没写成」并清掉「待办理」（方案 §a.6 回滚矩阵）。
 *
 * @returns {{ok:boolean, file?:string, backup?:string, docPath?:string, docSkipped?:boolean,
 *   code?:string, message?:string, stage?:string, elapsedMs:number, docRolledBack?:boolean, docText?:string}}
 */
export function commitDiaryWrite({
  docFile,
  docText,
  dir,
  label,
  content,
  today = null,
  row = null,
  failureHint = '',
  io = {},
  now = Date.now(),
} = {}) {
  const startedAt = Date.now()
  const elapsed = () => Date.now() - startedAt
  const base = typeof docText === 'string' ? docText : ''
  const stamp = formatStamp(now)

  // ① 记录文档（含「待办理」）——先落盘，出问题就停在这儿
  const pendingText = patchPendingSection(patchTodaySection(base, today), {
    kind: 'write',
    // 「五、待办理」里记的是**日记文件**的落点，不是记录文档自己的路径
    dir: typeof dir === 'string' && dir.trim() ? join(dir.trim(), `${label}.md`) : '',
    label,
    since: stamp,
  })
  const docStep = writeTextAtomic(docFile, pendingText, io)
  if (!docStep.ok) {
    return {
      ok: false,
      code: 'doc-write-failed',
      stage: 'doc',
      message: docStep.reason,
      docPath: docFile,
      elapsedMs: elapsed(),
    }
  }

  // ② 实际路径
  const written = writeDiaryFile({ dir, label, content, io })
  if (!written?.ok) {
    // 回滚：把失败写进文档，并清掉「待办理」——下次打开设置页能一眼看到为什么没成
    const rolled = patchPendingSection(
      patchFailureSection(pendingText, {
        at: formatStamp(),
        code: 'write-failed',
        reason: written?.reason ?? '写不进去',
        hint: failureHint,
      }),
      null,
    )
    const rollback = writeTextAtomic(docFile, rolled, io)
    return {
      ok: false,
      code: 'write-failed',
      stage: 'file',
      message: written?.reason ?? '写不进去',
      docPath: docFile,
      docRolledBack: rollback.ok === true,
      elapsedMs: elapsed(),
    }
  }

  // ③ 收尾：最近日记 + 「今天已经写过」+ 清待办理
  const parsed = parseDiaryDoc(pendingText)
  const rows = row ? [row, ...parsed.recent.filter((item) => item.label !== row.label)] : parsed.recent
  const finished = patchPendingSection(
    patchTodaySection(patchRecentSection(pendingText, rows), today ? { ...today, written: true } : today),
    null,
  )
  const docDone = writeTextAtomic(docFile, finished, io)
  return {
    ok: true,
    file: written.file,
    backup: written.backup,
    docPath: docFile,
    // 收尾这次没写进去（通常是内容没变或磁盘忙）：日记本身是写成功的，不能因此报失败
    docSkipped: docDone.skipped === true,
    docWarning: docDone.ok === true ? '' : docDone.reason,
    elapsedMs: elapsed(),
    docText: docDone.ok === true ? finished : pendingText,
  }
}

