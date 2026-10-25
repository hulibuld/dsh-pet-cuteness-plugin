/**
 * 台词调度：洗牌袋 + 冷却 + 句式去重 + 触发预算。
 *
 * 四道防线分别解决四个不同的问题，缺一不可：
 *   1. **洗牌袋**：该桶 N 句打乱成队列逐句 pop，用完再洗 → N 次内绝不重复，
 *      而顺序又不是固定循环。（朴素 `lines[floor(rand*n)]` 会被用户抓到"隔两句就重复"）
 *   2. **冷却**：同一句 T 小时内不再出现。防"刚说完又抽到"。
 *   3. **句式去重**：每句带 shape 标签，同一次会话内不允许连续 N 次同 shape。
 *      → 这条比句库大小有用得多：用户感觉到的"重复"往往是**语气模式**重复，不是字面重复。
 *   4. **触发预算**：给"说话"这个动作本身加随机窗口（抄自 Sutera-Diffusus/dsh-whale-musume，
 *      MIT）。窗口内先通过的那条会把 nextAt 推后，同一次状态跳变里的第二条自然被挡住。
 *      → 解决交接文档指出的那个洞：idle 每周 5000 次触发，冷却形同虚设。
 *
 * 全部纯函数 + 显式注入 `now` / `rng`，可在 node:test 里确定性重放，无需浏览器。
 */

/**
 * 软冷却：同一句多久之内「尽量」不再出现。池子够用时严格生效。
 *
 * 从 6 小时降到 90 分钟，是**实测参数修正**：
 * 单桶只有 8–16 句，6 小时软冷却意味着「点八下这一桶就空了」，
 * 之后一整晚她只会重复最久没说的那几句或干脆沉默。
 * 用户对这一点的描述是「点八次就不理我了」——那不是「安静」，是「死了」。
 */
export const COOLDOWN_MS = 90 * 60 * 1000

/**
 * 硬地板：同一句绝对不许在这个间隔内重复。
 *
 * 从 90 秒降到 25 秒，同样是实测修正：
 * 90 秒 × 8 句 = 12 分钟的强沉默窗口，而用户戳她的间隔通常是 2–5 秒。
 * 25 秒 × 8 句仍然保证「一分钟内听不到同一句」，但不会让桶瞬间耗尽。
 *
 * **注意**：硬地板没被取消。它的语义是「宁可不说也不重复」，这一点不变；
 * 只是把窗口调到「人肉连续点击」能承受的量级。
 */
export const HARD_REPEAT_MS = 25 * 1000

/** 触发预算的两档（毫秒区间）。抄自 dsh-whale-musume 的 WORK_SPEECH_WINDOWS。 */
export const SPEECH_WINDOWS = Object.freeze({
  chatty: [15_000, 40_000],
  quiet: [90_000, 240_000],
})

/** 连续同 shape 的上限（超过就换一个 shape）。 */
export const MAX_SAME_SHAPE_RUN = 2

/**
 * 创建一次会话内的调度状态。**不要放进系统提示词、不要持久化到会话日志**——
 * 这是纯 UI 状态，跨会话重置是对的。
 *
 * @param {object} [options]
 * @param {() => number} [options.rng] 随机源（默认 Math.random；测试传固定值）
 */
export function createSpeechEngine({ rng = Math.random } = {}) {
  /** @type {Map<string, string[]>} 桶 key → 洗牌后的队列 */
  const bags = new Map()
  /** @type {Map<string, string>} 桶 key → 上一袋最后一句（跨袋避重） */
  const lastOfBag = new Map()
  /** @type {Map<string, number>} 句子 → 上次说它的时间（两级冷却与 LRU 都读这一张表） */
  const lastUsedAt = new Map()
  /** @type {string[]} 最近用过的 shape */
  const shapeRun = []
  /** @type {{mode: string, nextAt: number}} */
  const budget = { mode: 'chatty', nextAt: 0, lastNow: 0 }

  const bucketKey = (personaId, bucket) => `${personaId}::${bucket}`
  /** 冷却键：角色 + 句子文本（不含桶——跨桶共享冷却是有意的，见 pick() 第 ① 步）。 */
  const coolKey = (personaId, text) => `${personaId}::${text}`

  /** Fisher–Yates；用注入的 rng 保证可重放。 */
  function shuffle(list) {
    const out = list.slice()
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1))
      const t = out[i]
      out[i] = out[j]
      out[j] = t
    }
    return out
  }

  /**
   * 取一句台词。
   *
   * @param {object} input
   * @param {string} input.personaId
   * @param {string} input.bucket 桶名（click / thinking / night …）
   * @param {Array<{text:string, shape?:string, requires?:object}>} input.lines 该桶的句子
   * @param {number} input.now 当前时间（ms）
   * @param {{hour?:number}} [input.clock] 用于 `requires` 过滤的时间条件
   * @returns {string} 命中的句子；无可用句返回 ''
   */
  function pick({ personaId, bucket, lines, now, clock }) {
    const key = bucketKey(personaId, bucket)
    const eligible = filterEligible(lines, clock)
    if (eligible.length === 0) return ''

    // ① 两级冷却。
    //
    // 这一段的形状是测试逼出来的，值得写清楚为什么：
    //   - 单级"6 小时冷却 + 全冷却时随便挑一句" = 3 句的小桶每 3 次就会重复一次，
    //     也就是用户 1 分钟内听到同一句两遍。这正是"被发现是循环"的定义。
    //   - 所以拆成两级：软冷却（6h，能避开就避开）与硬地板（90s，**绝不允许**）。
    //     硬地板做不到时返回空字符串——**宁可这次不说话，也绝不重复**。
    //     桌宠安静一会儿没人会注意；说重了立刻出戏。
    // 冷却按「角色 + 句子」记账，**不按桶**。
    //
    // 这里被工程评审抓到过一次谎报：文档写"冷却表按 personaId::bucket 分桶（已实现）"，
    // 代码实际是按 line.text 全局存的。现在两层都处理了：
    //   - 键前缀带上 personaId（换模型后旧角色说过的句子不该压住新角色）；
    //   - 不按桶隔离，且这是**有意**的：同一句话横跨两个桶时（如"我饿了"同时在
    //     night 和 idle），按桶隔离会让它在一分钟内被说两遍，跨桶共享冷却才防得住。
    const stamp = (line) => lastUsedAt.get(coolKey(personaId, line.text)) ?? -Infinity
    const hardOk = eligible.filter((line) => stamp(line) + HARD_REPEAT_MS <= now)
    if (hardOk.length === 0) return '' // 全部仍在硬地板内 → 保持沉默

    const softOk = hardOk.filter((line) => stamp(line) + COOLDOWN_MS <= now)
    // 软冷却全部命中时，退回"过得了硬地板、且最久没说的"——保证重复间隔被拉到最大。
    const pool = softOk.length > 0 ? softOk : rankByLeastRecentlyUsed(hardOk, personaId)

    // ② 洗牌袋：袋子空了就重洗，并把上一袋最后一句挪到后面避免"袋尾接袋头"。
    //
    // ⚠️ 两个都是被评审抓出来的坑：
    //
    //   (a) 袋子存**句子 text**，不是句子对象。
    //       曾经存对象、再用 `pool.includes(candidate)` 判可用性——调用方每次
    //       `lines.map(t => ({text:t}))` 重建对象时引用全不相等，袋里每句都被判
    //       "不在池子里"，洗牌袋静默退化成随机，而测试还是绿的（测试传同一数组）。
    //
    //   (b) **袋子用「整桶」洗，不用「shape 过滤后的子集」洗。**
    //       原实现是 `shuffle(preferShape(pool))`，那会把"这一次要避开某 shape"
    //       固化成接下来 N 次的候选集：state 占 1055/1987，一旦连出两句，
    //       整袋都没 state，用户感觉到的不是"不重复"，是"她突然只会说括号旁白"。
    //       shape 约束应该作用在**抽出来的那一个**上，不该污染袋子。
    let queue = bags.get(key)
    if (!queue || queue.length === 0) {
      queue = shuffle(pool).map((line) => line.text)
      const lastText = lastOfBag.get(key)
      if (queue.length > 1 && queue[0] === lastText) {
        const t = queue[0]
        queue[0] = queue[1]
        queue[1] = t
      }
      bags.set(key, queue)
    }

    // ③ 抽句：从袋子里 pop，跳过不可用的（冷却/aspect 过滤）。
    //
    //    shape 约束在这里生效。实现要点是**最多试 queue.length 次**——
    //    早期写法是"把违规的塞回队尾再 continue"，那在小池子上会死循环：
    //    2 句同 shape 时，弹出→塞回→弹出→塞回，队列永远不空（真踩到了，
    //    测试直接挂住 60 秒）。所以改成有界扫描 + 收尾兜底。
    const available = new Set(pool.map((l) => l.text))
    const shapeOf = new Map(pool.map((l) => [l.text, l.shape ?? '']))
    let chosen = ''
    let deferred = ''
    let budgetTries = queue.length
    while (budgetTries > 0 && queue.length > 0) {
      budgetTries -= 1
      const candidate = queue.shift()
      if (!available.has(candidate)) continue
      if (wouldRepeatShape(shapeOf.get(candidate))) {
        // 记下第一条违规的，继续找；找不到就用它（宁可破 shape，不能哑）
        if (!deferred) deferred = candidate
        continue
      }
      chosen = candidate
      break
    }
    if (!chosen) chosen = deferred
    if (!chosen) {
      const fallback = pool.filter((l) => !wouldRepeatShape(l.shape ?? ''))
      const pickFrom = fallback.length > 0 ? fallback : pool
      chosen = pickFrom[Math.floor(rng() * pickFrom.length)]?.text ?? ''
    }
    if (!chosen) return ''

    // ④ 记账
    //
    // ⚠️ `lastOfBag` **只在从袋子里正常抽到时写**。
    // 原实现在兜底路径之后也无条件写，而那个值并不是袋尾——
    // 于是"重洗时把袋尾挪开"比较的是个假值，换袋瞬间仍会出现
    // 「上一袋第一句 = 这一袋第一句」。
    lastUsedAt.set(coolKey(personaId, chosen), now)
    lastOfBag.set(key, chosen)
    const shape = shapeOf.get(chosen) ?? ''
    if (shape) {
      shapeRun.push(shape)
      if (shapeRun.length > 8) shapeRun.shift()
    }
    return chosen
  }

  /**
   * 过滤 `requires` 条件（目前只支持 hour 区间）。
   *
   * ⚠️ 这里改过一次，因为原写法会让 `night` 桶在契约上就是死的：
   *   原实现是「没有 clock 就滤掉所有带 requires 的句子」。
   *   而 `night` 桶**整桶都带 requires**（只在 0–5 点出现），
   *   于是只要调用方忘了传 clock，eligible 直接变成空数组 → 静默返回空串，
   *   永远发现不了（正好撞上"不落日志不弹错"）。
   *
   * 现在的行为：没有 clock 时**保留**这些句子（当作"条件未知，先允许"）。
   * 代价是深夜台词可能在白天出现——比起"整桶永远不出现"，这个代价小得多，
   * 而且调用方一旦传了 clock 就自动恢复精确。
   */
  function filterEligible(lines, clock) {
    const list = Array.isArray(lines) ? lines : []
    const hour = clock?.hour
    if (typeof hour !== 'number') {
      return list
    }
    return list.filter((line) => {
      const req = line?.requires
      if (!req) return true
      if (typeof req.hourGte === 'number' && hour < req.hourGte) return false
      if (typeof req.hourLt === 'number' && hour >= req.hourLt) return false
      return true
    })
  }

  /**
   * 池子耗尽时的排序：最久没说的排前面。
   *
   * 为什么不用「随机重来」：随机重来有 1/N 概率立刻重复刚才那句，
   * 而"刚刚才说过又说一遍"是用户唯一真正会注意到的重复信号。
   * 从没说过（`lastUsedAt` 里没有）视为最久，排最前。
   */
  function rankByLeastRecentlyUsed(list, personaId) {
    return list.slice().sort((a, b) => {
      const ta = lastUsedAt.get(coolKey(personaId, a.text)) ?? -Infinity
      const tb = lastUsedAt.get(coolKey(personaId, b.text)) ?? -Infinity
      return ta - tb
    })
  }

  /**
   * 这一句会不会造成「连续 MAX_SAME_SHAPE_RUN+1 次同 shape」。
   *
   * 注意它是个**谓词**，不是过滤器——约束作用在抽出来的那一句上，
   * 不作用在袋子上（见 pick() 第 ②( b) 条）。
   */
  function wouldRepeatShape(shape) {
    if (!shape) return false
    if (shapeRun.length < MAX_SAME_SHAPE_RUN) return false
    const tail = shapeRun.slice(-MAX_SAME_SHAPE_RUN)
    return tail.every((s) => s === shape)
  }

  /**
   * 触发预算：这次允许**她自己**说话吗？允许则顺手把下次窗口推后。
   *
   * ⚠️ 这条只管「没有人要求她说话」的场合：思考中、长思考走神、闲置、深夜。
   * **用户主动点击不经过这里**——用户点她，是明确表示想听她说话，
   * 再被一个随机窗口拦住就是"我点你你为什么不理我"。
   *
   * 这个区分是一次设计返工：早期版本把预算套在所有触发上，
   * 结果是"每 3 秒戳一下、连戳 30 次，只有 5 次有反应"，
   * 而这正是用户会判定"装坏了"的时刻。预算的目的是**防止她自言自语刷屏**，
   * 不是**阻止用户点她**。
   *
   * @param {number} now
   * @param {'chatty'|'quiet'} [mode='chatty']
   * @returns {boolean}
   */
  function allowSpeak(now, mode = 'chatty') {
    const chosen = mode === 'quiet' ? 'quiet' : 'chatty'
    // 时钟回拨（系统睡眠唤醒 / NTP 校准）会让 now 变小，于是 nextAt 变成一个
    // "未来的某一刻"，最长可能把她的嘴封到 4 分钟后。检测到就重置。
    if (now < budget.lastNow) budget.nextAt = 0
    budget.lastNow = now

    // 切档立即生效：清掉上一档遗留的等待窗口，否则从安静切回话痨要干等几分钟。
    if (budget.mode !== chosen) {
      budget.mode = chosen
      budget.nextAt = 0
    }
    if (now < budget.nextAt) return false
    const [lo, hi] = SPEECH_WINDOWS[chosen]
    budget.nextAt = now + lo + Math.floor(rng() * (hi - lo))
    return true
  }

  /**
   * 撤销一次刚刚成功的「预算放行」。
   *
   * 为什么需要它：`allowSpeak()` 返回 true 时已经把 `nextAt` 推后了，
   * 但紧接着 `pick()` 可能因为**硬地板全命中**返回空串——这次"允许说话"就白烧了，
   * 接下来 15–240 秒她一律被拒。小桶（3 句）上这是常态：
   * 用户点一次不理，然后安静四分钟。
   *
   * 调用约定：只要 `pick()` 返回空串，就必须调 `rollbackSpeak()`。
   * 这是「宁可不说」这条设计能成立的前提——沉默不该有连锁代价。
   *
   * @param {number} now
   */
  function rollbackSpeak(now) {
    budget.nextAt = Math.min(budget.nextAt, now)
  }

  /**
   * 诊断：这次为什么没说？
   *
   * 存在理由很实际：用户点她没反应时，分不清「她在沉默（设计）」与「她坏了」。
   * 早期版本的答案是"都不报"——那等于让两种完全不同的情况长得一模一样，
   * 用户唯一能做的判断就是"卸了吧"。
   *
   * 现在 UI 可以在 hover / 长按 / 设置页里显示这个原因，
   * 让"沉默"变成一个**可解释**的状态，而不是一个黑箱。
   *
   * @param {object} input 与 pick 相同
   * @returns {{ ok: true } | { ok: false, reason: 'empty-bucket'|'all-cooling'|'budget', detail: string }}
   */
  function explain({ personaId, bucket, lines, now, clock }) {
    const eligible = filterEligible(lines, clock)
    if (eligible.length === 0) {
      return {
        ok: false,
        reason: 'empty-bucket',
        detail: `${personaId}/${bucket} 在当前条件下没有可用句子（可能全部 requires 未满足，或整个桶被关掉）`,
      }
    }
    const stampOf = (line) => lastUsedAt.get(coolKey(personaId, line.text)) ?? -Infinity
    const hardOk = eligible.filter((line) => stampOf(line) + HARD_REPEAT_MS <= now)
    if (hardOk.length === 0) {
      const soonest = Math.min(...eligible.map((line) => stampOf(line) + HARD_REPEAT_MS))
      return {
        ok: false,
        reason: 'all-cooling',
        detail: `这一桶 ${eligible.length} 句全在 ${HARD_REPEAT_MS / 1000} 秒硬地板内，最快 ${Math.max(0, Math.ceil((soonest - now) / 1000))} 秒后可用`,
      }
    }
    if (now < budget.nextAt) {
      return {
        ok: false,
        reason: 'budget',
        detail: `她自己说话的预算窗口还没到（${budget.mode} 档，还要 ${Math.ceil((budget.nextAt - now) / 1000)} 秒）`,
      }
    }
    return { ok: true }
  }

  /** 诊断用：账本大小（测试断言用，不要在产品代码里依赖）。 */
  function stats() {
    return { spokenCount: lastUsedAt.size, bagCount: bags.size, now: Date.now() }
  }

  return { pick, allowSpeak, rollbackSpeak, explain, stats }
}
