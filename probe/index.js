/**
 * dsh-pet-cuteness-plugin · M0 探针（宿主半）
 *
 * 这一步只证明三件事，其它全都不要：
 *   1. 一个 bundle 插件能被装上、行能挂上、`dump-config` 不报错；
 *   2. 能在 **agent 作用域**里给系统提示词**追加**一段人设，而不是覆盖别人的；
 *   3. 能准确认出「现在真正在用的模型」。
 *
 * v3 的结构变化：**纯逻辑全部在 `src/` 下**（可单测、不 import 任何 @deepseek-ai/*），
 * 本文件只负责接线——拿服务、注册段落、读投影、记日志。
 * 这样做的实际好处：真机装不上时，核心逻辑至少是被 105 个测试验证过的。
 *
 * 刻意不做：不翻译、不读写文件、不发网络请求、不注册工具、不改请求消息、
 * 不注册会话投影（投影的 stateSchema 要 zod，属于 M1 的依赖决策，M0 不引入）。
 */

import { createRequire } from 'node:module'
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  THINKING_LANGUAGE_SECTION,
  buildStableSection,
  isMainAgent,
  resolvePersonaOrder,
} from './src/persona-text.mjs'
import { cardToPersonaText, matchByCardRules, pickQuirk } from './src/persona-card.mjs'
import { readSelection, resolvePersona } from './src/model-identity.mjs'
import {
  DEFAULT_ENABLED,
  FLAG_KEYS,
  flagSources,
  flagsForSession,
  normalizeFlags,
} from './src/toggle-state.mjs'
import { LINE_LIMITS, cardLineTexts, createLineFeed, emptyRejections, rotateLine } from './src/voice-lines.mjs'
import { buildDiaryPrompt, collectDay, localDayBounds, logicalDayFor, readSessionEvents, zstdAvailable } from './src/diary-source.mjs'
import {
  buildActivationRequest,
  checkDiaristSupported,
  pickDefaultDiarist,
  renderDiaryFile,
  tidyDiaryBody,
  validateDiaryBody,
} from './src/diary-writer.mjs'
import {
  DIARY_CONFIG_FILE,
  DIARY_DOC_FILE,
  DIARY_DOC_SCHEMA,
  DIARY_MARKER_FILE,
  commitDiaryWrite,
  diaryPath,
  dirStateOf,
  docPathFor,
  ensureDiaryMarker,
  firstSentences,
  legacyBackupPathFor,
  listMarkerDirs,
  mergeDocConfig,
  moveDiaryDir,
  migrateLegacyDiary,
  normalizeDiaryConfig,
  readDiaryDocFile,
  readDiaryMarker,
  readDiaryPointer,
  reasonOf,
  recoverDiaryDir,
  resetRecoveryCache,
  validateDiaryPatch,
  writeDiaryPointer,
  writeTextAtomic,
} from './src/diary-store.mjs'
import {
  formatStamp,
  parseDiaryDoc,
  parsePathList,
  patchConfigSection,
  patchFailureSection,
  patchPendingSection,
  patchRecentSection,
  patchTodaySection,
  recentRowsOf,
  renderDiaryDoc,
} from './src/diary-doc.mjs'
import {
  AFFINITY_MAX,
  TREATS_MAX,
  backupPathFor,
  clampPoints,
  clampTreats,
  readPoints,
  readTreats,
  sameExceptPoints,
  sameExceptTreats,
  verifyPoints,
  verifyTreats,
  withPoints,
  withTreats,
} from './src/affinity-store.mjs'
import {
  emptyStore,
  needsRewrite,
  normalizeStore,
  parseStore,
  serializeStore,
  withDefaults,
  withSessionFlags,
} from './src/toggle-store.mjs'
import {
  BRIDGE_ERRORS,
  parseDefaultsPatch,
  parseSessionPatch,
  statePayload,
} from './src/toggle-bridge.mjs'

export const name = 'dsh-pet-cuteness-plugin'

/** 不强制 inject：服务缺失时静默降级，绝不能 fatal 掉整个宿主进程。 */
export const inject = []

const HERE = dirname(fileURLToPath(import.meta.url))

/* ── 配置（Cordis Config / Schemastery，t4/F15）────────────────────────────
 *
 * 「统计多久算新鲜」以前是硬编码的 10 分钟，用户在 cordis.patch.yml 里改不了，
 * 而且和契约（60 秒）对不上。这里声明成带默认值的 Schema，并挂进 patch 行。
 *
 * 为什么用 try + 动态 import：从插件的真实路径（probe/）裸 import
 * '@deepseek-ai/schemastery' 会 ERR_MODULE_NOT_FOUND——依赖只装在被 link 过去的
 * profile 里；而本项目不许新增 dependencies（check-manifest 硬线）。
 * 解析得到就导出真正的 Schema（宿主会按它校验/填默认值）；解析不到就不导出
 * Config，apply 里按默认 60000 工作，行为完全一致。
 */
let Schemastery = null
try {
  const mod = await import('@deepseek-ai/schemastery')
  Schemastery = mod?.default ?? mod ?? null
} catch {
  // 从 probe/ 真实路径裸 import 会 ERR_MODULE_NOT_FOUND（依赖装在被 link 的 profile 里）；
  // 退一步按 DSH_HOME 找 profile 里那份——同一台机器上它一定在。
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const profile of readdirSync(join(home, 'profiles'))) {
      try {
        // 用那一层 profile 的解析器去 resolve（包入口由它的 package.json exports 决定，别猜 index.js）
        const req = createRequire(join(home, 'profiles', profile, 'noop.js'))
        const file = req.resolve('@deepseek-ai/schemastery')
        const mod = await import(pathToFileURL(file).href)
        Schemastery = mod?.default ?? mod?.Schemastery ?? mod ?? null
        if (typeof Schemastery === 'function') break
        Schemastery = null
      } catch {
        /* 这个 profile 没装，看下一个 */
      }
    }
  } catch {
    Schemastery = null
  }
}

/**
 * 素材在包内（`probe/data/personas.zh.json`）。
 *
 * 为什么不是 `../data/`：`probe/` 就是**安装根**，装进 profile 之后包外的东西
 * 根本不在。素材必须随包走，否则装完就是「读者在但素材不在」。
 * 上游真源仍是 `../data/personas/personas.zh.json`，由 `npm run sync-data` 同步。
 */
const PERSONA_FILE = join(HERE, 'data', 'personas.zh.json')

/**
 * dsh-pet 的显示参数（它自己 `pet.json` 里 `display` 那一段）。
 *
 * 台词气泡挂在 `shell.overlay`、要贴着宠物，而宠物位置是用户随手拖出来的，
 * 写死 right/bottom 的后果就是「挂件被拖走了，气泡还钉在输入框上方」。
 * 所以每次问一次"她现在在哪"。读不到返回 null（气泡退回默认位置，不报错、不阻塞）。
 */
function readPetDisplay() {
  const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'pet.json')
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const display = parsed && typeof parsed === 'object' ? parsed.display : null
    if (!display || typeof display !== 'object') return null
    return {
      visible: display.visible !== false,
      size: Number(display.size) || 160,
      right: Number(display.right) || 0,
      bottom: Number(display.bottom) || 0,
      bubbleScale: Number(display.bubbleScale) || 1,
    }
  } catch {
    return null
  }
}

/**
 * `~/.dsh/pet.json` 的绝对路径（dsh-pet 自己的状态文件）。
 *
 * 注意它与 `plugin-data/` 的区别：那里是**我们**的数据，这里是**它的**数据。
 * 我们只在用户明确要求改亲密度时碰它，且必定先备份、改完回读核对。
 */
function petFilePath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'pet.json')
}

/**
 * 问一下挂件在不在、开没开。
 *
 * 为什么用 `ctx.get('pet', false)` 而不是在 `inject` 里声明依赖：
 * 声明依赖会让「没装 dsh-pet 的机器」直接装不上我们的插件（挂件是可选伙伴，不是前置条件）。
 * 软探测拿不到就回 `installed:false`，界面给一行提示，其余功能照常。
 *
 * @param {any} ctx
 * @returns {{ installed: boolean, enabled: boolean }}
 */
function probePet(ctx) {
  let pet = null
  try {
    pet = ctx.get('pet', false)
  } catch {
    pet = null
  }
  if (!pet) return { installed: false, enabled: false }
  let enabled = false
  try {
    enabled = typeof pet.isEnabled === 'function' ? pet.isEnabled() !== false : true
  } catch {
    enabled = false
  }
  return { installed: true, enabled }
}


/**
 * 挂件**内存里**现在是多少（不是 pet.json 里）。
 *
 * 为什么必须看内存：`PetService` 构造时读一次 pet.json，之后一律拿内存快照 `flush()` 整个覆盖回去。
 * 只改文件不改内存，用户就会看到"改了→过一会儿自己变回去"（2026-10-26 实撞：文件写 123456，
 * `/api/pet/state` 里还是 415）。所以判断"有没有生效"的唯一可信口径是内存。
 *
 * @returns {object|null} `PetService#state()` 的返回；拿不到就是 null
 */
function livePetView(ctx) {
  let pet = null
  try {
    pet = ctx.get('pet', false)
  } catch {
    return null
  }
  if (!pet || typeof pet.state !== 'function') return null
  try {
    const view = pet.state()
    return view && typeof view === 'object' ? view : null
  } catch {
    return null
  }
}

/** 内存里的亲密度；拿不到回 null。 */
function livePoints(ctx) {
  const view = livePetView(ctx)
  const points = view && view.affinity ? Number(view.affinity.points) : NaN
  return Number.isFinite(points) ? points : null
}

/**
 * 内存里的小鱼干数量；拿不到回 null。
 *
 * 注意挂件的字段叫 `stocked`（不是 `treats`）——`treats.treats` 只存在于 pet.json 里，
 * 内存视图里它被改名成了 `stocked`，两个名字都踩过才写在这里。
 */
function liveTreats(ctx) {
  const view = livePetView(ctx)
  const stocked = view && view.treats ? Number(view.treats.stocked) : NaN
  return Number.isFinite(stocked) ? stocked : null
}

/** 挂件自己允许囤多少小鱼干（它的 `treats.max`，默认 20）；拿不到回 null。 */
function liveTreatsMax(ctx) {
  const view = livePetView(ctx)
  const max = view && view.treats ? Number(view.treats.max) : NaN
  return Number.isFinite(max) && max > 0 ? max : null
}

/**
 * 直接改挂件**内存**里的那个数，然后让它自己存一次盘。
 *
 * 为什么走内存而不是只改文件：`PetService` 只在构造时读 pet.json，之后一律拿内存快照
 * `flush()` 整个覆盖回去——只改文件等于白改（2026-10-26 实测：文件 123456，界面还是 415）。
 *
 * 为什么不新增「官方 setter」：挂件没开放改亲密度/小鱼干的接口（`setEnabled`/`setName`
 * 那些有，这两个没有）。所以这里退一步，改它自己的 `ledger.snapshot` 再调它自己的
 * `flush()`——等于替它做一次它内部本来也会做的写入。全程 try/catch + 读回校验，
 * 拿不到内部结构就返回 false，交给调用方走「重载」或「回滚」，不硬闯。
 *
 * @param {any} ctx
 * @param {'points'|'treats'} kind
 * @param {number} value
 * @returns {boolean} 是否真的改到了内存
 */
function applyLiveNumber(ctx, kind, value) {
  let pet = null
  try {
    pet = ctx.get('pet', false)
  } catch {
    return false
  }
  const ledger = pet && pet.ledger
  const snapshot = ledger && ledger.snapshot
  if (!snapshot) return false
  try {
    if (kind === 'points') {
      if (!snapshot.affinity || typeof snapshot.affinity !== 'object') return false
      snapshot.affinity.points = value
    } else {
      if (!snapshot.treats || typeof snapshot.treats !== 'object') {
        // 老版本的扁皮形状：treats 直接是数字。
        if (typeof snapshot.treats !== 'number') return false
        snapshot.treats = value
      } else {
        snapshot.treats.treats = value
      }
    }
    // 让它把内存快照落盘：下一次 flush 才不会把我们刚写的值盖回去。
    if (typeof pet.flush === 'function') pet.flush()
    return true
  } catch {
    return false
  }
}

/**
 * 让挂件**重新读一次 pet.json**。
 *
 * 走过的弯路（别再走一遍）：
 *   - `pluginManager.reload(['pet'])` 不走这条路：它内部靠 `hmr.reconcileProfile` 比对磁盘模块，
 *     只重载「文件改过的模块」，返回的是 `{warnings, restartReason}` 而不是 id 数组。拿它当
 *     "重载成功"的判断永远是 false（旧代码就是这么错的）。
 *   - 没有 HMR 时它连重载都不做，只 compose 一遍就返回。
 * 真正能用的入口是 cordis 每个插件自己的 fiber：`Fiber#restart()` =
 * 「dispose 之后用当前 config 立刻重新加载」。从 `loader.entries()` 里找到挂件那一条即可。
 *
 * @returns {Promise<boolean>} 是否真的重载了
 */
async function restartPetPlugin(ctx) {
  const loader = (() => {
    try {
      return ctx.get('loader', false) || ctx.loader
    } catch {
      return null
    }
  })()
  if (!loader || typeof loader.entries !== 'function') return false
  let entries = []
  try {
    entries = [...loader.entries()]
  } catch {
    return false
  }
  for (const entry of entries) {
    const id = String((entry && entry.options && entry.options.id) || (entry && entry.id) || '')
    if (id !== 'pet') continue
    const fiber = entry && entry.fiber
    if (!fiber || typeof fiber.restart !== 'function') continue
    try {
      await fiber.restart()
      return true
    } catch (error) {
      // 重载失败不能当成"写成功"：调用方会回滚文件，用户至少不会被骗。
      return false
    }
  }
  return false
}

/**
 * 判断写进去的值有没有真的被挂件接住，没接住就让它重载一次再验。
 *
 * @param {any} ctx
 * @param {() => number|null} readLive 读内存当前值
 * @param {number} value 目标值
 * @returns {Promise<'live'|'reloaded'|'stale'>}
 */
async function adoptLiveNumber(ctx, readLive, value, kind = 'points') {
  let live = null
  try {
    live = readLive(ctx)
  } catch {
    live = null
  }
  // 读不到内存（老版本挂件没有 state()、或此刻没装）：文件已经写成目标值，
  // 它下次启动会从文件读——这是「重启后生效」，不是失败。
  if (live === null) return 'pending-restart'
  if (live === value) return 'live'

  // 第一选择：直接改内存 + 让它自己存盘。比重新挂载整个挂件轻，也不会让她闪一下。
  if (applyLiveNumber(ctx, kind, value)) {
    for (let i = 0; i < 10; i += 1) {
      if (readLive(ctx) === value) return 'live'
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  }

  const restarted = await restartPetPlugin(ctx)
  if (!restarted) return 'stale'
  // 重载是异步的，给它一口气把服务重新建起来
  for (let i = 0; i < 20; i += 1) {
    if (readLive(ctx) === value) return 'reloaded'
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return 'stale'
}

/**
 * 把亲密度写进 `pet.json`，并让它重新加载。
 *
 * 为什么必须「备份 → 写 → reload → 回读」四步：
 * dsh-pet 的 `loadPetPersist` 只在 PetService 构造时读一次文件，`flush()` 又会拿**内存快照**
 * 整份覆盖。所以：
 *   - 不 reload：下一轮 flush 直接把用户刚改的数盖回去，看起来"改了又变回来"；
 *   - 不核对：写盘失败/被夹回去也当成功，用户点十次都没效果；
 *   - 不备份：reload 不可用或文件损坏时没有退路。
 * `reload` 返回空数组 = 没有 HMR、根本没重载（`pluginManager.reload` 的既有语义），
 * 这种情况一律按失败回滚，而不是留一个"半改"的状态。
 *
 * @param {any} ctx
 * @param {number} points 已 clamp 的整数
 * @returns {Promise<{ok: true, points: number, applied: 'reloaded' | 'pending-restart'} | {ok: false, code: string, message?: string}>}
 */
async function writePetNumber(ctx, spec) {
  const { file, value, key, read, patch, sanity, verify, unreadable } = spec
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, code: 'no-pet', message: '还没找到挂件的状态文件（pet.json），是不是没装 dsh-pet？' }
  }
  const readBack = read(text)
  if (!readBack.ok) {
    return { ok: false, code: readBack.code, message: unreadable ?? '挂件的状态文件读不懂（可能正在被写），等一秒再试' }
  }
  const next = patch(text, value)
  if (!next.ok) return { ok: false, code: next.code }
  const guard = sanity(readBack.json, JSON.parse(next.text))
  if (!guard.ok) {
    // 理论到不了这里（patch 只动一个键），但宁可拒绝也不写一份丢掉用户资产的文件。
    return { ok: false, code: 'internal', message: '内部校验失败（会动到别的字段），已放弃写入：' + guard.keys.join(',') }
  }

  // ① 备份：覆盖式，只留最近一次。它是回滚的唯一退路。
  const backup = backupPathFor(file)
  try {
    writeFileSync(backup, text, 'utf8')
  } catch (error) {
    return { ok: false, code: 'backup-failed', message: '备份挂件状态失败，没敢往下写：' + String(error?.message ?? error) }
  }

  // ③ 原子写：先写临时文件再 rename，避免写到一半被读到半截 JSON。
  const tmp = file + '.tmp-' + String(process.pid)
  try {
    writeFileSync(tmp, next.text, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 临时文件可能本来就没建起来，忽略 */
    }
    try {
      writeFileSync(file, text, 'utf8')
    } catch {
      /* 回滚也失败时不再掩盖原始错误 */
    }
    return { ok: false, code: 'write-failed', message: '写挂了：' + String(error?.message ?? error) }
  }

  // ③ 让挂件内存接住新值；接不住就重载它（此时文件已是新值，重载才读得到）。
  //    顺序不能反：先改内存再写文件的话，重载这一步会读到旧文件，白费。
  const adopted = typeof spec.live === 'function' ? await adoptLiveNumber(ctx, spec.live, value, spec.kind) : 'live'


  // ④ 回读核对：文件与挂件内存都得等于目标值，否则回滚。
  let after = ''
  try {
    after = readFileSync(file, 'utf8')
  } catch {
    after = ''
  }
  const check = verify(after, value)
  if (!check.ok || adopted === 'stale') {
    try {
      writeFileSync(file, text, 'utf8')
    } catch {
      /* 回滚失败也无法再补救，原样报错让用户知道 */
    }
    return {
      ok: false,
      code: 'verify-failed',
      message: adopted === 'stale' ? '写进去了，但挂件没重新读它（重载失败），已还原' : '写进去又对不上，已还原',
    }
  }

  return { ok: true, [key]: check[key], applied: adopted }
}

/** 改亲密度：`{id:'points'}` 那一套（读 points / 只动 affinity.points / 回读 points）。 */
function writePetAffinity(ctx, points) {
  return writePetNumber(ctx, {
    file: petFilePath(),
    value: points,
    key: 'points',
    read: readPoints,
    patch: withPoints,
    sanity: sameExceptPoints,
    verify: verifyPoints,
    live: livePoints,
    kind: 'points',
    unreadable: '挂件的状态文件读不懂（可能正在被写），等一秒再试',
  })
}

/**
 * 改小鱼干：和小鱼干同一套四步流程（备份 → 原子写 → reload → 回读核对）。
 *
 * 为什么复用 writePetNumber 而不是另写一份：这套流程里每一步都是"吃过亏才加的"，
 * 抄一份出来迟早有一份漏掉 reload 或漏掉回读，而漏掉的那一份会静默丢用户数据。
 */
function writePetTreats(ctx, treats) {
  return writePetNumber(ctx, {
    file: petFilePath(),
    value: treats,
    key: 'treats',
    read: readTreats,
    patch: withTreats,
    sanity: sameExceptTreats,
    verify: verifyTreats,
    live: liveTreats,
    kind: 'treats',
    unreadable: '挂件的状态文件读不懂（可能正在被写），等一秒再试',
  })
}

/**
 * 开关状态的落盘位置。
 *
 * 为什么不写 profile 目录：profile 由宿主独占管理（运行期写 `cordis.patch.yml`
 * 会被当成改配置、HMR 会杀掉在途 turn）。`plugin-data/` 才是"插件自己的数据"该去的地方。
 */
const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugin-data')
const TOGGLE_FILE = join(DATA_DIR, 'dsh-ai-waifu.json')
/** 日记指针和开关分开放：用户删掉开关文件时不该连日记设置一起丢。 */
const DIARY_FILE = join(DATA_DIR, DIARY_CONFIG_FILE)
/**
 * 记录文档的暂住地：**还没选日记本**的时候（刚装、或用户把本子删了）先放 plugin-data。
 *
 * 为什么不直接放用户桌面：没经过用户同意就往桌面写东西，是最招人烦的一类行为。
 * 一旦选了日记本，文档就搬进日记本里（用户看得见、能手改、能跟本子一起备份）。
 */
const DIARY_DOC_FALLBACK = join(DATA_DIR, DIARY_DOC_FILE)
/** 会话日志根目录：日记的原料就在这儿。 */
const SESSIONS_ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
// 执笔最多等这么久。子代理写完一篇日记通常 20~60 秒；超过两分钟基本就是卡住了，
// 与其让用户盯着「正在写」不如明确报超时。
// 注意这不是"请求超时"：/diary/write 这条路自己**不设短超时**，浏览器半等 180 秒，
// 这条 120 秒是给子代理的预算（写不完就 abort），回给浏览器的仍是结构化结果。
const DIARY_WRITE_TIMEOUT_MS = 120000
/** 今日统计最多让 /diary/today 等这么久；超了先回 scanning，让页面 1.5 秒后再问。 */
const DIARY_SCAN_WAIT_MS = 8000
// 同一时刻只写一篇日记（手动按钮和 21:00 定时器可能同时触发）。
// 必须是模块级：路由处理器建在另一个函数里，看不到 apply() 的局部变量。
let diaryWriting = false
let diaryWritingSince = null
let diaryWritingStartedMs = 0
// 「正在开系统选文件夹框」：也必须是模块级——pick-dir 是长动作（用户可能几十秒才选完），
// 期间 GET /diary 要能把它照出来，否则设置页会以为宿主闲着（t4/F12）。
let diaryPicking = false
// 「今天」统计的新鲜期。契约 60 秒；可由 cordis.patch.yml 的 config.diaryStaleMs 覆盖（t4/F6/F15）。
const DIARY_STALE_DEFAULT_MS = 60000
let diaryFreshMs = DIARY_STALE_DEFAULT_MS
// 最近一次统计失败的原始错误：失败要能说清"为什么没算出来"，不能只回一个空块（t4/F16）。
let diaryScanError = ''

/**
 * 唯一一个可配置项（方案 §c / t4/F15）：`cordis.patch.yml` 里那一行 `config.diaryStaleMs`
 * 覆盖「今日统计」的新鲜期，默认 60 秒（t4/F6：方案里写的是 60s，早先代码写成了 10min）。
 *
 * schemastery 在 DSH 运行时里有，但本项目**不把它写进 dependencies**
 * （check-manifest 的依赖卫生 + 插件不拉依赖的硬线），所以这里动态取：
 * 取不到就把 Config 留空 —— cordis 会原样把 config 对象交回来，apply() 里再做一次兜底校验。
 */
export const Config =
  typeof Schemastery?.object === 'function'
    ? Schemastery.object({
        diaryStaleMs: Schemastery.number()
          .default(DIARY_STALE_DEFAULT_MS)
          .min(1000)
          .description('记录文档里「今日统计」的新鲜期（毫秒）：超过就重新算一次'),
      })
    : undefined
// 提示词里用的名字：她的自称。不进系统提示词，只出现在写日记的这一次请求里。
const PERSONA_DISPLAY_NAME = '深度求索娘'

/**
 * `DBG=1` 时逐步打印人设段落求值轨迹（下文 `persona.text()` 里那一行）。
 *
 * 必须**显式声明**：这里原本直接写 `if (DEBUG)`，而 `DEBUG` 在任何地方都没有定义。
 * ESM 是严格模式，读取未声明标识符会抛 `ReferenceError`；偏偏这段代码在
 * `text()` 闭包里，而宿主每个 model step 组装提示词都会调用它一次——
 * 于是错误不是启动时报一次，而是**每一步都报**，提示词组装直接失败。
 * 在模块加载期读一次环境变量，语义与注释里写的 `DBG=1` 一致，且每次调用零成本。
 */
const DEBUG_PERSONA_TEXT = process.env.DBG === '1'

/**
 * 开关的内存镜像 + 磁盘读写。
 *
 * 每条规则都对应一个真会发生的失败：
 *   - **读盘失败不抛**：插件激活时抛错 → 整行挂不上 → 用户以为装坏了。
 *   - **写盘失败不抛**：磁盘满/权限不足不该让挂件消失，内存里的值继续生效。
 *   - **每次整份落盘**：开关是低频操作（人点一下），不值得为性能引入增量写。
 */
function createToggleStore(logger) {
  let state
  /** 磁盘原文：只用来判断这次启动需不需要把迁移结果落盘。 */
  let rawDocument
  try {
    const text = readFileSync(TOGGLE_FILE, 'utf8')
    state = normalizeStore(parseStore(text) ?? emptyStore())
    try {
      rawDocument = JSON.parse(text)
    } catch {
      // 坏 JSON：parseStore 已回落到空存储；这里**不覆盖**用户的破文件
      // （可能是手工编辑到一半，覆盖等于把能救的数据抹掉）。
      rawDocument = undefined
    }
  } catch {
    // 文件不存在（首次安装）或读不了：用空存储。这是正常路径，不是错误。
    state = emptyStore()
  }

  function persist() {
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      writeFileSync(TOGGLE_FILE, serializeStore(state), 'utf8')
    } catch (error) {
      logger?.warn?.('[dsh-pet-cuteness-plugin] 开关状态写盘失败（内存里仍然生效）：', error)
    }
  }

  // 迁移必须在**启动时**落一次盘：否则磁盘上永远躺着旧形状，
  // 每次启动重新迁移，外部工具（包括用户自己）看到的都是旧结构。
  // 幂等：迁移后的文件 needsRewrite 为 false，不会再写第二次。
  if (rawDocument !== undefined && needsRewrite(rawDocument)) {
    persist()
    logger?.info?.('[dsh-pet-cuteness-plugin] 开关状态已迁移到 v3（widget 已删除，只剩 persona/thinking）')
  }

  return {
    /** 读快照（给提示词求值用，必须纯同步）。 */
    snapshot() {
      return state
    },
    /** 新会话的默认值。 */
    defaults() {
      return state.defaults
    },
    /** 改新会话默认值（刻意不回溯已有会话：用户正在工作，不能被掀翻）。 */
    setDefaults(next) {
      state = withDefaults(state, next)
      persist()
      return state.defaults
    },
    /** 改某个会话的状态。 */
    setSessionFlags(sessionId, flags) {
      state = withSessionFlags(state, sessionId, flags)
      persist()
      return state.sessions[sessionId]
    },
    /** 某个会话是否允许某一项能力；读不到就按默认值走。 */
    isEnabled(sessionId, key) {
      if (!FLAG_KEYS.includes(key)) return false
      const table = state.sessions && typeof state.sessions === 'object' ? state.sessions : {}
      const entry = sessionId ? table[sessionId] : undefined
      return normalizeFlags(entry, state.defaults)[key] === true
    },
  }
}

/**
 * 读人格卡。**整个读取过程包在 try/catch 里**，失败返回空表——
 * 绝不因为素材文件坏了就让整个插件崩掉（设计方案 v3 §9.1 第 1 条）。
 *
 * 注意：这是「激活路径」的一次性读取，不是「渲染路径」的重复解析。
 * 浏览器半必须拿到已经解析好的数据。
 *
 * @param {any} logger
 * @returns {{ byId: Record<string, any>, list: any[] }}
 */
function loadPersonas(logger) {
  try {
    const require = createRequire(import.meta.url)
    const doc = require(PERSONA_FILE)
    const list = Array.isArray(doc?.personas) ? doc.personas : []
    /** @type {Record<string, any>} */
    const byId = {}
    for (const card of list) {
      if (card && typeof card.id === 'string') byId[card.id] = card
    }
    return { byId, list }
  } catch (error) {
    logger?.warn?.('[dsh-pet-cuteness-plugin] 人格卡读取失败，回落 generic：', error)
    return { byId: {}, list: [] }
  }
}

/**
 * 决定人格卡 id。两条路，卡自带的 `match` 优先：
 *   1. 卡片数据里的 `match`（设定作者写的，加模型只改数据不改代码）
 *   2. `src/model-identity.mjs` 的硬编码正则表（兜底）
 *   3. 都没有 → generic
 *
 * @param {object} input
 * @param {any[]} input.cards
 * @param {{provider?:string, model?:string}|undefined} input.selection
 * @param {{provider?:string, model?:string}|undefined} input.options
 * @returns {{ personaId: string, provider?: string, model?: string, source: string }}
 */
export function decidePersona({ cards, selection, options }) {
  const base = resolvePersona({ selection, options })
  const fromCards = matchByCardRules(cards, base.provider, base.model)
  if (fromCards) return { ...base, personaId: fromCards, source: `${base.source}+cardRule` }
  return base
}

/**
 * 跨「插件实例」的段落注册表：agentId → dispose()。
 *
 * 为什么不能只靠 `agentCtx.effect`：
 *   人设段注册在 **agent 自己的 ctx** 上，它的生命周期跟着 agent 走，**不跟着插件走**。
 *   插件热重载（disable→enable）只 dispose 插件 ctx 里的东西，agent ctx 上那份段落还在，
 *   而宿主的规则是「同一层重复注册同名段会 throw」——于是重载之后：
 *     ① 新实例再注册同名段 → 抛错 → 被 catch 吞掉（看起来"什么都没发生"）；
 *     ② 真正生效的是**上一个插件实例**注册的旧段落，新代码永远上不去；
 *     ③ attached 恒为 0，/debug 还看不出来为什么。
 *   2026-10-22 实测就撞上了这个：重载后 attached 0 个，而提示词里人设照样有（旧段在跑）。
 *
 * 解法：把 disposer 挂在 `globalThis` 上（同一个 realm 里跨模块实例共享），
 * 重载时先 dispose 旧的、再注册新的。宁可多一次「销毁+重建」的抖动，
 * 也不能出现"代码改了、跑的还是上一版"。
 */
const SECTION_REGISTRY =
  globalThis.__dshAiWaifuSections instanceof Map
    ? globalThis.__dshAiWaifuSections
    : new Map()

/**
 * 台词的两个「补充水源」。
 *
 * 只靠推理流摘句有个硬伤：跑工具、跑命令的那几十秒里完全没有 reasoning-delta，
 * 气泡就一条都不冒——用户原话是「总是很空」。所以再挂两个水源：
 *   1. 工具期：一看到 tool-call 就用角色卡自己的台词补一句（零成本）；
 *   2. 空闲期：浏览器来要台词、队列空着而且确实断流了，再补一句。
 *
 * sessionCards 在 attachPersona 里填（只对主会话），sessionLineState 记轮转位置
 * 和上次补句时间——按会话分桶，别让两个对话抢同一句。
 */
const sessionCards = new Map()
const sessionLineState = new Map()

/**
 * 台词队列和统计都在 apply() 里建，路由和补句函数在模块级：
 * 用一个显式的 ref 把它们接起来，比把整个路由搬进闭包里清楚。
 */
let lineFeedRef = null
let lineStatsRef = null
let togglesRef = null

/** 工具期补句的最小间隔：比用户眨一次眼长一点，免得刷屏。 */
const CARD_TOOL_MIN_MS = 2200
/** 空闲补句：浏览器等到这个时长还一条没捞着，才用角色卡垫一句。 */
const CARD_IDLE_MIN_MS = 4500
/**
 * 卡片垫句必须落在**真空窗**里：距上一句台词（不管来源）至少这么久。
 * 2026-10-24 实测：工具调用极密时，光靠"距上次补句 2.2 秒"根本不够——
 * 工具帧比推理帧密得多，卡片句于是把整条队列占满，`/debug` 上变成 card 121 : pushed 21。
 */
const CARD_QUIET_MS = 4000
/**
 * 整场对话里卡片句累计不得超过思考摘句数（1:1 硬顶）。
 * 台词库是"垫话"，不是主力：比例一旦被工具密度拖过去，用户听到的就是念稿子。
 */
const CARD_RATIO_MAX = 1

/**
 * 卡片垫句被闸门挡下来的记账。挡下来必须有痕迹——
 * 否则"卡片为什么变少了"和"卡片根本没被调用"在 `/debug` 上长得一模一样。
 * @param {object} state 会话级台词状态
 * @param {string} reason pending（队列没播完）/ quiet（不是空窗）/ ratio（比例顶到上限）
 * @returns {0}
 */
function cardCapped(state, reason) {
  state.cardCapped += 1
  state.cappedReason = reason
  if (lineStatsRef) lineStatsRef.cardCapped += 1
  return 0
}

/**
 * 用角色卡自己的台词往队列里补一句。
 *
 * 为什么按桶取而不是随机抽一条：不同场景该说不同的话——跑工具时说「我去翻一下」，
 * 断流空闲时说「嗯……等一下」。桶顺序就是优先级，前一个有词就不再往下找。
 *
 * 三道闸门按顺序判，顺序本身就是设计（2026-10-24 用户报「气泡全是台词库」后加的）：
 *   ① 队列里还有她的思考没播完 → 不许插台词库；
 *   ② 不是真空窗（上一句刚过去）→ 不许插；
 *   ③ 卡片句累计已顶到思考句的比例 → 不许插。
 *
 * @param {string} sessionId
 * @param {readonly string[]} buckets 台词桶优先级
 * @param {number} minGapMs 距上次补句至少隔这么久
 * @returns {number} 真正入队的条数（0 表示这次没补）
 */
function pushCardLine(sessionId, buckets, minGapMs) {
  if (!sessionId) return 0
  if (!lineFeedRef || !togglesRef) return 0
  if (togglesRef.isEnabled(sessionId, 'lines') !== true) return 0
  const card = sessionCards.get(sessionId)
  if (!card) return 0
  const now = Date.now()
  const state = lineStateOf(sessionId)
  const pending = typeof lineFeedRef.pending === 'function' ? lineFeedRef.pending(sessionId) : 0
  if (pending > 0) return cardCapped(state, 'pending')
  const quietMs = Math.max(Number(minGapMs) || 0, CARD_QUIET_MS)
  if (state.lastLineAt > 0 && now - state.lastLineAt < quietMs) return cardCapped(state, 'quiet')
  if (state.cardCount >= state.thinkingCount * CARD_RATIO_MAX) return cardCapped(state, 'ratio')
  const texts = cardLineTexts(card, buckets)
  if (texts.length === 0) return 0
  const text = rotateLine(texts, state.rot)
  const pushed = lineFeedRef.push(sessionId, text, { limit: 1 }).length
  if (pushed > 0) {
    state.rot += 1
    state.lastCardAt = now
    state.lastLineAt = now
    state.cardCount += pushed
    if (lineStatsRef) lineStatsRef.card += pushed
  }
  return pushed
}

function lineStateOf(sessionId) {
  let state = sessionLineState.get(sessionId)
  if (!state) {
    state = {
      rot: 0,
      lastCardAt: 0,
      lastLineAt: 0,
      /** 已经入队的思考摘句数（卡片比例的分子/分母一侧） */
      thinkingCount: 0,
      /** 已经入队的卡片垫句数 */
      cardCount: 0,
      /** 被闸门挡下来的次数与最近一次原因 */
      cardCapped: 0,
      cappedReason: '',
    }
    sessionLineState.set(sessionId, state)
  }
  return state
}
  globalThis.__dshAiWaifuSections instanceof Map ? globalThis.__dshAiWaifuSections : new Map()
try {
  globalThis.__dshAiWaifuSections = SECTION_REGISTRY
} catch {
  /* 只读 globalThis 的极端环境：退化成不清理旧段，仍比崩掉好 */
}

export function apply(ctx, config = {}) {
  // Cordis Config → 模块级阈值（Config 没解析到也无所谓：默认值就是契约值）
  const staleMs = Number(config?.diaryStaleMs)
  diaryFreshMs = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : DIARY_STALE_DEFAULT_MS

  // 开关状态：先建出来，后面的段落求值都读它。读盘失败不抛，回落出厂值（全关）。
  const toggles = createToggleStore(ctx.logger)
  togglesRef = toggles

  // 已经挂上人设段的 agent：id → 诊断信息。既防重入，也给 /debug 路由用。
  // ⚠️ 必须声明在 registerToggleBridge **之前**：路由是异步挂的，但它闭包引用了
  //    这个 Map；若声明在后面，一旦 apply 中途提前 return，路由被调用时就会撞
  //    TDZ（`Cannot access 'attached' before initialization`）——2026-10-22 实撞。
  const attached = new Map()

  // 台词层：把推理流里"像人话"的短句摘出来排在宿主侧，等浏览器长轮询来拉。
  // 必须先于 registerToggleBridge 建好——桥的 /lines 路由闭包引用它。
  const lineFeed = createLineFeed()
  lineFeedRef = lineFeed

  // 台词层的"接没接上"计数。台词最坑的失败形态是**静默**：开关开着、一条都不出来，
  // 从外面完全分不清是"没收到流"还是"收到了但全被过滤掉"。所以把三类计数摊到 /debug：
  //   frames —— 收到多少个 assistant-stream 帧；reasoning —— 其中多少个是 reasoning-delta；
  //   pushed —— 最终变成台词的句子数；kinds —— 最近几帧的类型（看宿主真实发什么）。
  const lineStats = {
    frames: 0,
    reasoning: 0,
    pushed: 0,
    card: 0,
    kinds: [],
    /** 每一条被拒的候选句按原因计数（见 voice-lines 的 REJECTION_KEYS） */
    rejected: emptyRejections(),
    /** 卡片垫句被闸门挡下来的次数 */
    cardCapped: 0,
  }

  /**
   * `/debug` 的 `lines` 段。
   * `cardRatio` 是本次修复的验收指标：卡片垫句 / 思考摘句，> 1 就说明台词库又当上主力了。
   * @param {number} buffered 还在缓冲里等句子边界的文本条数
   */
  function lineReport(buffered) {
    const ratio = lineStats.pushed > 0 ? lineStats.card / lineStats.pushed : 0
    return {
      ...lineStats,
      buffered,
      cardRatio: Math.round(ratio * 100) / 100,
    }
  }
  lineStatsRef = lineStats

  // apply 走到哪一步了。插件是"挂不上就静默降级"的风格，没有这块就没有现场。
  const diag = { stage: 'init', error: null }

  // 诊断快照占位：桥在 apply 里就挂上，而真正的实现要等宿主服务就绪后才存在。
  // 先给一个"还没起来"的版本，路由任何时刻调用都不会撞 TDZ/undefined。
  let diagnosticsSnapshot = () => ({
    stage: diag.stage,
    stageError: diag.error,
    defaults: toggles.defaults(),
    attached: [],
    live: [],
    lines: lineReport(0),
  })

  // HTTP 桥：浏览器半靠它读写开关（浏览器没有别的通道能改宿主状态）。
  registerToggleBridge(ctx, toggles, () => diagnosticsSnapshot(), () => lineFeed)

  // ── 等宿主服务就绪 ────────────────────────────────────────────────
  //
  // 这里**必须**用 ctx.inject，不能 ctx.get 一次就赌它在。
  // 实测（2026-10-22 App 重启后）：apply 跑的时候 systemPrompt 还没就绪，
  // `ctx.get('systemPrompt', false)` 返回 false，于是整套人设注入被静默跳过——
  // /debug 的 stage 停在 `no-system-prompt`，用户看到的就是「语气开关开了、什么都没变」。
  // 插件加载顺序不受我们控制，唯一稳的做法是订阅服务就绪。
  // ── 日记定时器的挂载 ────────────────────────────────────────────────
  //
  // 2026-10-24 教训：老实现只走 `ctx.inject(['timer'])`。如果这个宿主没有 `timer` 服务
  // （或者它在本插件 apply 之后才就绪），注入回调永远不会跑，于是 21:00 一次都没写、
  // 也没有任何失败记录——用户只能看到「快 22 点了还没写」。
  // 现在只留一条最不容易坏的腿：宿主进程本身就是 Node，直接用全局 setInterval，
  // 生命周期交给 ctx.effect（插件重载/卸载时清掉，不会越堆越多）。
  const bootScheduler = () => {
    try {
      // 启动后先补一次：重启 App 时如果已经过了写作时刻，不必再多等一分钟。
      const kick = setTimeout(() => maybeRunScheduledDiary(ctx), 5000)
      kick?.unref?.()
      ctx.effect(() => () => clearTimeout(kick), 'dsh-pet-cuteness-plugin: diary kickoff')
    } catch {
      /* 起不来也不影响下面按分钟检查 */
    }
  }

  let schedulerVia = 'none'
  // 宿主的 timer 服务一旦挂上，下面的裸 setInterval 就自动停手（标志位由注入回调置位）。
  let timerServiceReady = false
  ctx.effect(() => {
    // 兜底腿：宿主进程就是 Node，直接用全局 setInterval，不依赖任何服务。
    // 2026-10-24「21 点没写」就是只靠 timer 服务、而它没就绪造成的。
    // unref：这个定时器不该把进程（或测试进程）吊着不退出。
    const id = setInterval(() => {
      if (timerServiceReady) return
      maybeRunScheduledDiary(ctx)
    }, 60000)
    id?.unref?.()
    if (schedulerVia === 'none') schedulerVia = 'setInterval'
    return () => clearInterval(id)
  }, 'dsh-pet-cuteness-plugin: diary schedule')

  ctx.inject(['timer'], (timerCtx) => {
    try {
      const timer = timerCtx.get('timer', false)
      if (typeof timer?.interval !== 'function') return
      timerCtx.effect(
        () =>
          timer.interval(() => {
            maybeRunScheduledDiary(ctx)
          }, 60000),
        'dsh-pet-cuteness-plugin: diary schedule',
      )
      timerServiceReady = true
      schedulerVia = 'timer-service'
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-pet-cuteness-plugin] 日记定时器没挂上：${error?.message ?? error}`)
    }
  })
  diarySchedulerStats.registeredVia = schedulerVia
  bootScheduler()

  ctx.inject(['systemPrompt', 'sessionProjections'], (scoped) => {
    try {
      bootPromptLayer(scoped, scoped.get('systemPrompt', false), scoped.get('sessionProjections', false))
    } catch (error) {
      diag.stage = 'boot-failed'
      diag.error = String(error)
      ctx.logger?.warn?.('[dsh-pet-cuteness-plugin] 提示词层初始化失败：', error)
    }
  })

  /**
   * 提示词层：中文思考段 + 人设段（含既有 agent 补注册）。
   * @param {any} ctx 已经拿到 systemPrompt / sessionProjections 的作用域 ctx
   * @param {any} systemPrompt
   * @param {any} projections
   */
  function bootPromptLayer(ctx, systemPrompt, projections) {
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    diag.stage = 'no-system-prompt'
    ctx.logger?.warn?.('[dsh-pet-cuteness-plugin] systemPrompt 服务不可用，跳过人设注入')
    return
  }
  diag.stage = 'system-prompt-ok'

  // ── 中文思考条款：**全局注册**，不走 agent.ctx ──────────────────────
  //
  // 为什么单独拆出来（工程评审 D12）：
  //   人设段落注册在 agent.ctx 上，并且用 origin 判据跳过子代理。
  //   如果把「用中文思考」也塞进那段人设里，结果就是
  //   **主会话中文思考、所有子代理英文思考** —— 而子代理正是产出
  //   代码评审和调研结论的那批。等于把我们想修的问题换了个镜像继续存在。
  //
  //   反过来说，中文思考条款没有"人格污染"的风险：它只约束推理语言，
  //   不改变角色。所以它可以在全局 ctx 注册，对所有 agent（含子代理）生效。
  //
  // 顺序：与人设段落同一段位（persona 前缀之后），但用独立名字，互不覆盖。
  //
  // ⚠️ 开关怎么生效：`text` 传**函数**而不是字符串。宿主每次组装提示词都会重新调用它
  //    （实测 `assemble()` 里 `typeof section.text === 'function' ? section.text(context)`），
  //    所以用户点一下开关，下一个 step 立刻生效，不需要重新注册段落、也不用重启。
  const thinkingOrder = resolvePersonaOrder((n) => systemPrompt.getSectionOrder(n))
  if (thinkingOrder !== null) {
    ctx.effect(
      () =>
        systemPrompt.section({
          name: 'ai-waifu:thinking-language',
          order: thinkingOrder,
          // 全局这份是**兜底**：没有会话身份的调用方（以及子代理）按"默认值"走。
          // 主会话会用同名段遮蔽它，从而实现"每个会话各自开关"。
          text: () => (toggles.defaults().thinking === true ? THINKING_LANGUAGE_SECTION : ''),
          interpolate: false,
        }),
      'dsh-pet-cuteness-plugin: thinking language section',
    )
  } else {
    ctx.logger?.warn?.('[dsh-pet-cuteness-plugin] 读不到段落锚点，跳过中文思考条款')
  }
  diag.stage = 'thinking-registered'

  diag.stage = 'personas-loading'
  const personas = loadPersonas(ctx.logger)
  diag.stage = 'personas-loaded'

  /**
   * 推理流断句缓冲：sessionId → 还没说完的半句。
   *
   * 为什么要缓冲：`agent/assistant-stream` 给的是**增量** delta（一次几个字），
   * 直接拿单个 delta 去摘句，摘出来的全是碎片。所以先把增量拼回去，
   * 只在"遇到句号/感叹号/换行"时把前面完整的那截送去摘句，尾巴留着等下一口。
   */
  const reasoningBuffers = new Map()

  /** 最后一个句子边界的下标（边界字符之后的位置）。找不到返回 0。 */
  function lastSentenceBoundary(text) {
    let cut = 0
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]
      if (ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '…' || ch === '!' || ch === '?' || ch === ';' || ch === '\n') {
        cut = i + 1
      }
    }
    return cut
  }

  /**
   * 处理一条 assistant-stream 帧。只做一件事：把 reasoning 里像人话的短句塞进台词队列。
   *
   * 三条纪律（缺一条这个功能就会变成故障源）：
   *   1. 只读不改——绝不动 chunk 本身，也不额外请求模型（零 token 成本）；
   *   2. 任何异常都必须吞掉：台词是装饰，不能因为它让用户的一轮对话失败；
   *   3. 开关关了就不干活（连缓冲都不攒）。
   */
  function tapReasoning(sessionId, payload) {
    if (!sessionId) return
    const frame = payload?.frame
    if (!frame || typeof frame !== 'object') return
    // 统计放在开关判断之前：否则"开关关着"和"开着但一条流都没来"在 /debug 上长得一样。
    lineStats.frames += 1
    const kind =
      frame.type === 'chunk' ? 'chunk:' + String(frame.chunk?.type ?? '?') : String(frame.type)
    if (lineStats.kinds[lineStats.kinds.length - 1] !== kind) {
      lineStats.kinds.push(kind)
      if (lineStats.kinds.length > 8) lineStats.kinds.shift()
    }
    if (toggles.isEnabled(sessionId, 'lines') !== true) return

    if (frame.type === 'end') {
      const rest = reasoningBuffers.get(sessionId)
      reasoningBuffers.delete(sessionId)
      if (rest) {
        const pushed = lineFeed.push(sessionId, rest, { limit: 1, stats: lineStats }).length
        if (pushed > 0) lineStateOf(sessionId).thinkingCount += pushed
        lineStats.pushed += pushed
        if (pushed > 0) lineStateOf(sessionId).lastLineAt = Date.now()
      }
      return
    }
    if (frame.type !== 'chunk') return

    const chunk = frame.chunk
    if (!chunk) return

    // 工具期：模型在跑工具/命令的那几十秒没有推理增量，纯靠摘句就会一直空着。
    // 这里用角色卡自己的台词垫一句（不花钱、不额外请求模型）。
    const chunkType = String(chunk.type ?? '')
    if (chunkType === 'tool-call-delta' || chunkType === 'tool-call') {
      pushCardLine(sessionId, ['working', 'thinking'], CARD_TOOL_MIN_MS)
      return
    }
    if (chunk.type !== 'reasoning-delta') return
    lineStats.reasoning += 1
    const text = typeof chunk.text === 'string' ? chunk.text : ''
    if (!text) return

    const merged = (reasoningBuffers.get(sessionId) ?? '') + text
    const cut = lastSentenceBoundary(merged)
    if (cut <= 0) {
      // 还没说完：只保留尾部一小截，避免长推理把内存撑大
      reasoningBuffers.set(sessionId, merged.slice(-600))
      return
    }
    const complete = merged.slice(0, cut)
    reasoningBuffers.set(sessionId, merged.slice(cut).slice(-600))
    const pushedLines = lineFeed.push(sessionId, complete, { limit: LINE_LIMITS.perStep, stats: lineStats }).length
    if (pushedLines > 0) lineStateOf(sessionId).thinkingCount += pushedLines
    lineStats.pushed += pushedLines
    if (pushedLines > 0) lineStateOf(sessionId).lastLineAt = Date.now()
  }

  /**
   * 给一个 agent 订阅推理流。
   *
   * 为什么挂在 agent.ctx 上（和段落一样）：流事件是 agent 作用域的；挂全局会收到
   * 所有会话（含子代理）的推理，那等于让子代理也来抢麦。挂在 agent.ctx 上还有个
   * 好处——agent 销毁时监听器跟着走，不用我们手工回收。
   *
   * @returns {(() => void) | null} 取消订阅函数（热重载时先拆旧的，免得同一句话入队两次）
   */
  function subscribeReasoning(agentCtx, sessionId) {
    if (!agentCtx || typeof agentCtx.on !== 'function') return null
    try {
      const off = agentCtx.on('agent/assistant-stream', (payload) => {
        try {
          tapReasoning(sessionId, payload)
        } catch {
          /* 台词挂了也不能影响对话 */
        }
      })
      return typeof off === 'function' ? off : null
    } catch (error) {
      ctx.logger?.warn?.('[dsh-pet-cuteness-plugin] 台词流订阅失败：', error)
      return null
    }
  }

  /**
   * 给一个 agent 挂上「人设语气」段（以及会话级「中文思考」遮蔽段）。
   *
   * 为什么抽成函数：它现在有**两个**调用方 —— `agent/created` 事件（新建/恢复会话时）
   * 和 apply 末尾的补注册（插件热重载时已经在跑的会话）。两处必须走同一套逻辑，
   * 否则迟早长歪。
   *
   * @param {any} agent
   */
  function attachPersona(agent) {
    try {
      if (!agent) return
      const agentId = typeof agent.id === 'string' ? agent.id : ''
      if (agentId && attached.has(agentId)) return
      if (!isMainAgent(agent)) return

      const agentCtx = agent.ctx
      if (!agentCtx || typeof agentCtx.effect !== 'function') return
      const prompt = agentCtx.get('systemPrompt', false)
      if (!prompt || typeof prompt.section !== 'function') return

      // 顺序读不到就不注册：宁可没有娘，也不能静默压到工作指令后面去。
      const order = resolvePersonaOrder((n) => prompt.getSectionOrder(n))
      if (order === null) {
        ctx.logger?.warn?.(
          '[dsh-pet-cuteness-plugin] 读不到 DEPLOYMENT_PERSONA_PREFIX 的顺序，本次跳过人设注入（不猜数字）',
        )
        return
      }

      // 模型身份：投影优先，agent.options 只作退路（后者是创建时的默认值，会过期）。
      const snapshot =
        projections && typeof projections.snapshot === 'function' && agent.session
          ? projections.snapshot(agent.session, ['modelSelection'])
          : undefined
      const { personaId, provider, model, source } = decidePersona({
        cards: personas.list,
        selection: readSelection(snapshot),
        options: agent.options,
      })

      const card = personas.byId[personaId] ?? personas.byId.generic
      const quirk = pickQuirk(card?.quirks)
      // 中文思考条款已由全局段/会话段提供，这里显式关掉，避免同一段文本进两次。
      const sectionText = buildStableSection({
        personaText: cardToPersonaText(card),
        quirk: quirk ? quirk.content : '',
        thinkingLanguage: false,
      })

      // 先把上一个插件实例留下的同名段拆掉（见 SECTION_REGISTRY 的注释）。
      // 不拆就会撞「同层同名段重复注册」，新代码永远盖不上去。
      if (agentId) {
        const stale = SECTION_REGISTRY.get(agentId)
        if (typeof stale === 'function') {
          try {
            stale()
          } catch {
            /* 旧 agent ctx 可能已经销毁，拆不掉就算了 */
          }
          SECTION_REGISTRY.delete(agentId)
        }
      }

      // 会话身份：开关按会话分桶，要拿到 id。拿不到就按默认值走（保守）。
      const sessionId = readSessionId(agent)

      // agentCtx 上注册随 agent 生命周期回收；这里再包一层 effect 让热重载也干净。
      //
      // 人设段同样用函数：关掉「人设语气」之后下一个 step 立刻恢复标准助手腔，
      // 不需要重开会话——用户点开关时想要的是"马上不说话了"，不是"下个会话才生效"。
      //
      // 证据链（2026-10-21 实测，DSH 0.2.1-rc.2 打包产物）：
      //   `@deepseek-ai/dsh-system-prompt/lib/index.js:356` 的 `assemble()` 每次
      //   组装提示词都对每个段落执行 `typeof section.text === "function" ? section.text(context) : section.text`
      //   （同一文件 :388），宿主每个 model step 重新 assemble 一次，所以这里的闭包
      //   每步都会被调用——这就是"会话内打开下一句就生效"的依据，不需要重建 agent。
      //   DBG=1 时打一行日志，可以亲眼看到同一条 session 每步都进来一次。
      const disposePersona = agentCtx.effect(
        () =>
          prompt.section({
            name: 'ai-waifu:persona',
            order,
            text: () => {
              const enabled = toggles.isEnabled(sessionId, 'persona')
              // 诊断日志：**单独 try/catch**。text() 一旦抛错，宿主整段提示词组装就失败，
              // 而"打日志失败"绝不该有这种杀伤力。返回值路径保持纯净，不受影响。
              if (DEBUG_PERSONA_TEXT) {
                try {
                  ctx.logger?.info?.(
                    `[dsh-pet-cuteness-plugin] persona.text() session=${sessionId ?? '?'} enabled=${enabled} bytes=${enabled ? sectionText.length : 0}`,
                  )
                } catch {
                  /* 诊断日志失败不影响人设注入 */
                }
              }
              return enabled ? sectionText : ''
            },
            // 段落里没有 {{变量}} 的意图，关掉插值，避免路径里的花括号被当变量。
            interpolate: false,
          }),
        'dsh-pet-cuteness-plugin: persona section',
      )

      // 会话级「中文思考」：用**同名段**遮蔽上面那份全局兜底段。
      // （不遮蔽的话，输入框旁那个开关写的是会话级 flag，而全局段只读 defaults，
      //   于是"点了没反应"——这正是用户抱怨的那一类问题。）
      let disposeThinking = null
      if (thinkingOrder !== null) {
        disposeThinking = agentCtx.effect(
          () =>
            prompt.section({
              name: 'ai-waifu:thinking-language',
              order: thinkingOrder,
              text: () => (toggles.isEnabled(sessionId, 'thinking') === true ? THINKING_LANGUAGE_SECTION : ''),
              interpolate: false,
            }),
          'dsh-pet-cuteness-plugin: session thinking language section',
        )
      }

      // 台词补句要用角色卡自己的台词（工具期/断流期），按会话存一份。
      if (sessionId) sessionCards.set(sessionId, card)

      // 台词层：订阅这条会话的推理流。
      // 和段落一样，热重载时旧监听器仍在（agent.ctx 不随插件销毁），
      // 所以也要先拆旧的——否则同一句推理会入队两次、台词重复冒出来。
      const stopStream = subscribeReasoning(agentCtx, sessionId)

      // 记下这一代注册的 disposer：下一个插件实例（或本实例再挂一次）先拆再建。
      if (agentId) {
        SECTION_REGISTRY.set(agentId, () => {
          if (typeof stopStream === 'function') {
            try {
              stopStream()
            } catch {
              /* agent 已销毁 */
            }
          }
          if (sessionId) sessionCards.delete(sessionId)
          try {
            disposePersona()
          } catch {
            /* agent 已销毁 */
          }
          if (typeof disposeThinking === 'function') {
            try {
              disposeThinking()
            } catch {
              /* agent 已销毁 */
            }
          }
        })
      }

      attached.set(agentId || String(sessionId ?? ''), {
        sessionId,
        personaId,
        order,
        source,
        provider,
        model,
      })

      ctx.logger?.info?.(
        `[dsh-pet-cuteness-plugin] persona=${personaId} ← ${source}(${provider ?? '?'}/${model ?? '?'}) order=${order} session=${sessionId ?? '?'}`,
      )
    } catch (error) {
      // `agent/created` 是 serial 事件：监听器同步抛错会否决 agent 创建并回滚。
      // 宁可没有人设，也不能让用户开不了会话。
      ctx.logger?.warn?.('[dsh-pet-cuteness-plugin] persona 段落注册失败：', error)
    }
  }

  // per-agent 行为必须注册在 agent 自己的 ctx 上：全局 ctx 注册的段落对所有
  // agent 生效，那就等于给子代理也灌了人设。
  ctx.on('agent/created', ({ agent }) => attachPersona(agent))

  // ── 补注册：把**已经在跑**的会话也接上 ────────────────────────────────
  //
  // 为什么必须有这一段（2026-10-22 定位到的真凶）：
  //   `agent/created` 只在会话**刚创建/刚恢复**那一刻发一次。而插件热重载
  //   （plugin_manager 关掉再打开）会 dispose 掉旧监听器；App 里先前就打开着的
  //   会话不会再触发 `agent/created`，于是它们**永远**拿不到人设段。
  //   用户看到的「开关打开了也没效果」有一半是这个：不是段落算错，是段落压根没注册。
  //   热重载是开发期常态，所以补注册不是补丁，是必需路径。
  const registry = ctx.get('agents', false)
  let existing = []
  try {
    existing = typeof registry?.list === 'function' ? registry.list() : []
  } catch (error) {
    ctx.logger?.warn?.('[dsh-pet-cuteness-plugin] 读不到既有 agent 列表：', error)
    existing = []
  }
  for (const agent of existing) attachPersona(agent)
  diag.stage = 'ready'
  ctx.logger?.info?.(
    `[dsh-pet-cuteness-plugin] 补注册完成：既有 agent ${existing.length} 个，已挂段 ${attached.size} 个`,
  )

  /**
   * 诊断快照（只读，给 /api/dsh-pet-cuteness-plugin/debug 用；旧前缀 /api/dsh-ai-waifu/debug 是兼容别名）。
   * 排查「开了没效果」时先看这里：段落到底注册上了没有、text() 会返回什么。
   */
  diagnosticsSnapshot = function diagnosticsSnapshot() {
    const live = (() => {
      try {
        return typeof registry?.list === 'function' ? registry.list() : []
      } catch {
        return []
      }
    })()
    return {
      stage: diag.stage,
      stageError: diag.error,
      defaults: toggles.defaults(),
      // 台词层到底接没接上：帧数/推理增量数/入队句数/最近几帧类型。
      // 没有这块，"台词不冒"只能靠猜（是没收到流？还是全被过滤了？）。
      lines: lineReport(reasoningBuffers.size),
      // 日记定时器的体检数据：跳了几次、上次判断该写哪天、上次为什么没写。
      // 没有这块，「21 点没写」只能靠猜（是没挂上定时器？还是到点了但被台账挡住？）。
      scheduler: { ...diarySchedulerStats, writing: diaryWriting },
      attached: [...attached.entries()].map(([id, info]) => ({
        id,
        ...info,
        personaEnabled: toggles.isEnabled(info.sessionId, 'persona'),
        thinkingEnabled: toggles.isEnabled(info.sessionId, 'thinking'),
        linesEnabled: toggles.isEnabled(info.sessionId, 'lines'),
      })),
      live: live.map((agent) => {
        const sessionId = readSessionId(agent)
        let main = null
        try {
          main = isMainAgent(agent)
        } catch {
          main = null
        }
        let orders = null
        try {
          const prompt = agent.ctx?.get?.('systemPrompt', false)
          orders = prompt
            ? {
                anchor: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
                persona: prompt.getSectionOrder('ai-waifu:persona'),
                thinking: prompt.getSectionOrder('ai-waifu:thinking-language'),
              }
            : null
        } catch {
          orders = null
        }
        // 把 isMainAgent 的三个判据原样摊出来：前阵子出现过"用户的主对话被判成子会话，
        // 语气/台词全都没挂上"，只看 main:false 根本猜不出是哪个字段命中的。
        let headerFacts = null
        try {
          const header = agent?.session?.header
          if (header) {
            headerFacts = {
              origin: header.origin ?? null,
              delegationDepth: header.delegationDepth ?? null,
              hasParentSession: header.parentSession !== undefined,
              isSeeded: header.isSeeded ?? null,
            }
          }
        } catch {
          headerFacts = null
        }
        return {
          id: agent.id,
          sessionId,
          main,
          attached: attached.has(String(agent.id ?? '')),
          personaEnabled: toggles.isEnabled(sessionId, 'persona'),
          thinkingEnabled: toggles.isEnabled(sessionId, 'thinking'),
          header: headerFacts,
          orders,
        }
      }),
    }
  }
  }
}

/**
 * 读会话 id。多写两条退路，换一个宿主版本不至于整段失效。
 * @param {any} agent
 * @returns {string|undefined}
 */
function readSessionId(agent) {
  try {
    const direct = agent?.session?.id ?? agent?.id
    if (typeof direct === 'string' && direct) return direct
  } catch {
    /* 读不到就按默认值走 */
  }
  return undefined
}

/** 桥的路由前缀。浏览器半与宿主半共用这一份，避免两边各写一个字符串。 */
export const BRIDGE_PREFIX = '/api/dsh-pet-cuteness-plugin'

/**
 * 旧前缀，**只作为兼容别名保留**。
 *
 * 2026-10-24 改名（dsh-ai-waifu → dsh-pet-cuteness-plugin）：用户浏览器里可能还缓存着
 * 旧 client bundle，它请求的还是旧前缀。删掉别名 = 那些页面点开关全部 404/401，
 * 而用户只会看到「点了没反应」。所以同一批 handler 挂在两个前缀上，等旧页面自然过期。
 */
export const BRIDGE_PREFIX_LEGACY = '/api/dsh-ai-waifu'

/**
 * 中间那一代前缀，**也只作为兼容别名保留**。
 *
 * 2026-10-24 晚第二次改名（`dsh-pet-cuteness` → `dsh-pet-cuteness-plugin`，用户要求名字里必须留着
 * 「plugin」）：改了包名就要改前缀，但已经打开的页面还在打上一代前缀。少挂一个别名，
 * 用户看到的就是「设置页一直转圈 / 点了没反应」。
 */
export const BRIDGE_PREFIX_M1 = '/api/dsh-pet-cuteness'

/** 所有要挂的前缀：新的在前，旧别名在后（按这个顺序注册，路由表更好读）。 */
export const BRIDGE_PREFIXES = [BRIDGE_PREFIX, BRIDGE_PREFIX_M1, BRIDGE_PREFIX_LEGACY]

/** 请求体上限：开关就是几个布尔值，1KB 绰绰有余；给大了等于开了个写盘口子。 */
const MAX_BODY_BYTES = 1024

/** 目录校验：必须存在且是目录。用来挡住"路径打错一个字母"。 */
function isDirectoryPath(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/* ═════════════════ 记录文档：日记的唯一状态源（docs/重做方案.md §a） ═════════════════ */

/**
 * 运行期计数（只给测试和诊断看）。
 *
 * 为什么要有：验收要求「GET /diary 不再扫会话日志，并且只读一次记录文档」。
 * 这种"没做某件事"的性质，光看返回体证明不了，得能数出来：
 *   docReads / docWrites  记录文档读了几次、真写了几次（跳过相等内容不算写）
 *   todayScans            今日统计真算了几次（GET /diary 之后必须是 0）
 *   dirScans              目录扫了几次（只在认回时，不递归）
 */
export const diaryRuntime = { docReads: 0, docWrites: 0, todayScans: 0, dirScans: 0, recovered: 0 }

/** 测试用：每个用例之间把计数清零。 */
export function resetDiaryRuntime() {
  for (const key of Object.keys(diaryRuntime)) diaryRuntime[key] = 0
}

/** 读记录文档并计数（**唯一**的计数读入口：一条 GET 里只该出现一次）。 */
function readDocCounted(docPath) {
  return readDiaryDocFile(docPath, {
    read: (path) => {
      const text = readFileSync(path, 'utf8')
      diaryRuntime.docReads += 1
      return text
    },
  })
}

/** 写记录文档并计数；内容没变时 store 会跳过，这里也不记一次写。 */
function writeDocCounted(docPath, text) {
  const result = writeTextAtomic(docPath, text)
  if (result.ok && result.skipped !== true) diaryRuntime.docWrites += 1
  return result
}

/** 目录状态 → 一句人话（设置页 S1 的文案就在这儿定，浏览器半只负责显示）。 */
function dirMessageOf(state, dir) {
  if (state === 'ok') return ''
  if (state === 'none') return '还没选日记本文件夹'
  if (state === 'missing') return `这个文件夹找不到了：${dir}`
  if (state === 'not-dir') return `这不是文件夹：${dir}`
  if (state === 'unwritable') return `这个文件夹不能写（没有权限）：${dir}`
  return `这个文件夹进不去（没有权限）：${dir}`
}

/** 「三、最近的日记」里的 file 是绝对路径：认回之后必须整体换成新前缀，否则点开会指向旧路径。 */
function rebaseRecentRows(rows, to) {
  const list = Array.isArray(rows) ? rows : []
  return list.map((row) => {
    const label = String(row?.label ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) return row
    return { ...row, file: join(to, `${label}.md`) }
  })
}

/** 当前目录里身份标记的状态：present / absent / unwritable（方案 §a.9.4 的 dirMarker）。 */
function markerStateOf(dir) {
  try {
    if (readDiaryMarker(dir)) return 'present'
  } catch {
    /* 落到下面按"没有"处理 */
  }
  try {
    accessSync(dir, fsConstants.W_OK)
  } catch {
    return 'unwritable'
  }
  return 'absent'
}

/** 文档路径反推日记本目录：文档丢了的时候，至少还能从它被放在哪里猜出本子在哪儿。 */
function dirGuessOf(docPath) {
  try {
    const dir = dirname(docPath)
    if (!dir || dir === '.' || dir === DATA_DIR) return ''
    return dir
  } catch {
    return ''
  }
}

/**
 * 记录文档自己也会跟着文件夹一起被改名。文档不在了的时候，先在**原父目录**里找一份
 * 「自己写着自己是这本」的文档把它认回来——不能直接重建，重建会把只存在文档里的
 * 「十分钟内手动指定」「不自动认回」全丢掉，那正好是防止认错本子的两道闸门。
 *
 * 只扫一层、只在文档缺失时调用，扫到第一个匹配就返回。
 */
function findRelocatedDoc({ fromDir, parent } = {}) {
  const want = String(fromDir ?? '').replace(/\/+$/, '')
  if (!want) return null
  let listing = null
  try {
    listing = listMarkerDirs(parent)
  } catch {
    return null
  }
  for (const dir of listing?.dirs ?? []) {
    const candidate = docPathFor(dir)
    let read = null
    try {
      read = readDiaryDocFile(candidate)
    } catch {
      continue
    }
    if (!read?.exists || String(read.text).trim() === '') continue
    let parsed = null
    try {
      parsed = parseDiaryDoc(read.text)
    } catch {
      continue
    }
    const claims = String(parsed?.config?.dir ?? '').replace(/\/+$/, '')
    if (claims && claims === want) return { docPath: candidate, dir }
  }
  return null
}

/** 记录文档的元信息（设置页要显示"多大、什么时候更新的"）。 */
function docMetaOf(loaded) {
  let size = Buffer.byteLength(loaded.docText ?? '', 'utf8')
  let mtime = ''
  try {
    const info = statSync(loaded.docPath)
    size = info.size
    mtime = info.mtime.toISOString()
  } catch {
    /* 读不到 stat 就用文本长度兜底，不影响页面 */
  }
  return {
    path: loaded.docPath,
    exists: loaded.docExists === true,
    size,
    mtime,
    // 读文档本身出错（权限、EISDIR…）也要让页面看得见：空文档和有错是两件事（t4/F5）
    error: String(loaded.docError ?? ''),
    schema: DIARY_DOC_SCHEMA,
    warnings: loaded.warnings ?? [],
    tampered: loaded.doc?.tampered === true,
    sections: Array.isArray(loaded.doc?.sections) ? loaded.doc.sections : [],
    recovered: loaded.doc?.config?.recovered ?? null,
  }
}

/** 人类可读的 'YYYY-MM-DD HH:MM:SS' → 浏览器 formatStamp 认的 'YYYY-MM-DDTHH:MM'。 */
function isoStamp(stamp) {
  const text = String(stamp ?? '').trim()
  if (!text) return ''
  return text.replace(' ', 'T').slice(0, 16)
}

/** 那个时间戳到现在多久了（毫秒）。看不懂就当无限久——宁可提示"可能过期"。 */
function stampAgeMs(stamp) {
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
  if (Number.isNaN(at)) return Infinity
  return Date.now() - at
}

/** `deepseek/deepseek-chat` → {key, provider, model}。浏览器半只认这三种字段。 */
function splitDiaristKey(key) {
  const raw = String(key ?? '')
  const slash = raw.indexOf('/')
  if (slash <= 0) return { key: raw, provider: '', model: raw }
  return { key: raw, provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
}

/** 今天写过没有：先看「二、今天」的写实，再退回「三、最近的日记」里有没有今天这一行。 */
function writtenTodayOf(doc, label) {
  // 文档里说"今天写过"：还要盘上真有这一天的那份文件才算。
  // 为什么：用户可能手删了当天的日记，而「今天已经写过」是防覆盖的唯一闸门——
  // 只看文档会让 21:00 那次静默跳过，一天就这么没了（Q3）。
  const dir = typeof doc?.config?.dir === 'string' ? doc.config.dir : ''
  const onDisk = (() => {
    if (!dir) return false
    try {
      return existsSync(diaryPath(dir, label))
    } catch {
      return false
    }
  })()
  if (doc?.today && doc.today.label === label) {
    return doc.today.written === true && onDisk
  }
  const inRecent = (Array.isArray(doc?.recent) ? doc.recent : []).some((row) => row && row.label === label)
  return inRecent && onDisk
}

/**
 * 「五、待办理」不只是写给人看的：换本子那一笔如果崩在半路，下次读状态时在这里收尾（Q2）。
 *
 * 三种可能：指针已改（收尾清 pending）／新文档已写但指针没改（补指针）／新文档都没写成（清 pending）。
 */
function settlePendingMove({ docPath, docText, doc }) {
  const pending = doc?.pending
  if (!pending || pending.kind !== 'move' || !pending.dir) return null
  const target = String(pending.dir)
  if (existsSync(target)) {
    const pointer = writeDiaryPointer({ file: DIARY_FILE, docPath: target })
    if (pointer.ok) {
      let text = ''
      try {
        text = readFileSync(target, 'utf8')
      } catch {
        return null
      }
      const cleared = patchPendingSection(text, null)
      writeDocCounted(target, cleared)
      return { docPath: target, docText: cleared, note: `上次换本子的收尾补上了：${target}` }
    }
  }
  // 新文档没落成、或指针还是写不进去：清掉「待办理」，别让文档永远停在"正在搬"
  try {
    writeDocCounted(docPath, patchPendingSection(docText, null))
    return { docPath, docText: patchPendingSection(docText, null), note: '' }
  } catch {
    return null
  }
}

/**
 * 读一次日记状态：指针 → 记录文档 → 配置，必要时迁移 / 重建 / 认回。
 *
 * **这是 /diary 全部读路径的唯一入口**，全程只碰两个小文件（指针 + 文档），
 * 不列目录、不解压会话日志、不逐个读日记文件——慢的那三件事现在只发生在
 * 用户明确点「刷新统计」「现在就写」的时候。
 *
 * @returns {{config:object, doc:object, docPath:string, docText:string, docExists:boolean,
 *   dirState:string, dirRecovered:object|null, migrated:object|null, warnings:string[], corrupted:boolean}}
 */
function loadDiaryState({ logger = null } = {}) {
  const pointer = readDiaryPointer({ file: DIARY_FILE })
  let docPath = pointer.docPath
  let migrated = null
  let corrupted = pointer.corrupted === true

  if (pointer.legacy) {
    // ① 老格式（dir/enabled/time/diarist/writtenDates 一把抓的那种）：迁一次
    const legacy = normalizeDiaryConfig(pointer.legacy)
    const legacyUsable = legacy.dir && dirStateOf(legacy.dir) === 'ok'
    docPath = docPathFor(legacyUsable ? legacy.dir : '', DIARY_DOC_FALLBACK)
    const result = migrateLegacyDiary({
      legacy: pointer.legacy,
      pointerFile: DIARY_FILE,
      docFile: docPath,
      todayLabel: logicalDayFor(Date.now()),
    })
    if (result.ok) {
      const dates = pointer.legacy?.writtenDates && typeof pointer.legacy.writtenDates === 'object' ? pointer.legacy.writtenDates : {}
      diaryRuntime.docWrites += 1
      migrated = {
        writtenDates: Object.keys(dates).filter((label) => dates[label] === true).length,
        backup: legacyBackupPathFor(DIARY_FILE),
        at: formatStamp(),
      }
      corrupted = false
    } else {
      // 迁不过去也别让用户丢设置：这次先在内存里按老的用，下次再来
      logger?.warn?.(`[dsh-pet-cuteness-plugin] 老日记设置迁移失败：${result.reason ?? ''}`)
      corrupted = true
    }
  } else if (!docPath && !pointer.corrupted) {
    // ② 头一次装：文档先暂住 plugin-data（不往用户桌面乱塞）
    docPath = DIARY_DOC_FALLBACK
  } else if (!docPath) {
    docPath = DIARY_DOC_FALLBACK
  }

  // ③ 文档不在（被删了/被手改空了）：先看 .bak，再按 docPath 反推本子位置重建
  let docRead = readDocCounted(docPath)
  let docExists = docRead.exists && docRead.text.trim() !== ''
  if (!docExists && dirStateOf(dirname(docPath)) === 'missing') {
    // 本子被改名/搬走：文档跟着搬了。把它找回来接着用，别在这儿重建（见 findRelocatedDoc 注释）
    const relocated = findRelocatedDoc({ fromDir: dirname(docPath), parent: dirname(dirname(docPath)) })
    if (relocated) {
      docPath = relocated.docPath
      docRead = readDocCounted(docPath)
      docExists = docRead.exists && docRead.text.trim() !== ''
    }
  }
  let docRebuilt = false
  if (!docExists) {
    docRebuilt = true
    const backupText = readDiaryDocFile(`${docPath}.bak`).text
    const text =
      String(backupText).trim() !== ''
        ? backupText
        : renderDiaryDoc({
            config: { dir: dirGuessOf(docPath), schema: DIARY_DOC_SCHEMA, updatedAt: formatStamp() },
            today: null,
            recent: [],
            failure: null,
            pending: null,
          })
    // 重建时**绝不能**顺手把用户的旧目录建回来：那会把"本子被改名了"变成"找到了一个空目录"，
    // 后面的自动认回就永远不会触发。目录不在就先把文档暂存在 plugin-data。
    const targetDocPath = dirStateOf(dirname(docPath)) === 'ok' ? docPath : DIARY_DOC_FALLBACK
    const boot = writeDocCounted(targetDocPath, text)
    if (!boot.ok) logger?.warn?.(`[dsh-pet-cuteness-plugin] 记录文档建不起来：${boot.reason ?? ''}`)
    docPath = targetDocPath
    docRead = { exists: true, text, error: '' }
    docExists = true
  }
  if (pointer.docPath !== docPath) writeDiaryPointer({ file: DIARY_FILE, docPath })

  // ④ 解析（永不 throw：用户手改坏了也要回一份能用的状态）
  let doc = parseDiaryDoc(docRead.text)
  const warnings = [...(doc.warnings ?? [])]

  // ④b 上次换本子要是没走完，这里把「五、待办理」收掉（Q2：pending 不能只写不读）
  const settled = settlePendingMove({ docPath, docText: docRead.text, doc })
  if (settled) {
    if (settled.note) warnings.push(settled.note)
    docPath = settled.docPath
    docRead = { exists: true, text: settled.docText, error: '' }
    doc = parseDiaryDoc(docRead.text)
  }
  let dirState = dirStateOf(doc.config.dir)
  let dirRecovered = null
  let dirSuggestions = []

  // ⑤ 本子不见了 → 父目录里扫一层找带身份标记的目录（方案 §a.9.2），找到就自动认回
  if (doc.config.dir && dirState === 'missing') {
    const recovery = recoverDiaryDir({
      dir: doc.config.dir,
      recent: doc.recent,
      manualAt: doc.config.dirManualAt,
      rejected: doc.config.dirRejected,
      // 文档是刚重建的：「最近日记」「不自动认回」这些证据都没了，必须再多一条
      // "候选自己的文档写着这个旧路径"才许认回，否则容易认成旁边别人的本子
      requireClaim: docRebuilt,
    })
    diaryRuntime.dirScans += 1
    dirSuggestions = Array.isArray(recovery.suggestions) ? recovery.suggestions : []
    const from = doc.config.dir
    if (recovery.ok && recovery.dir) {
      const to = recovery.dir
      const nextDocPath = docPathFor(to)
      const located = nextDocPath === docPath ? docRead : readDiaryDocFile(nextDocPath)
      const baseText = located.exists && located.text.trim() !== '' ? located.text : docRead.text
      const nextConfig = mergeDocConfig(doc.config, { dir: to }, { recovered: { to, from } })
      // 认回**不许**动这两项：用户十分钟抑制窗、用户说过「不是我那个」的名单
      nextConfig.dirManualAt = doc.config.dirManualAt ?? ''
      nextConfig.dirRejected = Array.isArray(doc.config.dirRejected) ? doc.config.dirRejected : []
      const rows = rebaseRecentRows(doc.recent, to)
      const nextText = patchRecentSection(patchConfigSection(baseText, nextConfig), rows)
      // 写回顺序与 §a.5 同源：先文档、后指针。路径本身是既成事实，这里不搬任何日记文件
      const write = writeDocCounted(nextDocPath, nextText)
      const pointer = write.ok ? writeDiaryPointer({ file: DIARY_FILE, docPath: nextDocPath }) : { ok: false }
      const marker = write.ok ? ensureDiaryMarker({ dir: to }) : { ok: false, written: 'failed' }
      const persisted = write.ok === true && pointer.ok !== false
      if (write.ok) {
        warnings.push(`已自动认回日记本：${to}（原来那个位置改名或搬走了）`)
        docPath = nextDocPath
        docRead = { exists: true, text: nextText, error: '' }
        doc = parseDiaryDoc(nextText)
        dirState = 'ok'
      }
      dirRecovered = { from, to, persisted, at: new Date().toISOString() }
      if (!persisted) {
        // 写不回去也**不回滚 dir**：改名是既成事实，回滚等于把用户又打回「找不到」
        warnings.push(`认回了日记本（${to}），但记录写不回去：${write.reason ?? '未知原因'}`)
        try {
          const failed = patchFailureSection(patchConfigSection(docRead.text, { ...doc.config, dir: to }), {
            at: formatStamp(),
            code: 'recover-failed',
            reason: write.reason ?? '记录写不回去',
            hint: '点「重新读取」再试一次；还不行就重新选一次日记本',
          })
          writeDocCounted(nextDocPath, failed)
        } catch {
          /* 写「四」失败只是少一条线索，本次仍按 to 工作 */
        }
      }
      if (marker.written === 'failed') warnings.push('身份标记没写进去：下次再改名可能认不回来')
    } else if (recovery.reason === 'suppressed') {
      // 用户十分钟内刚手动指定过本子：不认回、连 readdir 都没发（方案 §a.9.3 第 1 条）
    } else if (dirSuggestions.length) {
      warnings.push(`找到疑似日记本：${dirSuggestions[0].dir}（你之前说过「不是我那个」，要用请点「用它」）`)
    } else {
      warnings.push(`日记本文件夹不在了：${from}（旁边一层也没找到带身份标记的日记本）`)
    }
  }
  const dirMarker = doc.config.dir && dirState === 'ok' ? markerStateOf(doc.config.dir) : ''

  return {
    config: { ...doc.config, dirState, dirMessage: dirMessageOf(dirState, doc.config.dir) },
    dirMarker,
    dirSuggestions,
    doc,
    docPath,
    docText: docRead.text,
    docExists,
    docError: (docRead.error ?? '') || '',
    dirState,
    dirRecovered,
    migrated,
    warnings,
    corrupted,
  }
}

/** 记录文档的「二、今天」段：把一次统计写实（不含正文，只有数字）。 */
function todayForDoc(summary, doc) {
  const usage = Array.isArray(summary?.topUsage) ? summary.topUsage : []
  const sessions = Number(summary?.sessions) || 0
  return {
    label: String(summary?.label ?? ''),
    sessions,
    kept: Number(summary?.kept) || 0,
    outputTokens: Number(summary?.totalOutputTokens) || 0,
    diarist: String(summary?.diarist?.key ?? ''),
    topUsage: usage.map((item) => ({ key: String(item?.key ?? ''), outputTokens: Number(item?.outputTokens) || 0 })),
    written:
      doc?.today && doc.today.label === String(summary?.label ?? '') ? doc.today.written === true : false,
    scannedAt: formatStamp(),
  }
}

/** 「今天」这一块"什么都没有"时的形状。契约：**不是 null**，是 state:'unknown' + stale:true（t4/F5）。 */
function emptyTodayPayload(label, state = 'unknown') {
  return {
    label: String(label ?? ''),
    state,
    stale: true,
    sessions: 0,
    kept: 0,
    dropped: 0,
    outputTokens: 0,
    empty: true,
    written: false,
    writtenAt: null,
    failedReason: null,
    diarist: null,
    topUsage: [],
    scannedAt: null,
    // 老字段仍然在：旧页面读它们，新增字段只许加不许改
    root: SESSIONS_ROOT,
    dirs: null,
    zstd: null,
    node: process.version,
    read: null,
    sample: null,
  }
}

/** 「写于」：优先当日文件的 mtime（真实落盘时刻），拿不到再看文档里记的写入时刻。 */
function writtenAtOf(docToday, label, dir) {
  if (!docToday || docToday.written !== true) return null
  try {
    return statSync(diaryPath(dir, label)).mtime.toISOString()
  } catch {
    /* 文件不在了（用户删了）：退回文档里的记录 */
  }
  const stamp = docToday.writtenAt
  return typeof stamp === 'string' && stamp ? isoStamp(stamp) : null
}

/** 「二、今天」段的文档记录 → 浏览器半要的形状（字段名与 client.js 对齐，别乱改）。 */
function todayPayloadOf(docToday, label, dir = '') {
  if (!docToday || docToday.label !== label) return emptyTodayPayload(label)
  const diaristKey = String(docToday.diarist ?? '')
  const topUsage = (Array.isArray(docToday.topUsage) ? docToday.topUsage : []).map((item) => ({
    ...splitDiaristKey(item?.key),
    outputTokens: Number(item?.outputTokens) || 0,
  }))
  return {
    label: docToday.label,
    state: 'ready',
    stale: stampAgeMs(docToday.scannedAt) > diaryFreshMs,
    sessions: Number(docToday.sessions) || 0,
    kept: Number(docToday.kept) || 0,
    dropped: 0,
    outputTokens: Number(docToday.outputTokens) || 0,
    empty: (Number(docToday.sessions) || 0) === 0,
    written: docToday.written === true,
    writtenAt: writtenAtOf(docToday, label, dir),
    // 上次扫描挂在哪一步：没有它就是 null（页面据此说"没算出来"而不是"今天没聊天"）
    failedReason: typeof docToday.failedReason === 'string' && docToday.failedReason ? docToday.failedReason : null,
    diarist: diaristKey ? { ...splitDiaristKey(diaristKey), outputTokens: Number(docToday.outputTokens) || 0 } : null,
    topUsage,
    scannedAt: isoStamp(docToday.scannedAt),
    // 下面几个老字段以前是"实时扫盘"换来的，现在不扫了：留着是为了旧页面不炸
    root: SESSIONS_ROOT,
    dirs: null,
    zstd: null,
    node: process.version,
    read: null,
    sample: null,
  }
}

/**
 * 首屏快照：设置页要的全部东西，**只读指针 + 记录文档**。
 *
 * 和旧实现最大的区别：这里不换任何一次 collectDay。用户原话
 * 「读取日记设置太慢了，加载的」——那 2.14 秒就是在这儿省掉的。
 */
function diarySnapshot({ logger = null } = {}) {
  const loaded = loadDiaryState({ logger })
  const label = logicalDayFor(Date.now())
  const recent = recentRowsOf(loaded.doc)
  return {
    // 契约 §a.8：快照自己带版本号和生成时刻，页面不用再猜
    schema: DIARY_DOC_SCHEMA,
    now: new Date().toISOString(),
    config: loaded.config,
    doc: docMetaOf(loaded),
    today: todayPayloadOf(loaded.doc.today, label, loaded.config.dir),
    recent,
    // 兼容字段：旧页面读 files，新页面读 recent
    files: recent.map((row) => ({ label: row.label, file: row.file, summary: row.summary })),
    // 契约键是 {at, code, message, detail}；reason/hint 是旧页面的别名，只加不改
    failure: loaded.doc.failure
      ? {
          code: String(loaded.doc.failure.code ?? 'unknown'),
          message: String(loaded.doc.failure.reason ?? ''),
          detail: String(loaded.doc.failure.hint ?? ''),
          at: isoStamp(loaded.doc.failure.at),
          reason: String(loaded.doc.failure.reason ?? ''),
          hint: String(loaded.doc.failure.hint ?? ''),
        }
      : null,
    migrated: loaded.migrated ? { ...loaded.migrated, from: 'v1-json' } : null,
    dirRecovered: loaded.dirRecovered,
    dirSuggestions: loaded.dirSuggestions ?? [],
    dirMarker: loaded.dirMarker ?? '',
    corrupted: loaded.corrupted,
    warnings: loaded.warnings,
    pending: loaded.doc.pending ?? null,
    busy: {
      // busy 一律以宿主为准（契约 §c）：页面自己记的"正在写"在刷新后就过期了
      state: diaryWriting ? 'writing' : diaryPicking ? 'picking' : 'idle',
      writing: diaryWriting,
      picking: diaryPicking,
      writingSince: diaryWritingSince,
      startedAt: diaryWritingSince ? isoStamp(diaryWritingSince) : null,
      elapsedMs: diaryWriting && diaryWritingStartedMs ? Date.now() - diaryWritingStartedMs : 0,
    },
    writtenToday: writtenTodayOf(loaded.doc, label),
    generatedAt: new Date().toISOString(),
  }
}

/* ── 今日统计：只有用户点「刷新统计」或写日记时才真算，同一时刻只算一份 ── */

let diaryScanPromise = null

/**
 * 起一次今日统计（单飞）。算完把结果写回「二、今天」段，页面下次直接读文档。
 *
 * 为什么单飞：设置页的「刷新统计」会被连点，写日记时也要统计；
 * 两份同时扫同一个目录只会把机器拖慢，还会让两边各自写一次文档。
 */
function startTodayScan(options = {}) {
  if (diaryScanPromise) return diaryScanPromise
  diaryRuntime.todayScans += 1
  const run = Promise.resolve()
    .then(() => computeDiaryTodaySummary(options))
    .then((summary) => {
      if (summary?.error) {
        // 统计自己失败（collectDay 抛了）：记下原因，**不写文档**——
        // 把失败写进「二、今天」会让下次首屏把它当成"今天的数字"
        diaryScanError = String(summary.error)
        return summary
      }
      diaryScanError = ''
      persistTodaySection(summary)
      return summary
    })
  diaryScanPromise = run.then(
    (value) => {
      diaryScanPromise = null
      return value
    },
    (error) => {
      diaryScanPromise = null
      diaryScanError = reasonOf(error)
      throw error
    },
  )
  return diaryScanPromise
}

/** 把统计结果写回记录文档；写不进去也不影响这次返回值（用户在页面上已经看到数字了）。 */
function persistTodaySection(summary) {
  try {
    if (!summary || summary.error) return
    const loaded = loadDiaryState()
    const today = todayForDoc(summary, loaded.doc)
    const text = patchTodaySection(loaded.docText, today)
    writeDocCounted(loaded.docPath, text)
  } catch {
    /* 统计写回失败只影响下次首屏的数字，绝不能让「刷新统计」本身失败 */
  }
}

/** 等一会儿（给"最多等几秒"用；unref 掉，别把宿主进程钉住）。 */
function waitMs(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * 「今天」这一块。
 *
 * 默认**不等**：手里有什么就先回什么（可能是上次的数字，也可能 state:'scanning'），
 * 同时后台起一次单飞统计，算完写回「二、今天」——页面下次来问就有新数字了。
 * 这是 t4/F7：以前这里 Promise.race 等 8 秒，等于把"慢"搬到了请求里。
 *
 * `wait:true` 只留给兼容路径 `GET /diary?today=1`（老页面会读它，方案 §a.8 允许它等 8 秒）。
 */
async function todayView({ logger = null, force = false, wait = false } = {}) {
  const label = logicalDayFor(Date.now())
  const loaded = loadDiaryState({ logger })
  const cached = todayPayloadOf(loaded.doc.today, label, loaded.config.dir)
  const fresh = cached.state === 'ready' && cached.stale !== true && !force
  if (fresh) return cached

  const scan = startTodayScan({ force: true })
  scan.catch(() => null) // 后台任务自己失败由 diaryScanError 记账，这里不让它变成 unhandled

  if (!wait) {
    if (diaryScanError) return { ...cached, state: 'failed', stale: true, failedReason: diaryScanError }
    // 有旧数字就带着旧数字（stale:true），没有就是 scanning 空壳
    const base = cached.state === 'ready' ? cached : emptyTodayPayload(label)
    return { ...base, state: 'scanning', stale: true }
  }

  const summary = await Promise.race([scan.catch(() => null), waitMs(DIARY_SCAN_WAIT_MS)])
  if (!summary) {
    const base = cached.state === 'ready' ? cached : emptyTodayPayload(label)
    return { ...base, state: 'scanning', stale: true, failedReason: diaryScanError || null }
  }
  if (summary.error) {
    return { ...emptyTodayPayload(label, 'failed'), failedReason: String(summary.error) }
  }
  const after = loadDiaryState({ logger })
  return todayPayloadOf(after.doc.today, label, after.config.dir)
}

/**
 * 改设置（POST /diary）：严格按方案 §a.5 / §a.6 的六步走。
 *
 *   ① 校验 + 目录闸门（不存在就明确拒绝；只有"新选了本子"且用户允许 autoCreate 才建）
 *   ② 「五、待办理」写进**当前**文档（此刻指针还指着它：崩了这一屏就看得出来，t4/F9）
 *   ③ 新位置的文档（「三、最近的日记」的路径跟着换前缀）
 *   ④ 指针改到新文档
 *   ⑤ 搬本子：旧目录里的 `YYYY-MM-DD.md` / `.bak` 挪过去（跨卷走复制+校验，失败整体回滚）
 *   ⑥ 收走旧位置的记录文档 → 打身份标记 → 清「待办理」
 *
 * 任何一步失败都**不许留下半换的本子**：文档回滚、指针回滚，并把失败原因写成一句人话。
 * 日记正文（用户的东西）只在第 ⑤ 步移动，且新位置已有同名文件时**跳过不覆盖**（:883）。
 */
function applyDiaryConfigPatch(patch, { logger = null } = {}) {
  const loaded = loadDiaryState({ logger })
  const next = mergeDocConfig(loaded.config, patch)
  const warnings = [...loaded.warnings]
  // 方案 §a.5 第 8 条：凡 patch 里带 dir 就重新打点（pick-dir / POST /diary / autoCreate 都走这里），
  // 十分钟内不许自动认回 —— 用户此刻的意图比任何启发式都权威。
  const touchedDir = Object.prototype.hasOwnProperty.call(patch ?? {}, 'dir')
  if (touchedDir) next.dirManualAt = formatStamp()

  // ① 目录闸门
  if (next.dir) {
    let state = dirStateOf(next.dir)
    // 只在新选了目录、且用户开着「自动新建本子」时才建；回填同一个路径不建（防手滑打错字母长出空目录）
    // 「自动新建本子」只许在**父目录确实存在**时建：打错一个字母不该在磁盘上长出一串空目录
    const parentReady = dirStateOf(dirname(next.dir)) === 'ok'
    if (state !== 'ok' && touchedDir && next.autoCreate !== false && parentReady) {
      try {
        mkdirSync(next.dir)
      } catch (error) {
        warnings.push(`建不了文件夹：${reasonOf(error)}`)
      }
      state = dirStateOf(next.dir)
    }
    if (state !== 'ok') {
      return { ok: false, code: 'bad-dir', stage: 'dir', reason: dirMessageOf(state, next.dir), dirState: state, warnings }
    }
  }

  const oldDir = typeof loaded.config.dir === 'string' ? loaded.config.dir : ''
  const newDir = typeof next.dir === 'string' ? next.dir : ''
  const targetDocPath = docPathFor(newDir, DIARY_DOC_FALLBACK)
  const movingDoc = targetDocPath !== loaded.docPath
  const movingDir = Boolean(oldDir) && Boolean(newDir) && oldDir !== newDir
  const patchedCurrent = patchConfigSection(loaded.docText, next)
  /** 回滚当前文档：把「待办理」和改了一半的配置一起撤掉。 */
  const restoreCurrentDoc = () => {
    try {
      writeDocCounted(loaded.docPath, patchedCurrent)
    } catch {
      /* 回滚失败也不 throw：调用方要回的是这次请求的结论 */
    }
  }

  // ② 「五、待办理」先落在当前文档上
  const pendingMark = { kind: 'move', dir: targetDocPath, since: formatStamp() }
  const pendingText = movingDoc ? patchPendingSection(patchedCurrent, pendingMark) : patchedCurrent
  const firstWrite = writeDocCounted(loaded.docPath, pendingText)
  if (!firstWrite.ok) {
    return { ok: false, code: 'write-failed', stage: 'doc', reason: firstWrite.reason, warnings }
  }

  // ③ 新位置的文档 + ④ 指针
  let newDocText = pendingText
  if (movingDoc) {
    newDocText = patchRecentSection(pendingText, rebaseRecentRows(loaded.doc.recent, newDir))
    const writeNew = writeDocCounted(targetDocPath, newDocText)
    if (!writeNew.ok) {
      restoreCurrentDoc()
      return { ok: false, code: 'write-failed', stage: 'doc-new', reason: writeNew.reason, warnings }
    }
    const pointer = writeDiaryPointer({ file: DIARY_FILE, docPath: targetDocPath })
    if (!pointer.ok) {
      // 指针没改成：新位置那份文档不能留（它没被任何指针引用，留着就是第二个真源）
      try {
        if (targetDocPath !== loaded.docPath && statSync(targetDocPath).isFile()) unlinkSync(targetDocPath)
      } catch {
        /* 删不掉也只是多一份没人读的文件，回滚照样继续 */
      }
      restoreCurrentDoc()
      return { ok: false, code: 'pointer-write-failed', stage: 'pointer', reason: pointer.reason, warnings }
    }
  }

  // ⑤ 搬本子（记录文档不参与：新位置那份已经写好了）
  let dirMoved = null
  if (movingDir) {
    const move = moveDiaryDir({ from: oldDir, to: newDir, exclude: [DIARY_DOC_FILE] })
    if (!move.ok) {
      // 换本子没成：指针回旧文档、旧文档去掉「待办理」，用户看到的还是一切照旧
      if (movingDoc) writeDiaryPointer({ file: DIARY_FILE, docPath: loaded.docPath })
      // 目标目录里那份新文档没被指针引用过（指针已回旧），留着就是第二个真源
      try {
        if (targetDocPath !== loaded.docPath && statSync(targetDocPath).isFile()) unlinkSync(targetDocPath)
      } catch {
        /* 删不掉也只是多一份没人读的文件 */
      }
      restoreCurrentDoc()
      warnings.push(`日记本没换成：${move.reason}`)
      return {
        ok: false,
        code: 'dir-move-failed',
        stage: 'move',
        reason: move.reason,
        detail: { failedName: move.failedName ?? '', restored: move.restored ?? [] },
        warnings,
      }
    }
    // 方案 §a.5 ③：搬「记录文档 + 它的 .bak」。moveDiaryDir 只认日记 .md，备份额外搬一次。
    // §a.9.1：身份标记跟本子走——旧目录要是被搬空了，就不该再自称是这本日记
    // （否则下次认回扫描会把它当候选，靠证据闸门才没认错）。
    const backupName = `${DIARY_DOC_FILE}.bak`
    let backupMoved = false
    try {
      const oldBackup = join(oldDir, backupName)
      const newBackup = join(newDir, backupName)
      if (existsSync(oldBackup) && !existsSync(newBackup)) {
        renameSync(oldBackup, newBackup)
        backupMoved = true
      }
    } catch (error) {
      warnings.push(`记录文档的备份没搬过去：${reasonOf(error)}`)
    }
    try {
      const staleMarker = join(oldDir, DIARY_MARKER_FILE)
      if (existsSync(staleMarker)) unlinkSync(staleMarker)
    } catch (error) {
      warnings.push(`旧目录的身份标记没删掉：${reasonOf(error)}`)
    }
    dirMoved = { from: oldDir, to: newDir, moved: move.moved.length, skipped: move.skipped, backupMoved }
    if (move.skipped.length) warnings.push(`新本子里已有同名文件，没覆盖：${move.skipped.join('、')}`)
  }

  // ⑥ 收走旧位置的记录文档（只删"确实是我们的"那一份；日记正文一个都不碰）
  if (movingDoc) removeOldDocIfOurs(loaded.docPath, targetDocPath, warnings)

  // ⑦ 身份标记：被确认过的本子打上身份证，下次改名能自己认回来。
  //    标记失败**不许**让确认目录失败（方案 §a.9.1）
  let dirMarker = ''
  if (newDir) {
    const marker = ensureDiaryMarker({ dir: newDir })
    dirMarker = marker.ok ? 'present' : 'absent'
    if (marker.written === 'failed') logger?.warn?.(`[dsh-pet-cuteness-plugin] 身份标记没写成：${marker.reason ?? ''}`)
  }

  // ⑧ 清「待办理」：整笔事务到这里才算完
  if (movingDoc) {
    const cleared = writeDocCounted(targetDocPath, patchPendingSection(newDocText, null))
    if (!cleared.ok) warnings.push(`「待办理」没清干净：${cleared.reason ?? ''}`)
  }

  return {
    ok: true,
    config: {
      ...next,
      dirState: newDir ? 'ok' : 'none',
      dirMessage: dirMessageOf(newDir ? 'ok' : 'none', newDir),
    },
    docPath: targetDocPath,
    // 契约：doc 只加不改（path/rewritten），applied 里报这次到底动了什么（t4/F4）
    doc: { path: targetDocPath, rewritten: firstWrite.skipped !== true },
    dirRecovered: null,
    dirSuggestions: [],
    dirMarker,
    applied: { dirMoved, marker: dirMarker || 'absent', docMoved: movingDoc },
    warnings,
  }
}

/**
 * 换本子之后清掉老位置的记录文档。
 *
 * 三道闸，缺一不可：文件名对、内容确实是我们的（首行标题）、而且不是新位置本身。
 * 日记正文（`YYYY-MM-DD.md`）**一个都不碰**——那是用户的，不是我们的缓存。
 */
function removeOldDocIfOurs(oldPath, newPath, warnings) {
  if (!oldPath || oldPath === newPath) return
  if (oldPath.split(/[/\\]/).pop() !== DIARY_DOC_FILE) return
  try {
    const head = readFileSync(oldPath, 'utf8').slice(0, 200)
    if (!head.includes('AI 娘的日记本记录')) return
    const insideData = oldPath.startsWith(`${DATA_DIR}/`) || oldPath === join(DATA_DIR, DIARY_DOC_FILE)
    // 老本子还在（用户主动换地方）：也删旧的，否则下次改回去会读到过期文档
    unlinkSync(oldPath)
    if (!insideData) warnings.push(`旧位置的记录文档已收走：${oldPath}`)
  } catch (error) {
    // 删不掉不影响结论（新位置的文档已经写好了），但要让用户知道旧位置还留着一份（Q5）
    warnings.push(`旧位置的记录文档没收走（${reasonOf(error)}），它已经不作数：${oldPath}`)
  }
}

/**
 * 现在就写一篇日记（路由和定时器共用这一份逻辑）。
 *
 * 流程：读配置 → 取今天的摘要 → 定执笔 → 起一只**一次性子代理**写正文
 * → 从它自己的会话日志里收正文 → 校验 → 写 `<日记本>/YYYY-MM-DD.md`。
 *
 * 为什么走子代理而不是自己调 llm：llm.stream 要自己拼完整请求（工具表、
 * 额度、重试都得管），而子代理这条路是宿主自己的机制，出错也有宿主管。
 * 为什么正文要自己收：startActivation 只回 childId，正文不在返回值里。
 *
 * 所有失败都走 `{ok:false, code, message}`，绝不 throw：定时器在午夜跑，
 * 抛出来就是一个没人接的 unhandled rejection。
 */
async function writeDiaryNow(ctx, options = {}) {
  if (diaryWriting) return { ok: false, code: 'busy', message: '已经在写了', elapsedMs: 0 }
  diaryWriting = true
  diaryWritingSince = formatStamp()
  diaryWritingStartedMs = Date.now()
  const startedAt = Date.now()
  const elapsed = () => Date.now() - startedAt
  try {
    // 状态只从记录文档来：配置、目录、「今天」全在文档里，不读第二份真相
    const loaded = loadDiaryState({ logger: ctx.logger })
    const config = loaded.config
    if (!config.enabled) return { ok: false, code: 'disabled', message: '日记没打开', elapsedMs: elapsed() }
    if (!config.dir) return { ok: false, code: 'no-dir', message: '还没选日记本文件夹', elapsedMs: elapsed() }
    const configDirState = dirStateOf(config.dir)
    if (configDirState !== 'ok') {
      return {
        ok: false,
        code: 'no-dir',
        message: dirMessageOf(configDirState, config.dir),
        dirState: configDirState,
        elapsedMs: elapsed(),
      }
    }
    // 统计要真算一次：写日记本来就得看今天聊了什么（这是**唯一**允许慢的地方）
    // `options.now` 交给统计层：定时写作要写的是**刚刚结束**的那一天，
    // 不能让它在这里重新取一次"现在"（21:00:00 之后重新取就已经翻页了）。
    const day = await startTodayScan({ withDigest: true, now: options.now }).catch(() => null)
    if (!day || day.error) {
      return { ok: false, code: 'internal', message: day?.error ?? '读不出今天的会话', elapsedMs: elapsed() }
    }
    if (day.empty) return { ok: false, code: 'empty-day', message: '今天没有任何对话，不写', elapsedMs: elapsed() }

    // 执笔的挑法（用户 2026-10-24：「默认 DeepSeek」）：
    // ① 用户在设置里选的；② 今天真正用过的那条；③ 在今天的用量榜里挑一条 DeepSeek 官方的。
    // ③ 之前根本没有——没选过就直接报「今天没有可用的执笔」，用户明明登着 DeepSeek 也会撞墙。
    let diaristKey = String(config.diarist || day?.diarist?.key || '')
    if (!diaristKey) {
      const candidates = (Array.isArray(day?.topUsage) ? day.topUsage : []).map((item) => ({ key: String(item?.key ?? '') }))
      // 兜底**: 挑不到就落到本机默认的 DeepSeek 路由，**不再报 no-diarist**——
      // 用户明明登着账号却被告知「今天没有可用的执笔」是本轮要修掉的那个毛病。
      diaristKey = pickDefaultDiarist(candidates)
    }
    const slash = diaristKey.indexOf('/')
    const provider = slash > 0 ? diaristKey.slice(0, slash) : ''
    const model = slash > 0 ? diaristKey.slice(slash + 1) : diaristKey
    const supported = checkDiaristSupported({ provider, model })
    if (!supported.ok) return { ok: false, code: 'unsupported-diarist', message: supported.reason, elapsedMs: elapsed() }

    const subagents = ctx.get('subagents', false)
    const agents = ctx.get('agents', false)
    if (typeof subagents?.startActivation !== 'function') {
      return { ok: false, code: 'no-subagents', message: '这台机器起不了执笔子代理', elapsedMs: elapsed() }
    }
    let parent = null
    try {
      parent = (agents?.roots?.() ?? [])[0] ?? null
    } catch {
      parent = null
    }
    if (!parent) return { ok: false, code: 'no-parent', message: '找不到可挂载的会话', elapsedMs: elapsed() }

    const prompt = buildDiaryPrompt({
      dateLabel: day.label,
      digest: day.digest,
      diaristKey,
      personaName: PERSONA_DISPLAY_NAME,
    })
    const request = buildActivationRequest({ prompt, provider, model, cwd: config.dir })
    // signal 是必填的：宿主内部会 `signal.throwIfAborted()`，
    // 不给就炸成 `Cannot read properties of undefined (reading 'throwIfAborted')`。
    const controller = new AbortController()
    const abortTimer = setTimeout(() => {
      controller.abort()
    }, DIARY_WRITE_TIMEOUT_MS)
    let activation
    try {
      activation = await subagents.startActivation({
        provider: 'spawn',
        label: `写日记 ${day.label}`,
        request: { ...request, parent },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(abortTimer)
    }
    const childId = activation?.childId ?? activation?.id ?? ''
    const text = await waitForChildText(childId, DIARY_WRITE_TIMEOUT_MS)
    if (!text.trim()) {
      return { ok: false, code: 'timeout', message: '执笔没写出东西来', childId, elapsedMs: elapsed() }
    }
    const body = tidyDiaryBody(text)
    const checked = validateDiaryBody(body)
    if (!checked.ok) return { ok: false, code: 'bad-body', message: checked.reason, childId, elapsedMs: elapsed() }
    const label = String(day.label)
    const content = renderDiaryFile({
      label,
      body,
      diarist: diaristKey,
      outputTokens: day?.diarist?.outputTokens ?? 0,
      sessions: Number(day?.sessions) || 0,
      writtenAt: new Date().toISOString(),
    })
    // 写这一篇的**唯一**提交点：先文档（含「待办理」）→ 再日记文件 → 再收尾。
    // 顺序在 commitDiaryWrite 里，失败会回滚/标记，绝不出现"页面说写了、盘上没有"。
    const commit = commitDiaryWrite({
      docFile: loaded.docPath,
      docText: loaded.docText,
      dir: config.dir,
      label,
      content,
      today: todayForDoc(day, loaded.doc),
      row: {
        label,
        chars: body.length,
        diarist: diaristKey,
        summary: firstSentences(body),
        file: diaryPath(config.dir, label),
      },
      failureHint: '点「现在就写」再试一次；还不行看一眼日记本文件夹的权限',
    })
    if (!commit.ok) {
      return {
        ok: false,
        code: commit.code ?? 'write-failed',
        message: commit.message ?? '写不进去',
        stage: commit.stage ?? '',
        docRolledBack: commit.docRolledBack === true,
        elapsedMs: elapsed(),
      }
    }
    return {
      ok: true,
      value: {
        file: commit.file,
        backup: commit.backup ?? '',
        label,
        chars: body.length,
        diarist: diaristKey,
        docPath: loaded.docPath,
        docSkipped: commit.docSkipped === true,
        docWarning: commit.docWarning ?? '',
        // 长任务回话：浏览器半等 180 秒，这里如实告诉它花了多久
        elapsedMs: elapsed(),
        commitElapsedMs: commit.elapsedMs ?? 0,
      },
    }
  } catch (error) {
    return { ok: false, code: 'internal', message: String(error?.message ?? error), elapsedMs: elapsed() }
  } finally {
    diaryWriting = false
    diaryWritingSince = null
  }
}

/**
 * 21:00 那一班岗：每分钟看一眼，到点且今天还没写就写一篇。
 *
 * 为什么每分钟比对而不是「算一个精确的定时器」：
 *   - 时间是用户可在设置页改的，改动后不用重建定时器；
 *   - 机器休眠/时钟跳动之后，按毫秒算的一次性定时器会整体错位，
 *     而"现在几点是不是该写"永远自愈；
 *   - 一顿多写由 `writtenDates` 台账兜住（同一天只写一次）。
 */
/**
 * 定时器自己的一份观测值。坏了不用再靠猜：`/debug` 里直接能看到「跳了多少次、
 * 上一次判断该写哪天、为什么没写」。
 */
const diarySchedulerStats = { ticks: 0, lastTickAt: '', lastDueLabel: '', lastAction: 'idle' }

/**
 * 某一天日记覆盖的窗口。切日点是 `config.time`（默认 21:00），
 * 标签 D 的窗口就是 `[D-1 21:00, D 21:00)`。
 */
export function diaryWindowFor(label, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(label || ''))
  if (!m) return null
  const parts = String(time || DAY_ROLLOVER_TIME).split(':')
  const hh = Number(parts[0])
  const mm = Number(parts[1])
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number.isFinite(hh) ? hh : 21, Number.isFinite(mm) ? mm : 0, 0, 0).getTime()
  return { end, start: end - 24 * 3600 * 1000 }
}

/**
 * 现在「该写哪一天」——最近一个已经过了写作时刻的那一天。
 *
 * 为什么不再要求「此刻正好是 HH:MM」：用户 2026-10-24 报过「快 22 点了还没自动写」。
 * 原因就是老实现按分钟精确比对，只要那一分钟没轮到（机器休眠、App Nap 节流、
 * 插件那一分钟恰好在重载），这一天就永远丢了，而且不报错、不留失败记录。
 * 现在改成「补写」：过了 21:00 之后任何一分钟发现还没写，就补上；
 * 太晚（超过 12 小时）就不补了，免得第二天开机突然冒出一篇前天的日记。
 *
 * @returns {{label: string|null, end: number, late: boolean}}
 */
export function dueDiaryLabel(now, time) {
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const at = String(time || DAY_ROLLOVER_TIME)
  const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  // 今天这一篇的窗口终点是「今天 config.time」；还没到点就退回昨天那一篇。
  const todayLabel = stamp(now)
  const todayWindow = diaryWindowFor(todayLabel, at)
  const label = clock >= at ? todayLabel : stamp(new Date(now.getTime() - 24 * 3600 * 1000))
  const window = diaryWindowFor(label, at)
  return { label, end: window ? window.end : todayWindow ? todayWindow.end : 0, late: false }
}

/**
 * 定时器每分钟走一次：到点、或「已经过点但还没写」，就补一篇。
 *
 * 为什么每分钟比对而不是「算一个精确的定时器」：
 *   - 时间是用户可在设置页改的，改动后不用重建定时器；
 *   - 机器休眠/时钟跳动之后，按毫秒算的一次性定时器会整体错位，
 *     而"现在几点是不是该写"永远自愈；
 *   - 一顿多写由 `writtenDates` 台账兜住（同一天只写一次）。
 */
function maybeRunScheduledDiary(ctx) {
  diarySchedulerStats.ticks += 1
  diarySchedulerStats.lastTickAt = new Date().toISOString()
  try {
    // 每分钟只读指针 + 记录文档这两个小文件：定时器这条路绝不能扫会话日志
    const loaded = loadDiaryState({ logger: ctx.logger })
    const config = loaded.config
    if (!config.enabled || !config.dir || loaded.dirState !== 'ok') {
      diarySchedulerStats.lastAction = 'disabled'
      return
    }
    const now = new Date()
    const due = dueDiaryLabel(now, config.time)
    diarySchedulerStats.lastDueLabel = due.label || ''
    // 「今天写过没有」的台账从文档来（旧实现放在配置 JSON 的 writtenDates 里）。
    if (due.label && writtenTodayOf(loaded.doc, due.label)) {
      diarySchedulerStats.lastAction = 'already-written'
      return
    }
    if (!due.label) {
      diarySchedulerStats.lastAction = 'no-label'
      return
    }
    // 补写只补最近 12 小时内的那一篇：再久就不自动补了，免得开一次机连环补写。
    const tooLate = due.end > 0 && now.getTime() - due.end > 12 * 3600 * 1000
    if (!tooLate && due.end > 0 && now.getTime() < due.end) {
      // 还没到点：这一篇要等过了 config.time 才算结束，不写。
      diarySchedulerStats.lastAction = 'not-due'
      return
    }
    if (tooLate) {
      diarySchedulerStats.lastAction = 'too-late'
      return
    }
    if (diaryWriting) {
      diarySchedulerStats.lastAction = 'busy'
      return
    }
    diarySchedulerStats.lastAction = 'writing:' + due.label
    // 重要：把「窗口终点前 1 毫秒」传下去，扫描与落盘才会用同一个 label。
    void writeDiaryNow(ctx, { now: due.end - 1 })
  } catch (error) {
    diarySchedulerStats.lastAction = 'error'
    ctx.logger?.warn?.(`[dsh-pet-cuteness-plugin] 日记定时检查失败：${error?.message ?? error}`)
  }
}

/**
 * 读一次执笔的结果：从她那只子代理的会话日志里把正文捞出来。
 *
 * 只认它自己的会话（按 childId 找目录），取**最后一条** assistant 消息的
 * 全部 text 块拼起来。为什么要拼全部：一条消息可能被拆成多个 block，
 * 只取第一个 block 会截成半句——这坑我在 78 字的"正文太短"上报过一次。
 */
function collectChildText(childId) {
  if (!childId) return ''
  let dirs = []
  try {
    dirs = listAllSessionDirs(SESSIONS_ROOT)
  } catch {
    return ''
  }
  const key = String(childId)
  const dir = dirs.filter((name) => name === key || name.endsWith(`/${key}`)).pop()
  if (!dir) return ''
  const file = join(SESSIONS_ROOT, dir, 'session.v4.jsonl.zstd')
  let events = []
  try {
    events = readSessionEvents(file)
  } catch {
    return ''
  }
  let text = ''
  for (const event of events) {
    if (event?.type !== 'assistant/message') continue
    const content = event?.data?.message?.content
    if (!Array.isArray(content)) continue
    const joined = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    if (joined.trim()) text = joined
  }
  return text
}

/** 等子代理写完：最多等 `timeoutMs`，每 1000ms 看一次。 */
async function waitForChildText(childId, timeoutMs) {
  const step = 1000
  const deadline = Date.now() + timeoutMs
  let previous = ''
  for (;;) {
    const text = collectChildText(childId)
    // 连续两次读到同一份正文才算写完：只看到一次的话，多半是它还在往外吐。
    if (text.trim() && text === previous) return text
    previous = text
    if (Date.now() >= deadline) return text
    await new Promise((resolve) => {
      setTimeout(resolve, step)
    })
  }
}

/**
 * 列出所有会话目录（两层：`<workspace-key>/session-<id>`）。
 *
 * 为什么不能只用 `listSessionDirs(SESSIONS_ROOT)`：`$DSH_HOME/sessions` 底下是
 * **每个 workspace 一个目录**，会话在第二层。只扫一层的话当天永远是 0 条，
 * 而且不报错——这种"静默空"最难查，2026-10-23 实测撞到过。
 *
 * 返回相对路径（`--ws--/session-x`），`collectDay` 拼 `${root}/${name}/${file}` 仍成立。
 */
export function listAllSessionDirs(root) {
  const out = []
  let topLevel = []
  try {
    topLevel = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry?.isDirectory?.() !== false)
      .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
      .filter((name) => typeof name === 'string' && name)
  } catch {
    return out
  }
  for (const name of topLevel) {
    let children = []
    try {
      children = readdirSync(join(root, name), { withFileTypes: true })
        .filter((entry) => entry?.isDirectory?.() !== false)
        .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
        .filter((child) => typeof child === 'string' && child)
    } catch {
      children = []
    }
    for (const child of children) out.push(`${name}/${child}`)
  }
  return out
}

/** 今天有没有可写的东西：只取统计，不把正文往外吐（正文可能很长）。 */
// 这个函数要扫 sessions 根下所有会话目录、逐个解 zstd，几百毫秒到几秒。
// 用户原话「读取日记设置太慢了，加载的」——设置面板一打开就调它，就卡在那儿。
// 两条一起用：① GET /diary 默认不算它（只有 ?today=1 才算）；② 算过就缓存 30 秒。
const DIARY_TODAY_TTL_MS = 30000
let diaryTodayCache = null // { at, label, value }

function diaryTodaySummary(options = {}) {
  const now = Date.now()
  const fresh = diaryTodayCache && now - diaryTodayCache.at < DIARY_TODAY_TTL_MS
  if (!options.force && fresh && !options.withDigest) return diaryTodayCache.value
  const value = computeDiaryTodaySummary(options)
  if (!options.withDigest) diaryTodayCache = { at: Date.now(), label: value?.label ?? '', value }
  return value
}

function computeDiaryTodaySummary(options = {}) {
  let dirs = []
  let readOk = 0
  let readFail = 0
  let firstError = ''
  try {
    const day = collectDay({
      sessionsRoot: SESSIONS_ROOT,
      now: options.now ?? Date.now(),
      listDirs: (root) => {
        dirs = listAllSessionDirs(root)
        return dirs
      },
      readEvents: (file) => {
        let events
        try {
          events = readSessionEvents(file)
        } catch (error) {
          readFail += 1
          if (!firstError) firstError = String(error?.message ?? error)
          return []
        }
        if (Array.isArray(events) && events.length) readOk += 1
        else readFail += 1
        return events
      },
    })
    return {
      label: day.label,
      // 把"我到底扫了哪儿、扫到几个目录"一起回出去：
      // 这个功能最坑的失败形态是**静默空**（0 条，且不报错），
      // 没有这两个字段就只能靠猜是"今天真没聊"还是"路径不对"。
      root: SESSIONS_ROOT,
      // 能不能解 .zstd 直接决定"0 条"是真没聊天还是解不开——必须回给 UI。
      zstd: zstdAvailable(),
      node: process.version,
      dirs: Array.isArray(dirs) ? dirs.length : 0,
      sessions: day.sessions.length,
      kept: day.kept,
      dropped: day.dropped,
      empty: day.empty,
      diarist: day.diarist,
      topUsage: day.usage.slice(0, 3),
      // 正文摘要只在写日记时才需要（可能十几万字），默认不往外吐。
      ...(options.withDigest === true ? { digest: day.digest } : {}),
      // 读盘成功率：0 条有两种原因（今天真没聊 / 一个文件都读不开），这里把它们分开。
      read: { ok: readOk, fail: readFail, firstError },
      sample: sampleSessionRead(dirs),
    }
  } catch (error) {
    return { error: String(error?.message ?? error), root: SESSIONS_ROOT, sample: sampleSessionRead(dirs) }
  }
}

/**
 * 抽一个会话文件做"能不能读通"的抽样。
 *
 * 为什么需要它：`sessions: 0` 有两种完全不同的原因——今天真没聊天，或者
 * 这台机器的运行时读不了 `.zstd`（或文件名不是我以为的那个）。两者在
 * 设置页上都只显示一个 0，不给抽样就只能靠猜。抽样只读一个文件，成本可忽略。
 */
function sampleSessionRead(dirs) {
  const dir = Array.isArray(dirs) && dirs.length ? dirs[dirs.length - 1] : undefined
  if (!dir) return { ok: false, reason: '没有会话目录' }
  const file = join(SESSIONS_ROOT, dir, 'session.v4.jsonl.zstd')
  let size = 0
  try {
    size = statSync(file).size
  } catch (error) {
    return { ok: false, file, reason: `读不到文件：${error?.message ?? error}` }
  }
  // 对照两条路：①直接丢给 node:zlib 的 zstd（宿主 v24 只解第一帧）
  // ②我们自己按帧切的 decompressZstdFrames。两边差多少一眼能看出来。
  let rawBytes = null
  let rawError = ''
  try {
    const plain = zstdDecompressSync(readFileSync(file))
    rawBytes = plain.length
  } catch (error) {
    rawError = String(error?.message ?? error)
  }
  let events = 0
  let eventsError = ''
  try {
    events = readSessionEvents(file).length
  } catch (error) {
    eventsError = String(error?.message ?? error)
  }
  return { ok: true, file, size, rawBytes, rawError, events, eventsError }
}

/**
 * 读 JSON 请求体。任何异常都返回 undefined（调用方回 400），绝不抛到路由之外。
 * @param {any} req
 * @returns {Promise<any|undefined>}
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    const fail = () => resolve(undefined)
    try {
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          fail()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve(text ? JSON.parse(text) : {})
        } catch {
          resolve(undefined)
        }
      })
      req.on('error', fail)
    } catch {
      resolve(undefined)
    }
  })
}

/** 统一回 JSON。连接已断时忽略二次异常。 */
function writeJson(res, status, payload) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  } catch {
    try {
      res.writeHead(500)
      res.end()
    } catch {
      /* 连接已断，忽略 */
    }
  }
}

/**
 * 注册开关的 HTTP 桥。
 *
 * 为什么需要它：浏览器半（挂件、输入框旁的小开关、设置页）没有任何通道能改
 * **宿主**状态，而「人设」「中文思考」必须由宿主侧生效。走宿主已有的
 * `webServer.register`——这是官方给插件的正规口子，不是绕路。
 *
 * 安全边界（本插件唯一对外暴露的写入口，必须收紧）：
 *   1. 只认 POST（读状态 / 诊断 / 台词那三条 GET 除外）；
 *   2. 只认同源/回环请求；
 *   3. 请求体 < 1KB；
 *   4. 只接受 FLAG_KEYS 白名单里的 flag 名，不做通用写。
 */
function registerToggleBridge(ctx, toggles, getDiagnostics, getLineFeed) {
  // ⚠️ 必须用 ctx.inject 等 webServer 就绪，不能 ctx.get('webServer', false) 直接拿。
  //
  // 踩过的坑（实测）：apply 执行时 webServer 还没挂上，`ctx.get` 返回 false，
  // 于是整段桥静默跳过——路由从来没注册过。症状是浏览器请求一律 401，
  // 而 401 来自宿主 client-connection 的 `/api` 前缀鉴权（`kind:"prefix"`,
  // path:"/api"），它把没有认证 cookie 的请求挡在门外，看起来像"我的鉴权太严"，
  // 实际是"我的路由不存在"。对照实验：free-search 的
  // /api/dsh-free-search-settings/describe 无 cookie 也返回 405（路由存在），
  // 而我们的 /api/dsh-pet-cuteness-plugin/state 返回 401（路由不存在，被前缀处理器接管）。
  ctx.inject(['webServer'], (webCtx) =>
    registerToggleBridgeRoutes(webCtx, toggles, getDiagnostics, getLineFeed),
  )
}

function registerToggleBridgeRoutes(ctx, toggles, getDiagnostics, getLineFeed) {
  const webServer = ctx.get('webServer', false)
  if (!webServer || typeof webServer.register !== 'function') {
    // 没有 webServer（headless / SDK 形态）：开关只能手改配置文件，挂件退化为只读。
    ctx.logger?.info?.('[dsh-pet-cuteness-plugin] webServer 不可用，开关桥未注册（只读模式）')
    return
  }

  /** 只放行回环或同源。跨站写配置可被恶意页面利用。 */
  function sameOrigin(req) {
    try {
      const host = String(req?.headers?.host ?? '')
      if (!host) return false
      const hostname = host.split(':')[0].toLowerCase()
      if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') {
        return true
      }
      // 非回环（局域网部署）：要求 Origin 与 Host 一致
      const origin = String(req?.headers?.origin ?? '')
      if (!origin) return false
      try {
        return new URL(origin).host === host
      } catch {
        return false
      }
    } catch {
      return false
    }
  }

  const routes = [
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/state`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })
        // sessionId 可选：带上它，返回体里就有 effective/sources。
        // 这是"设置页开了却没反应"的可判定信号——浏览器半据此判断本会话是否覆盖了默认值。
        let sessionId
        try {
          const url = new URL(String(req?.url ?? '/'), 'http://local')
          sessionId = url.searchParams.get('sessionId') ?? undefined
        } catch {
          sessionId = undefined
        }
        return writeJson(res, 200, { ok: true, value: statePayload(toggles.snapshot(), sessionId) })
      },
    },
    {
      // 宠物位置：台词气泡要跟着右下角那只鲸鱼娘走，不能钉死在输入框上方。
      // 位置由 dsh-pet 维护在 `$DSH_HOME/pet.json` 的 `display` 里，用户拖一次就变一次，
      // 所以浏览器半得轮询这里。读不到就回 null，气泡退回默认位置，不报错。
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/pet`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })
        // 位置是老职责（气泡跟着立绘走）；`installed`/`enabled`/`affinity` 是给设置页用的：
        // 「挂件在不在、开没开」决定显示哪张提示卡，亲密度初值顺路带回去，省一次请求。
        const probe = probePet(ctx)
        let affinity = null
        let treats = null
        // 一次读盘、两次解析：这条路径是 2 秒一次的兜底轮询，读两遍是在白烧磁盘。
        let petText = ''
        try {
          petText = readFileSync(petFilePath(), 'utf8')
        } catch {
          petText = ''
        }
        if (petText) {
          try {
            const read = readPoints(petText)
            if (read.ok) affinity = { points: read.points, max: AFFINITY_MAX }
          } catch {
            affinity = null
          }
          try {
            const read = readTreats(petText)
            if (read.ok) {
              // 上限同样以挂件为准：它默认只许 20 个，界面按 999 放行只会白让用户填。
              const petMax = liveTreatsMax(ctx)
              treats = { treats: read.treats, max: petMax === null ? TREATS_MAX : Math.min(TREATS_MAX, petMax) }
            }
          } catch {
            treats = null
          }
        }
        return writeJson(res, 200, {
          ok: true,
          value: Object.assign(readPetDisplay() ?? {}, probe, { affinity, treats }),
        })
      },
    },
    {
      // 亲密度：一条路由两种方法。
      // 为什么不拆成两条同路径的路由：路由是按 path 注册的，同 path 注册两次要么报冲突、
      // 要么后一条被前一条挡住（GET 会把 POST 吃掉）。所以这里按 `req.method` 分派。
      // 也为什么不塞进 `/pet`：`/pet` 在气泡那边是高频兜底路径（2 秒一次），
      // 亲密度是低频设置项，混一起会让它跟着抖。
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/pet/affinity`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })
        if (req.method !== 'GET' && req.method !== 'POST') {
          return writeJson(res, 405, { ok: false, code: BRIDGE_ERRORS.METHOD })
        }
        const probe = probePet(ctx)
        if (!probe.installed) return writeJson(res, 200, { ok: false, code: 'no-pet', message: '没装挂件' })

        if (req.method === 'GET') {
          let text = ''
          try {
            text = readFileSync(petFilePath(), 'utf8')
          } catch {
            return writeJson(res, 200, { ok: false, code: 'no-pet', message: '还没找到挂件的状态文件（pet.json）' })
          }
          const read = readPoints(text)
          if (!read.ok) return writeJson(res, 200, { ok: false, code: read.code, message: '挂件的状态文件读不懂' })
          // 显示口径以**挂件内存**为先：它才是用户眼前那只挂件正在用的数。
          // （文件只是它的草稿，随时会被内存快照整份覆盖。）
          const live = livePoints(ctx)
          return writeJson(res, 200, {
            ok: true,
            value: {
              points: live === null ? read.points : live,
              max: AFFINITY_MAX,
              installed: probe.installed,
              enabled: probe.enabled,
              // 没有 HMR 时改完要重启才生效，界面要能提前说清楚。
              reloadable: (() => {
                try {
                  return typeof ctx.get('pluginManager', false)?.reload === 'function'
                } catch {
                  return false
                }
              })(),
            },
          })
        }

        // POST：body 必须是 `{points: number}`（白名单，别的一律不收）。流程见 writePetAffinity。
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return writeJson(res, 200, { ok: false, code: 'bad-body', message: '要的是 {"points": 数字}' })
        }
        const keys = Object.keys(body)
        if (keys.length !== 1 || keys[0] !== 'points') {
          return writeJson(res, 200, { ok: false, code: 'bad-body', message: '只收 points 这一个字段' })
        }
        const clamped = clampPoints(body.points)
        if (!clamped.ok) {
          return writeJson(res, 200, { ok: false, code: 'bad-points', message: '亲密度要填 0 到 ' + AFFINITY_MAX + ' 之间的整数' })
        }
        const result = await writePetAffinity(ctx, clamped.points)
        if (!result.ok) return writeJson(res, 200, result)
        return writeJson(res, 200, { ok: true, value: result })
      },
    },
    {
      // 小鱼干（treats）：和 `/pet/affinity` 完全同构——一条路由两种方法，按 req.method 分派。
      // 为什么不拆两条：同 path 注册两次会被 webServer 判重复（见 tests/bridge-routes.test.mjs）。
      // 为什么不塞进 `/pet`：那条是 2 秒一次的兜底轮询，写通道混进去会让它跟着抖。
      //
      // 上限 999 是用户口径（「最多给他刷到 999 个」），来源是 src/affinity-store.mjs 的 TREATS_MAX，
      // 这里不许再写一个 999。
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/pet/treats`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })
        if (req.method !== 'GET' && req.method !== 'POST') {
          return writeJson(res, 405, { ok: false, code: BRIDGE_ERRORS.METHOD })
        }
        const probe = probePet(ctx)
        if (!probe.installed) return writeJson(res, 200, { ok: false, code: 'no-pet', message: '没装挂件' })

        if (req.method === 'GET') {
          let text = ''
          try {
            text = readFileSync(petFilePath(), 'utf8')
          } catch {
            return writeJson(res, 200, { ok: false, code: 'no-pet', message: '还没找到挂件的状态文件（pet.json）' })
          }
          const read = readTreats(text)
          if (!read.ok) return writeJson(res, 200, { ok: false, code: read.code, message: '挂件的状态文件读不懂' })
          const live = liveTreats(ctx)
          const petMax = liveTreatsMax(ctx)
          return writeJson(res, 200, {
            ok: true,
            value: {
              treats: live === null ? read.treats : live,
              // 上限必须报**挂件自己的**（它默认只允许 20 个），不能报我们想要的口径；
              // 报 999 会让界面允许填 999，用户填完发现被夹回 20，白生气一场。
              max: petMax === null ? TREATS_MAX : Math.min(TREATS_MAX, petMax),
            },
          })
        }

        // POST：body 必须是 `{treats: number}`（白名单，别的一律不收）。流程见 writePetTreats。
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return writeJson(res, 200, { ok: false, code: 'bad-body', message: '要的是 {"treats": 数字}' })
        }
        const keys = Object.keys(body)
        if (keys.length !== 1 || keys[0] !== 'treats') {
          return writeJson(res, 200, { ok: false, code: 'bad-body', message: '只收 treats 这一个字段' })
        }
        const petMax = liveTreatsMax(ctx)
        const cap = petMax === null ? TREATS_MAX : Math.min(TREATS_MAX, petMax)
        const clamped = clampTreats(body.treats, cap)
        if (!clamped.ok) {
          return writeJson(res, 200, {
            ok: false,
            code: 'bad-treats',
            message: '小鱼干要填 0 到 ' + cap + ' 之间的整数' + (petMax !== null && petMax < TREATS_MAX ? '（' + cap + ' 是挂件自己定的上限）' : ''),
          })
        }
        const result = await writePetTreats(ctx, clamped.treats)
        if (!result.ok) return writeJson(res, 200, result)
        return writeJson(res, 200, { ok: true, value: result })
      },
    },
    {
      // 顺手把挂件打开（用户诉求 m00570：「开我们的时候，也把它开关带上」）。
      //
      // 为什么不走 `SettingsForms.update('pet', ...)`：那条路要先拿到 settings 服务、
      // 还要自己算 revision，任何一步对不上就是静默失败。而 pet 自己的服务实例上
      // 就有 `setEnabled(boolean)`（dsh-pet lib/index.js），调它一样是热改，不用重挂。
      // 拿不到服务就老实说「没装」，不要假装成功。
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/pet/enable`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, code: BRIDGE_ERRORS.METHOD })
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })
        let pet = null
        try {
          pet = ctx.get('pet', false)
        } catch {
          pet = null
        }
        if (!pet) return writeJson(res, 200, { ok: false, code: 'no-pet', message: '没装挂件，装好之后这里就能一键打开' })
        if (typeof pet.setEnabled !== 'function') {
          return writeJson(res, 200, { ok: false, code: 'settings-unavailable', message: '这个版本的挂件没有对外提供开关' })
        }
        try {
          pet.setEnabled(true)
        } catch (error) {
          return writeJson(res, 200, {
            ok: false,
            code: 'settings-unavailable',
            message: '打开挂件失败：' + String(error?.message ?? error),
          })
        }
        return writeJson(res, 200, { ok: true, value: { enabled: probePet(ctx).enabled } })
      },
    },
    {
      // 选日记本文件夹：浏览器半开不了系统选择框，只能让宿主去开。
      // 用户点「选文件夹」→ 这里调 directoryPickerController.pick() →
      // 选完直接把路径写进配置并回给页面。取消（null）不算错误。
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/diary/pick-dir`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, code: BRIDGE_ERRORS.METHOD })
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })
        diaryPicking = true
        try {
          const picker = ctx.get('directoryPickerController', false)
          if (typeof picker?.pick !== 'function') {
            return writeJson(res, 200, { ok: false, code: 'no-picker', message: '这个宿主没有目录选择器，手动填路径吧' })
          }
          const controller = new AbortController()
          const picked = await picker.pick(controller.signal)
          if (!picked) return writeJson(res, 200, { ok: false, code: 'cancelled' })
          if (!isDirectoryPath(picked)) {
            return writeJson(res, 200, { ok: false, code: 'bad-dir', message: '选中的不是文件夹' })
          }
          // 确认目录 = 写文档 + 打 dirManualAt + 补身份标记（方案 §a.5 第 8 条 / §a.9.1）
          const applied = applyDiaryConfigPatch({ dir: picked }, { logger: ctx.logger })
          if (!applied.ok) return writeJson(res, 200, { ok: false, code: applied.code, message: applied.reason })
          return writeJson(res, 200, { ok: true, value: { dir: picked, doc: applied.doc, dirMarker: applied.dirMarker, applied: applied.applied } })
        } catch (error) {
          return writeJson(res, 200, { ok: false, code: 'internal', message: String(error?.message ?? error) })
        } finally {
          // 选文件夹是长动作：进入置 true，放手置 false（t4/F12）。
          // finally 里收，用户中途按 Esc / 选择器抛错都不会把 busy 永久挂住。
          diaryPicking = false
        }
      },
    },
    {
      // 现在就写一篇（D2 真机执笔 + D3 落盘）。
      //
      // 流程：读配置 → 取今天的摘要 → 定执笔 → 起一只**一次性子代理**写正文
      // → 从它自己的会话日志里收正文 → 校验 → 写 `<日记本>/YYYY-MM-DD.md`。
      //
      // 为什么走子代理而不是自己调 llm：llm.stream 要自己拼完整请求（工具表、
      // 额度、重试都得管），而子代理这条路是宿主自己的机制，出错也有宿主管。
      // 为什么正文要自己收：startActivation 只回 childId，正文不在返回值里。
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/diary/write`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, code: BRIDGE_ERRORS.METHOD })
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })
        const result = await writeDiaryNow(ctx)
        return writeJson(res, 200, result)
      },
    },
    {
      // 台词层：长轮询拉"她刚才嘀咕的那几句"。
      //
      // 为什么是长轮询而不是 SSE/WebSocket：桥是一问一答的 HTTP 处理器，
      // 拉成流要自己管连接、心跳、断开重连；台词是**装饰性**功能，
      // 多一个长连接就多一个故障面。等 15 秒拿不到就回空，前端再问一次即可。
      //
      // 为什么带 sessionId：台词按会话分桶，别的会话的嘀咕不能跑到这个对话框里。
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/lines`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, code: BRIDGE_ERRORS.METHOD })
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })
        let url
        try {
          url = new URL(String(req?.url ?? '/'), 'http://local')
        } catch {
          return writeJson(res, 400, { ok: false, code: BRIDGE_ERRORS.BAD_SESSION })
        }
        const sessionId = url.searchParams.get('sessionId')
        if (!sessionId) return writeJson(res, 400, { ok: false, code: BRIDGE_ERRORS.BAD_SESSION })
        const cursorRaw = Number(url.searchParams.get('cursor'))
        const cursor = Number.isInteger(cursorRaw) && cursorRaw >= 0 ? cursorRaw : 0
        const waitRaw = Number(url.searchParams.get('wait'))
        const waitMs = Number.isFinite(waitRaw) && waitRaw > 0 ? Math.min(waitRaw, 15000) : 0

        // 开关关着：立刻回空，不要让浏览器白等 15 秒（关掉台词还要卡住对话框很怪）。
        if (toggles.isEnabled(sessionId, 'lines') !== true) {
          return writeJson(res, 200, { ok: true, value: { cursor, lines: [], enabled: false } })
        }

        const feed = typeof getLineFeed === 'function' ? getLineFeed() : null
        if (!feed || typeof feed.wait !== 'function') {
          return writeJson(res, 200, { ok: true, value: { cursor, lines: [], enabled: true, unavailable: true } })
        }

        await feed.wait(sessionId, cursor, waitMs)
        let page = feed.read(sessionId, cursor)
        if (page.lines.length === 0) {
          // 断流了（跑工具、等模型、或者干脆没在跑）：用角色卡垫一句，
          // 免得"气泡一停就停几十秒"。补不出来就老实回空，前端继续问。
          const state = lineStateOf(sessionId)
          const idleFor = Date.now() - (state.lastLineAt || 0)
          if (idleFor >= CARD_IDLE_MIN_MS) {
            pushCardLine(sessionId, ['idle', 'thinking'], CARD_IDLE_MIN_MS)
            page = feed.read(sessionId, cursor)
          }
        }
        return writeJson(res, 200, { ok: true, value: { ...page, enabled: true } })
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/session`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, code: BRIDGE_ERRORS.METHOD })
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })
        const body = await readJsonBody(req)
        if (!body || typeof body.sessionId !== 'string' || !body.sessionId) {
          return writeJson(res, 400, { ok: false, code: BRIDGE_ERRORS.BAD_SESSION })
        }
        const patch = parseSessionPatch(body)
        if (!patch.ok) {
          // 一个可写的键都没有才算失败。已删除的 widget 不再整单拒绝：
          // 旧页面把它和 persona 一起提交时，整单拒绝会让本来该生效的那项也丢掉
          // ——用户看到的就是「语气和中文思考点了没反应」。
          return writeJson(res, 400, {
            ok: false,
            code: patch.code,
            accepted: patch.accepted,
            rejected: patch.rejected,
          })
        }
        // 先写、再读快照。顺序反了的话 effective/sources 反映的是**改之前**的状态，
        // UI 会看到「刚把语气打开，界面却说它还是关的」——正是这次要根除的那类症状。
        toggles.setSessionFlags(body.sessionId, patch.flags)
        const snapshot = toggles.snapshot()
        return writeJson(res, 200, {
          ok: true,
          value: {
            sessionId: body.sessionId,
            session: snapshot.sessions[body.sessionId] ?? {},
            effective: flagsForSession(snapshot.sessions, body.sessionId, snapshot.defaults),
            sources: flagSources(snapshot.sessions, body.sessionId),
            // 旧页面还会带 widget：写进去了没有要让它能看见，但不能再拖累同单的其他键。
            ignored: patch.ignored,
          },
        })
      },
    },
    {
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/defaults`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, code: BRIDGE_ERRORS.METHOD })
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })
        const body = await readJsonBody(req)
        const patch = parseDefaultsPatch(body)
        if (!patch.ok) {
          return writeJson(res, 400, { ok: false, code: patch.code, accepted: patch.accepted })
        }
        const saved = toggles.setDefaults(patch.flags)
        return writeJson(res, 200, {
          ok: true,
          value: patch.ignored ? { ...saved, ignored: patch.ignored } : saved,
        })
      },
    },
    {
      // 日记：GET 读配置 + 今天有没有可写的东西 + 最近写过哪几篇；POST 改配置。
      //
      // 为什么两条方法合在一个 handler 里：`webServer.register` 对同一个 (kind, path)
      // **重复注册会抛错**，写成两条同 path 的 entry 会把整个桥注册打断。
      //
      // GET 的 `?today=0` 可以跳过当天扫描（那一步要解压一堆会话日志，够慢）。
      // POST 只改配置、**不触发写作**：写作要花钱起子代理，必须由用户明确点一下。
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/diary`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })

        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          const patch = validateDiaryPatch(body, { isDirectory: isDirectoryPath })
          if (!patch.ok) return writeJson(res, 400, { ok: false, code: BRIDGE_ERRORS.BAD_FLAGS, reason: patch.reason })
          // 先文档（含「五、待办理」）→ 再指针 → 再清旧文档 → 最后打身份标记，见 §a.5 / §a.6
          const applied = applyDiaryConfigPatch(patch.config, { logger: ctx.logger })
          if (!applied.ok) {
            const status = applied.code === 'bad-dir' ? 400 : 200
            return writeJson(res, status, {
              ok: false,
              code: applied.code,
              // 契约：失败要说清"挂在哪一步"，只给一个码用户没法自救（t4/F10）
              stage: applied.stage ?? '',
              reason: applied.reason ?? '',
              detail: applied.detail ?? null,
              dirState: applied.dirState,
              warnings: applied.warnings ?? [],
            })
          }
          return writeJson(res, 200, {
            ok: true,
            value: {
              config: applied.config,
              docPath: applied.docPath,
              // doc:{path,rewritten} 与 applied:{dirMoved,marker} 都是**新增**字段（t4/F4）
              doc: applied.doc,
              dirMarker: applied.dirMarker,
              applied: applied.applied,
              warnings: applied.warnings,
            },
          })
        }

        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, code: BRIDGE_ERRORS.METHOD })

        // GET：**只读一次记录文档**（+ 一次指针），不扫会话、不 readdir 日记本、不逐个读日记文件。
        const snapshotValue = diarySnapshot({ logger: ctx.logger })
        let url = null
        try {
          url = new URL(String(req?.url ?? '/'), 'http://local')
        } catch {
          url = null
        }
        const want = url?.searchParams.get('today')
        // ?today=1 才做当天统计（要解压会话日志，慢）。默认路径一次 collectDay 都不碰。
        // 兼容路径：老页面读 ?today=1，这里仍允许等 8 秒（方案 §a.8）；
        // 新页面走 /diary/today，那条**立刻返回** scanning（t4/F7）。
        if (want === '1' || want === 'true') snapshotValue.today = await todayView({ logger: ctx.logger, wait: true })
        return writeJson(res, 200, { ok: true, value: snapshotValue })
      },
    },
    {
      // 今日统计单独一条：设置页先出壳（GET /diary），再让它自己来问这个，慢的活不挡首屏。
      // 这里最多等 8 秒（DIARY_SCAN_WAIT_MS）就回 scanning（stale + 旧数据），后台接着算完写回「二、今天」。
      // 三处时间配套，别只按一个数字改：
      //   · 宿主这里等 8 秒；
      //   · 浏览器半单次请求给 15 秒（client 的 DIARY_STATS_TIMEOUT_MS），比 8 秒多留余量；
      //   · 浏览器半拿到 scanning 后每 1500ms 追问一次、最多 20 次（≈30 秒）。
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/diary/today`,
      handler: async (req, res) => {
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, code: BRIDGE_ERRORS.METHOD })
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })
        let force = false
        try {
          const url = new URL(String(req?.url ?? '/'), 'http://local')
          const refresh = url.searchParams.get('refresh')
          force = refresh === '1' || refresh === 'true'
        } catch {
          force = false
        }
        const value = await todayView({ logger: ctx.logger, force })
        return writeJson(res, 200, { ok: true, value })
      },
    },
    {
      // 重新读取：把"用户在外面手改了记录文档"这件事变成一条显式动作。
      // 顺带清掉认回缓存——他刚刚可能在外面把文件夹改回来了，不该被 120 秒缓存挡住。
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/diary/reload`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, code: BRIDGE_ERRORS.METHOD })
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })
        resetRecoveryCache()
        diaryRuntime.dirScans = 0
        const value = diarySnapshot({ logger: ctx.logger })
        return writeJson(res, 200, { ok: true, value })
      },
    },
    {
      // 「不是我那个」：用户明确否掉一个被认回的候选。
      //
      // 三件套（t4/F3）：①把路径追加进「不自动认回」→ 以后别再自动认它；
      // ②dir 回退到认回之前的位置（dirRecovered.from）——于是页面会回到"本子不在"的黄卡；
      // ③返回与 GET /diary **完全同构**的快照，前端整包替换 state，不用自己拼。
      // 只动记录文档里的一行字，绝不碰用户目录本身。
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/diary/reject-dir`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, code: BRIDGE_ERRORS.METHOD })
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })
        const body = await readJsonBody(req)
        const to = typeof body?.to === 'string' ? body.to.trim() : ''
        // 错码统一 'bad-dir'（t4/F3）：页面只认这一个码就够，别让它同时处理 bad-request。
        if (!to || !/^([A-Za-z]:)?[/\\]/.test(to)) {
          return writeJson(res, 400, { ok: false, code: 'bad-dir', reason: '要带上一个绝对路径 to（那个不是我的日记本）' })
        }
        const loaded = loadDiaryState({ logger: ctx.logger })
        const from = typeof loaded.config?.recovered?.from === 'string' ? loaded.config.recovered.from : ''
        const dirRejected = parsePathList([...(loaded.config.dirRejected ?? []), to])
        const next = mergeDocConfig(loaded.config, {}, {})
        next.dirRejected = dirRejected
        // 回到认回之前的位置：认回是启发式的，用户说"不是我那个"之后就该回到"找不到"的状态
        next.dir = from
        const text = patchConfigSection(loaded.docText, next)
        const write = writeDocCounted(loaded.docPath, text)
        if (!write.ok) {
          return writeJson(res, 200, { ok: false, code: 'write-failed', stage: 'doc', reason: write.reason })
        }
        // 整包快照：和 GET /diary 同一个函数出来的，前端直接 setState
        return writeJson(res, 200, { ok: true, value: diarySnapshot({ logger: ctx.logger }) })
      },
    },
    {
      // 只读诊断：排查「开关打开了却没效果」时先看这里。
      // 它回答一个问题：人设段到底有没有注册进这条会话的 systemPrompt。
      kind: 'exact',
      path: `${BRIDGE_PREFIX}/debug`,
      handler: async (req, res) => {
        if (!sameOrigin(req)) return writeJson(res, 403, { ok: false, code: BRIDGE_ERRORS.FORBIDDEN })
        let value
        try {
          value = typeof getDiagnostics === 'function' ? getDiagnostics() : { unavailable: true }
        } catch (error) {
          value = { error: String(error?.message ?? error) }
        }
        return writeJson(res, 200, { ok: true, value })
      },
    },
  ]

  // 同一批 handler 挂到**两个**前缀上：新的正式前缀 + 旧前缀兼容别名。
  // 旧页面（缓存着改名前的 client bundle）还在打 /api/dsh-ai-waifu/*，删掉它就等于
  // 「点了没反应」。route 对象逐份拷贝，避免两条注册共享同一个对象被宿主改坏。
  // 每条注册都必须包在 ctx.effect 里（插件契约硬要求，check:manifest / 测试都查）。
  for (const prefix of BRIDGE_PREFIXES) {
    for (const route of routes) {
      const path = prefix + route.path.slice(BRIDGE_PREFIX.length)
      ctx.effect(() => webServer.register({ ...route, path }), `dsh-pet-cuteness-plugin: bridge ${path}`)
    }
  }
}
