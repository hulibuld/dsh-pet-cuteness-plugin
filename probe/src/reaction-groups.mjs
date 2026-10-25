/**
 * 反应分组：让用户自己关掉不想看的触发。
 *
 * 出处：keleus/deepseek-pet（MIT）的 `REACTION_GROUPS` 设计——每个分组（idle/thinking/
 * working/speaking/success/waiting/error/meal）有若干可选动作，用户勾选后持久化。
 * 我们抄的是**设置模型**（分组 + 白名单 + 兜底至少留一个），不是它的具体动作清单。
 *
 * 为什么必须有这个：v2 设计里 12 类触发全部常开，用户无法只保留"点她才说话"。
 * 一条 `night` 台词在凌晨两点弹出来，第二次就想卸载了。
 *
 * 纯数据 + 纯函数，无宿主依赖。
 */

const option = (id, label) => Object.freeze({ id, label })
const group = (id, label, description, options, defaultEnabled = options.map((o) => o.id)) =>
  Object.freeze({
    id,
    label,
    description,
    options: Object.freeze(options),
    defaultEnabled: Object.freeze(defaultEnabled),
  })

/** 与 data/personas/*.json 的桶名一一对应。 */
export const REACTION_GROUPS = Object.freeze([
  group('click', '点击', '点一下她说句话。最高频，也最容易腻。', [
    option('click', '普通搭话'),
    option('clickRepeated', '连点（越点越烦）'),
    option('headpat', '长按摸头'),
  ]),
  group('work', '工作时', '她自己会动，不需要你操作。', [
    option('thinking', '思考中'),
    option('thinkingLong', '长时间思考（会走神）'),
    option('working', '工具调用中'),
    option('done', '回复完成'),
  ], ['thinking', 'thinkingLong', 'done']), // working 默认关：工具调用太频繁，容易刷屏
  group('idle', '闲置', '长时间没人和她说话。', [option('idle', '发呆'), option('idleLong', '打瞌睡')]),
  group('time', '时间感知', '深夜台词最容易被人截图传播，也最容易烦人。', [
    option('night', '深夜（0–5 点）'),
    option('reunion', '久别重逢'),
  ]),
  group('feedback', '情绪反馈', '报错、被夸、被戳烦了。', [
    option('error', '报错'),
    option('praise', '被夸'),
    option('angry', '被戳烦了'),
    option('drag', '被拖动'),
  ]),
])

const BY_ID = new Map(REACTION_GROUPS.map((g) => [g.id, g]))

/** 默认全开（除 work.working 已单独关掉）。 */
export function defaultReactionSettings() {
  return Object.freeze(Object.fromEntries(REACTION_GROUPS.map((g) => [g.id, g.defaultEnabled])))
}

/**
 * 归一化用户设置：踢掉不认识的值，**每组至少留一个**（全关等于静音，
 * 那时候用户应该用总开关，而不是让分组变空导致引擎取不到句子）。
 *
 * @param {Record<string, string[]>|null|undefined} value
 * @returns {Record<string, string[]>}
 */
export function normalizeReactionSettings(value) {
  const normalized = {}
  for (const g of REACTION_GROUPS) {
    const allowed = new Set(g.options.map((o) => o.id))
    const stored = Array.isArray(value?.[g.id]) ? value[g.id] : g.defaultEnabled
    const selected = new Set(stored.filter((id) => allowed.has(id)))
    const enabled = g.options.map((o) => o.id).filter((id) => selected.has(id))
    normalized[g.id] = Object.freeze(enabled.length > 0 ? enabled : [...g.defaultEnabled])
  }
  return Object.freeze(normalized)
}

/**
 * 这个桶当前是否允许说话。
 * @param {Record<string, string[]>} settings
 * @param {string} bucket
 */
export function isBucketEnabled(settings, bucket) {
  for (const g of REACTION_GROUPS) {
    if (g.options.some((o) => o.id === bucket)) {
      return (settings[g.id] ?? g.defaultEnabled).includes(bucket)
    }
  }
  return false // 未登记的桶一律不响，避免"新加的桶忘了登记就默认开"
}

export { BY_ID as GROUP_BY_ID }
