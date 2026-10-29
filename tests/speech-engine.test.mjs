import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpeechEngine, COOLDOWN_MS, HARD_REPEAT_MS, SPEECH_WINDOWS } from '../src/speech-engine.mjs'

/* 台词调度器的四道防线，每道都要有能失败的断言。
   用确定性 rng（递增序列）保证可重放。 */

/** 造一个可预期的 rng：按顺序吐预设值，用完循环。 */
function seq(values) {
  let i = 0
  return () => values[i++ % values.length]
}

const lines = (n) => Array.from({ length: n }, (_, i) => ({ text: `L${i}`, shape: 'state' }))

test('洗牌袋：N 句之内绝不重复', () => {
  const engine = createSpeechEngine({ rng: seq([0.1, 0.7, 0.3, 0.9, 0.5]) })
  const bucket = lines(8)
  const seen = []
  for (let i = 0; i < 8; i += 1) {
    seen.push(engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: i }))
  }
  assert.equal(new Set(seen).size, 8, `一轮之内出现重复：${seen.join(',')}`)
})

test('洗牌袋：一轮走完后重洗，且袋尾不接袋头', () => {
  const engine = createSpeechEngine({ rng: seq([0.2, 0.8, 0.4, 0.6]) })
  const bucket = lines(4)
  const first = []
  for (let i = 0; i < 4; i += 1) first.push(engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: i }))
  // 第 5 句是新一袋的第一句，不能和上一袋最后一句相同
  const fifth = engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: 100 })
  assert.notEqual(fifth, first[first.length - 1], '出现了袋尾接袋头')
})

test('硬地板：同一句 90 秒内绝不重复；池子耗尽时宁可沉默', () => {
  const engine = createSpeechEngine({ rng: seq([0.3, 0.6, 0.9, 0.2, 0.5, 0.8]) })
  const bucket = lines(3)
  const spoken = []
  // 每 10 秒问一次，共 5 秒 × 12 = 120 秒；3 句池子 + 90 秒硬地板 → 前几句会说，之后沉默
  for (let i = 0; i <= 12; i += 1) {
    const line = engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: i * 10_000 })
    if (line) spoken.push({ line, at: i * 10_000 })
  }
  // 断言一：任何同一句的两次出现，间隔必须 ≥ 硬地板
  for (const a of spoken) {
    for (const b of spoken) {
      if (a === b || a.line !== b.line) continue
      assert.ok(
        Math.abs(b.at - a.at) >= HARD_REPEAT_MS,
        `「${a.line}」在 ${Math.abs(b.at - a.at) / 1000}s 内重复，硬地板是 ${HARD_REPEAT_MS / 1000}s`,
      )
    }
  }
  // 断言二：3 句全说过之后，硬地板内应当返回空串（沉默），而不是硬凑一句
  const silentTries = []
  for (let i = 0; i < 3; i += 1) {
    silentTries.push(engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: 85_000 + i }))
  }
  assert.ok(silentTries.includes(''), '池子耗尽且全在硬地板内时应返回空串')
})

test('冷却：过了 6 小时可以再次出现', () => {
  const engine = createSpeechEngine({ rng: () => 0 })
  const bucket = [{ text: 'only', shape: 'state' }]
  assert.equal(engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: 0 }), 'only')
  // 硬地板之内：沉默
  assert.equal(engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: 1000 }), '')
  // 过了硬地板但未过软冷却：允许（唯一一句，只能重复）
  assert.equal(engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: HARD_REPEAT_MS }), 'only')
  // 过了软冷却：正常
  assert.equal(engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: COOLDOWN_MS + 1 }), 'only')
})

test('软冷却：桶够大时 6 小时内不重复（硬地板不生效的场景）', () => {
  const engine = createSpeechEngine({ rng: () => 0.4 })
  const bucket = lines(8)
  const seen = new Set()
  for (let i = 0; i < 8; i += 1) {
    const line = engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: i * 60_000 })
    assert.ok(line, `第 ${i + 1} 次取句不该为空`)
    assert.ok(!seen.has(line), `6 小时软冷却内重复抽到 ${line}`)
    seen.add(line)
  }
})

test('句式去重：连续 2 次同 shape 后，优先换 shape', () => {
  const engine = createSpeechEngine({ rng: () => 0 })
  const bucket = [
    { text: 'a', shape: 'question' },
    { text: 'b', shape: 'question' },
    { text: 'c', shape: 'question' },
    { text: 'd', shape: 'exclaim' },
  ]
  const out = []
  for (let i = 0; i < 4; i += 1) {
    out.push(engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: i * 10_000_000 }))
  }
  // 前两句可能是 question，但第三句必须是 exclaim（否则连续三次同 shape）
  const third = bucket.find((l) => l.text === out[2])
  assert.equal(third?.shape, 'exclaim', `第三句仍是 ${third?.shape}，未换句式`)
})

test('回归：无时钟信息时保留条件句（否则 night 整桶变成死代码）', () => {
  // 原实现是「没有 clock 就滤掉所有带 requires 的句子」，
  // 而 night 桶整桶都带 requires → 调用方忘传 clock 就永远不出话，且静默。
  const engine = createSpeechEngine({ rng: () => 0 })
  const bucket = [{ text: 'night', shape: 'state', requires: { hourGte: 0, hourLt: 5 } }]
  const out = engine.pick({ personaId: 'p', bucket: 'night', lines: bucket, now: 0 })
  assert.equal(out, 'night', '没时钟时不该把整桶判死')
})

test('requires：有时钟信息时按条件过滤', () => {
  const engine = createSpeechEngine({ rng: () => 0 })
  const bucket = [
    { text: 'day', shape: 'state' },
    { text: 'night', shape: 'state', requires: { hourGte: 0, hourLt: 5 } },
  ]
  const night = engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: 0, clock: { hour: 2 } })
  assert.equal(night, 'night')
})

test('触发预算：窗口内第二次调用被拒', () => {
  const engine = createSpeechEngine({ rng: () => 0 }) // 0 → 取窗口下限
  assert.equal(engine.allowSpeak(0), true)
  assert.equal(engine.allowSpeak(1), false, `窗口 ${SPEECH_WINDOWS.chatty} 内不该放行`)
  assert.equal(engine.allowSpeak(SPEECH_WINDOWS.chatty[0]), true, '到下限后应放行')
})

test('触发预算：切档立即生效（不留上一档的等待窗口）', () => {
  const engine = createSpeechEngine({ rng: () => 0.5 })
  assert.equal(engine.allowSpeak(0, 'quiet'), true)
  // 安静档窗口 90-240s；立刻切回话痨档不应被拦
  assert.equal(engine.allowSpeak(1, 'chatty'), true, '切档后应立刻可用，不该干等')
})

test('空桶返回空串，不抛错', () => {
  const engine = createSpeechEngine({ rng: () => 0 })
  assert.equal(engine.pick({ personaId: 'p', bucket: 'click', lines: [], now: 0 }), '')
  assert.equal(engine.pick({ personaId: 'p', bucket: 'click', lines: undefined, now: 0 }), '')
})

test('不同角色互不干扰袋子', () => {
  const engine = createSpeechEngine({ rng: seq([0.1, 0.5, 0.9]) })
  const bucket = lines(3)
  const a = engine.pick({ personaId: 'deepseek', bucket: 'click', lines: bucket, now: 0 })
  const b = engine.pick({ personaId: 'claude', bucket: 'click', lines: bucket, now: 0 })
  // 各自独立袋子：两次都应当拿到某句（而不是因为共享状态取不到）
  assert.ok(a && b)
})

test('stats：账本会增长（诊断接口可用）', () => {
  const engine = createSpeechEngine({ rng: () => 0 })
  engine.pick({ personaId: 'p', bucket: 'click', lines: lines(4), now: 0 })
  assert.equal(engine.stats().spokenCount, 1)
})

test('回归：调用方每次重建 lines 数组时，洗牌袋仍然生效', () => {
  // 这是真踩到的 bug：袋子曾存「句子对象」并用 `pool.includes(obj)` 判可用性。
  // 客户端每次点击都 `lines.map(t => ({text:t}))` 重新造对象，引用全不相等，
  // 于是袋里每一句都被判为「不在池子里」，洗牌袋静默退化成随机。
  const texts = ['A', 'B', 'C', 'D']
  const rebuild = () => texts.map((t) => ({ text: t, shape: 'state' }))
  const engine = createSpeechEngine({ rng: seq([0.13, 0.71, 0.37, 0.92, 0.55, 0.08]) })

  const out = []
  for (let i = 0; i < 4; i += 1) {
    out.push(engine.pick({ personaId: 'p', bucket: 'click', lines: rebuild(), now: i * 1e6 }))
  }
  assert.equal(new Set(out).size, 4, `一轮之内出现重复：${out.join(',')}（洗牌袋失效）`)
})

test('回归：池子里有已冷却的句子时，袋子不会卡住', () => {
  const texts = ['A', 'B', 'C']
  const rebuild = () => texts.map((t) => ({ text: t, shape: 'state' }))
  const engine = createSpeechEngine({ rng: () => 0.4 })
  // 连取 3 次，每次都重建对象；不应返回空（池子足够大、都在硬地板之外）
  const out = []
  for (let i = 0; i < 3; i += 1) {
    out.push(engine.pick({ personaId: 'p', bucket: 'click', lines: rebuild(), now: i * 1e6 }))
  }
  assert.ok(out.every(Boolean), `有取空的情况：${JSON.stringify(out)}`)
  assert.equal(new Set(out).size, 3)
})

test('回归：用户主动点击不受触发预算约束（预算只防她自己刷屏）', () => {
  // 真实场景：用户每 3 秒戳一下，连戳 30 次。
  // 早期版本把 allowSpeak 套在点击上，30 次里只有 5 次有反应 —— 用户会判定"装坏了"。
  // 现在点击路径不调 allowSpeak，只要池子还过得去就该有回应。
  const texts = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
  const engine = createSpeechEngine()
  let spoke = 0
  for (let i = 0; i < 30; i += 1) {
    const now = i * 3000
    const line = engine.pick({
      personaId: 'p',
      bucket: 'click',
      lines: texts.map((t) => ({ text: t, shape: 'state' })),
      now,
    })
    if (line) spoke += 1
  }
  assert.ok(spoke >= 25, `30 次点击只说了 ${spoke} 次，太像装坏了`)
})

test('两级窗口的取值必须容得下「连点八下」', () => {
  // 单桶 8 句是已知最小值。若 硬地板 × 8 > 2 分钟，用户连点八下后就会陷入长沉默。
  assert.ok(HARD_REPEAT_MS * 8 <= 4 * 60 * 1000, `硬地板 ${HARD_REPEAT_MS}ms × 8 句过长`)
  // 软冷却要短于「一次使用时长」，否则点完一轮这一桶整晚都不再出现。
  assert.ok(COOLDOWN_MS <= 3 * 60 * 60 * 1000, `软冷却 ${COOLDOWN_MS}ms 过长，会导致桶被点空`)
})

test('explain：空桶能说清原因（不是"她坏了"）', () => {
  const engine = createSpeechEngine({ rng: () => 0 })
  const why = engine.explain({ personaId: 'p', bucket: 'click', lines: [], now: 0 })
  assert.equal(why.ok, false)
  assert.equal(why.reason, 'empty-bucket')
  assert.match(why.detail, /没有可用句子/)
})

test('explain：全在硬地板内时给出"还要等几秒"', () => {
  const engine = createSpeechEngine({ rng: () => 0 })
  const lines = [{ text: 'only', shape: 'state' }]
  engine.pick({ personaId: 'p', bucket: 'click', lines, now: 0 })
  const why = engine.explain({ personaId: 'p', bucket: 'click', lines, now: 5000 })
  assert.equal(why.ok, false)
  assert.equal(why.reason, 'all-cooling')
  assert.match(why.detail, /还要 \d+ 秒|最快 \d+ 秒/)
})

test('explain：预算窗口未到时说明是哪一档', () => {
  const engine = createSpeechEngine({ rng: () => 0.5 })
  engine.allowSpeak(0, 'quiet') // 把 quiet 档窗口推后
  const why = engine.explain({
    personaId: 'p',
    bucket: 'idle',
    lines: [{ text: 'x', shape: 'state' }],
    now: 1,
  })
  assert.equal(why.ok, false)
  assert.equal(why.reason, 'budget')
  assert.match(why.detail, /quiet/)
})

test('explain：正常情况返回 ok', () => {
  const engine = createSpeechEngine({ rng: () => 0 })
  const why = engine.explain({
    personaId: 'p',
    bucket: 'click',
    lines: [{ text: 'x', shape: 'state' }],
    now: 0,
  })
  assert.equal(why.ok, true)
})

test('回归：冷却按「角色+句子」记账，换角色不互相压住', () => {
  // 工程评审抓到过一次谎报：文档写「按 personaId::bucket 分桶（已实现）」，
  // 代码实际是按 line.text 全局存的。修完之后：
  //   - 带 personaId → 换模型后旧角色说过的话不压新角色；
  //   - 不带 bucket → 跨桶共享冷却（同一句在 night 和 idle 都有时不会被连说两遍）。
  const bucket = [{ text: '同一句话', shape: 'state' }]
  const engine = createSpeechEngine({ rng: () => 0 })
  assert.equal(engine.pick({ personaId: 'deepseek', bucket: 'click', lines: bucket, now: 0 }), '同一句话')
  // 同角色的另一个桶：应当被冷却挡住（跨桶共享）
  assert.equal(engine.pick({ personaId: 'deepseek', bucket: 'idle', lines: bucket, now: 1000 }), '')
  // 另一个角色：不该被压住
  assert.equal(engine.pick({ personaId: 'claude', bucket: 'click', lines: bucket, now: 1000 }), '同一句话')
})

test('回归：explain 与 pick 用的是同一套冷却键', () => {
  const bucket = [{ text: 'x', shape: 'state' }]
  const engine = createSpeechEngine({ rng: () => 0 })
  engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: 0 })
  const why = engine.explain({ personaId: 'p', bucket: 'idle', lines: bucket, now: 1000 })
  assert.equal(why.reason, 'all-cooling', 'explain 应看到 pick 写下的冷却')
})

test('回归：沉默一次不该连坐后面的预算（rollback）', () => {
  const engine = createSpeechEngine({ rng: () => 0 }) // rng=0 → 窗口取下限 15s
  const bucket = [{ text: 'only', shape: 'state' }] // 1 句桶，说过就进硬地板

  // t=0：预算放行、说出唯一一句，硬地板到 25000，预算推到 15000
  assert.equal(engine.allowSpeak(0), true)
  assert.equal(engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: 0 }), 'only')

  // t=15000：预算放行，但硬地板还没过 → 说不出话。这就是"白烧"
  assert.equal(engine.allowSpeak(15000), true)
  assert.equal(engine.pick({ personaId: 'p', bucket: 'click', lines: bucket, now: 15000 }), '')
  engine.rollbackSpeak(15000)

  // 硬地板一过（25000），她应该能立刻说话。
  // 不 rollback 的话 nextAt 已经是 30000，这里会被拒。
  assert.equal(engine.allowSpeak(25000), true, '沉默不该把预算烧掉')
})

test('回归：时钟回拨不会把她永久静音', () => {
  const engine = createSpeechEngine({ rng: () => 0.5 })
  assert.equal(engine.allowSpeak(1_000_000), true)
  // 系统睡眠唤醒，now 变小
  assert.equal(engine.allowSpeak(500), true, '时钟回拨后应重置而不是封到未来')
})

test('回归：shape 延期不能死循环（2 句同 shape 的池子）', () => {
  // 早期实现"把违规的塞回队尾再 continue"在小池子上会死循环：
  // 弹出→塞回→弹出→塞回，队列永远不空。测试直接挂住 60 秒才发现。
  const lines = [
    { text: 'A', shape: 'state' },
    { text: 'B', shape: 'state' },
  ]
  const engine = createSpeechEngine({ rng: () => 0.5 })
  const t0 = Date.now()
  for (let i = 0; i < 5; i += 1) {
    const out = engine.pick({ personaId: 'p', bucket: 'click', lines, now: i * 1e6 })
    assert.ok(out, `第 ${i} 次取句为空`)
  }
  assert.ok(Date.now() - t0 < 1000, '取句耗时异常，疑似死循环')
})

test('回归：shape 过滤不能污染袋子（否则她会"只会说括号旁白"）', () => {
  // 原实现是 shuffle(preferShape(pool))，会把"这次避开 state"
  // 固化成接下来一整袋的候选集。state 占 1055/1987，连出两句就会触发。
  const lines = [
    { text: 's1', shape: 'state' },
    { text: 's2', shape: 'state' },
    { text: 's3', shape: 'state' },
    { text: 'q1', shape: 'question' },
  ]
  const engine = createSpeechEngine({ rng: () => 0.4 })
  const seen = []
  for (let i = 0; i < 8; i += 1) {
    seen.push(engine.pick({ personaId: 'p', bucket: 'click', lines, now: i * 1e7 }))
  }
  // 八次里必须还包含 state 句（若袋子被 subject 污染，会连续只出非 state）
  const stateCount = seen.filter((t) => t && t.startsWith('s')).length
  assert.ok(stateCount >= 2, `state 句只出现 ${stateCount} 次，袋子被 shape 过滤污染了`)
})
