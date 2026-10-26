/**
 * 亲密度（affinity）的纯文本层：只吃字符串、不碰文件系统。
 *
 * 为什么单独一层：dsh-pet 把亲密度缓存在内存里，`flush()` 会拿内存快照整份覆盖
 * `~/.dsh/pet.json`。所以我们改文件的动作必须满足两条：
 *   ① 只动 `affinity.points` 一个数字，别的键一个都不许变（`names`/`skins`/`treats`/`display`
 *      都是用户的真实资产，冲掉一次就是事故）；
 *   ② 改完必须让宿主重新加载 pet 插件（`pluginManager.reload(['pet'])`），并回读核对——
 *      不核对的"成功"是假的，下一次 flush 就会把用户刚改的数盖回去。
 *
 * 这一层只负责「字符串进、字符串出」+ 校验 + 备份路径，副作用（读写盘、reload）留在 index.js，
 * 这样单测不需要临时目录、也不会误伤真实的 pet.json。
 */

/** dsh-pet 自己的上限（`@linxin666/dsh-pet` lib 里 `AFFINITY_MAX`）。超过它它会自己夹回去，我们提前夹。 */
export const AFFINITY_MAX = 999999999

/**
 * 把用户输入夹成合法点数。
 *
 * 为什么不直接 `Math.min(max, Math.max(0, n))`：`Number('')` 是 0、`Number([])` 也是 0，
 * 静默把「空输入」当成「归零」会真的把用户攒的点数清掉。所以非有限数一律判失败，让上层报错。
 *
 * @param {unknown} raw
 * @returns {{ok: true, points: number} | {ok: false, code: 'bad-points'}}
 */
export function clampPoints(raw) {
  if (typeof raw === 'boolean' || raw === null || raw === undefined) return { ok: false, code: 'bad-points' }
  if (typeof raw === 'string' && raw.trim() === '') return { ok: false, code: 'bad-points' }
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return { ok: false, code: 'bad-points' }
  // 小数也接受（界面上可能拖滑块），落地一律取整：pet 那边是整数计数。
  const rounded = Math.round(value)
  if (rounded < 0) return { ok: true, points: 0 }
  if (rounded > AFFINITY_MAX) return { ok: true, points: AFFINITY_MAX }
  return { ok: true, points: rounded }
}

/**
 * 从 pet.json 原文里读点数。读不到就回 null（调用方决定是报 no-pet 还是当 0）。
 * @param {string} text
 * @returns {{ok: true, points: number, json: object} | {ok: false, code: 'bad-json' | 'no-affinity'}}
 */
export function readPoints(text) {
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, code: 'bad-json' }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, code: 'bad-json' }
  const affinity = json.affinity
  if (!affinity || typeof affinity !== 'object') return { ok: false, code: 'no-affinity' }
  const points = Number(affinity.points)
  return { ok: true, points: Number.isFinite(points) ? points : 0, json }
}

/**
 * 只改 `affinity.points`，返回新原文。
 *
 * 刻意用 `JSON.stringify(json, null, 2)` 重排整份文件，而不是做字符串替换：
 * 字符串替换要处理「points 出现在别的上下文」的误伤，而重排的键顺序是插入序（JSON.parse
 * 会保留），数组与嵌套对象原样回来，代价只是缩进被规范化。可读性反而更好。
 *
 * @param {string} text 现有 pet.json 原文
 * @param {number} points 已经过 clampPoints 的整数
 * @returns {{ok: true, text: string, before: number} | {ok: false, code: string}}
 */
export function withPoints(text, points) {
  const read = readPoints(text)
  if (!read.ok) return read
  const before = read.points
  read.json.affinity.points = points
  return { ok: true, text: JSON.stringify(read.json, null, 2) + '\n', before }
}

/**
 * 小鱼干（treats）的上限。用户 2026-10-24 的要求（逐字）：「……可以加一个刷小鱼干的功能，
 * 最多给他刷到 999 个」。所以这个数字是**用户口径**定的，不是从挂件源码里推的。
 */
export const TREATS_MAX = 999

/**
 * 把用户输入夹成合法的小鱼干数量（0..TREATS_MAX 整数）。
 * 和 `clampPoints` 同样拒绝空串/布尔/null，避免「空输入变成归零」。
 *
 * @param {unknown} raw
 * @returns {{ok: true, treats: number} | {ok: false, code: 'bad-treats'}}
 */
export function clampTreats(raw, max = TREATS_MAX) {
  if (typeof raw === 'boolean' || raw === null || raw === undefined) return { ok: false, code: 'bad-treats' }
  if (typeof raw === 'string' && raw.trim() === '') return { ok: false, code: 'bad-treats' }
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return { ok: false, code: 'bad-treats' }
  const rounded = Math.round(value)
  if (rounded < 0) return { ok: true, treats: 0 }
  // 上限可被调用方收紧：挂件自己只允许囤 `treats.max` 个（默认 20），
  // 我们报 999 让它去填，只会被它夹回去——所以由调用方把真实上限传进来。
  const cap = Number.isFinite(max) && max >= 0 ? Math.floor(max) : TREATS_MAX
  if (rounded > cap) return { ok: true, treats: cap }
  return { ok: true, treats: rounded }
}

/**
 * 读 pet.json 里的小鱼干数量。
 *
 * 兼容两种形状：新的是 `treats: { treats: 2, lastTreatGrantAt, turnsAtLastTreatGrant }`，
 * 老/扁平的可能是 `treats: 2` 一个数字。读不出就当 0，不抛异常（界面要能显示）。
 *
 * @param {string} text
 * @returns {{ok: true, treats: number, json: object} | {ok: false, code: string}}
 */
export function readTreats(text) {
  let json
  try {
    json = JSON.parse(String(text ?? ''))
  } catch {
    return { ok: false, code: 'bad-json' }
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, code: 'bad-json' }
  const raw = json.treats
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? Number(raw.treats) : Number(raw)
  return { ok: true, treats: Number.isFinite(value) ? value : 0, json }
}

/**
 * 只改小鱼干数量，其余键一律原样保留（理由同 `withPoints`：整份 pet.json 是用户资产）。
 *
 * @param {string} text 现有 pet.json 原文
 * @param {number} treats 已过 clampTreats 的整数
 */
export function withTreats(text, treats) {
  const read = readTreats(text)
  if (!read.ok) return read
  const before = read.treats
  if (read.json.treats && typeof read.json.treats === 'object' && !Array.isArray(read.json.treats)) {
    read.json.treats.treats = treats
  } else {
    read.json.treats = treats
  }
  return { ok: true, text: JSON.stringify(read.json, null, 2) + '\n', before }
}

/**
 * 回读校验小鱼干是否真的落地（同 `verifyPoints`）。
 *
 * 口径差异：`verifyPoints` 对不上回 `mismatch`，这里回 `verify-failed`——
 * 用户 2026-10-24 点名要这个码（「不一致返回 {ok:false, code:'verify-failed'}」），
 * 界面拿它就能直接说「写进去了但回读对不上」。
 */
export function verifyTreats(text, expected) {
  const read = readTreats(text)
  if (!read.ok) return { ok: false, code: read.code }
  if (read.treats !== expected) return { ok: false, code: 'verify-failed', actual: read.treats }
  return { ok: true, treats: read.treats }
}

/** 除了 `treats` 之外其余键是否完全一致。 */
export function sameExceptTreats(before, after) {
  const clone = (json) => {
    if (!json || typeof json !== 'object') return json
    const copy = Array.isArray(json) ? json.slice() : { ...json }
    if (copy.treats && typeof copy.treats === 'object' && !Array.isArray(copy.treats)) {
      copy.treats = { ...copy.treats }
      delete copy.treats.treats
    } else {
      delete copy.treats
    }
    return copy
  }
  const a = JSON.stringify(clone(before))
  const b = JSON.stringify(clone(after))
  return a === b ? { ok: true } : { ok: false, keys: ['treats'] }
}

/**
 * 别名：和「affinity 三件套」同名风格的两个入口。
 *
 * 名字对不上是历史原因：亲和度那套是 `readPoints/withPoints`（域名在前），
 * 用户在 2026-10-24 的需求里点名要 `readTreatsFromPetJson/writeTreatsToPetJson`。
 * 两个名字都留着，指向同一份实现——不许多一份逻辑，否则迟早两套口径。
 */
export const readTreatsFromPetJson = readTreats

/** 见 `readTreatsFromPetJson` 的说明。`text` 是 pet.json 原文，`count` 已过 clampTreats。 */
export function writeTreatsToPetJson(text, count) {
  return withTreats(text, count)
}

/** 备份文件跟着原文件走：`pet.json` → `pet.json.bak`。 */
export function backupPathFor(file) {
  return file + '.bak'
}

/**
 * 校验「改完之后再读一次」的结果是否真的落地。
 * 上位调用：写完文件 → 重读 → 这里比对。不等就回滚，绝不假装成功。
 * @param {string} text 重读到的原文
 * @param {number} expected
 */
export function verifyPoints(text, expected) {
  const read = readPoints(text)
  if (!read.ok) return { ok: false, code: read.code }
  if (read.points !== expected) return { ok: false, code: 'mismatch', actual: read.points }
  return { ok: true, points: read.points }
}

/**
 * 除了 `affinity.points` 之外，其余键是否完全一致（递归比较，不看缩进）。
 * 单测与运行前自检都用它：一旦有人把「读-改-写」写成「读一部分、写一份新的」，
 * 这里会立刻红，而不是等用户发现自己的皮肤/名字被清空。
 *
 * @param {object} before
 * @param {object} after
 * @returns {{ok: true} | {ok: false, keys: string[]}}
 */
export function sameExceptPoints(before, after) {
  const clone = (json) => {
    if (!json || typeof json !== 'object') return json
    const copy = Array.isArray(json) ? json.slice() : { ...json }
    if (copy.affinity && typeof copy.affinity === 'object' && !Array.isArray(copy.affinity)) {
      copy.affinity = { ...copy.affinity }
      delete copy.affinity.points
    }
    return copy
  }
  const a = JSON.stringify(clone(before))
  const b = JSON.stringify(clone(after))
  if (a === b) return { ok: true }
  // 定位差异键，报错时能说清是哪一项被动了。
  const keys = []
  const left = before && typeof before === 'object' ? before : {}
  const right = after && typeof after === 'object' ? after : {}
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (key === 'affinity') continue
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) keys.push(key)
  }
  return { ok: false, keys }
}
