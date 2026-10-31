import assert from 'node:assert/strict'
import test from 'node:test'

const mod = await import('../src/diary-source.mjs')

/** 造一条 user/message 事件 */
function userAt(time, text) {
  return { type: 'user/message', time, data: { message: { role: 'user', content: [{ type: 'text', text }] } } }
}

/** 造一条 assistant/message 事件，可带 usage 与模型 */
function assistantAt(time, text, { provider = 'raccoon', model = 'sn-deepseek-v4-1-flash-1017', outputTokens = 100 } = {}) {
  const event = {
    type: 'assistant/message',
    time,
    data: {
      message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider, model } },
    },
  }
  if (outputTokens !== null) event.data.usage = { inputTokens: 1000, outputTokens }
  return event
}

/** 一条绝不该进日记的事件 */
function toolResultAt(time, text) {
  return { type: 'tool/result', time, data: { message: { role: 'tool', content: [{ type: 'text', text }] } } }
}

const DAY = mod.localDayBounds('2026-10-23')
const at = (hour, minute = 0) => new Date(2026, 9, 23, hour, minute, 0, 0).getTime()
const logical = (hour, minute = 0, day = 24) => mod.logicalDayFor(new Date(2026, 9, day, hour, minute, 0, 0))

test('日界 21:00：窗口是「前一天 21:00」到「当天 21:00」，标签是本地日期', () => {
  assert.equal(mod.DAY_ROLLOVER_HOUR, 21, '切日时间只许有一个真源')
  assert.equal(DAY.label, '2026-10-23')
  assert.equal(new Date(DAY.start).getHours(), 21)
  assert.equal(new Date(DAY.start).getDate(), 22)
  assert.equal(new Date(DAY.end).getHours(), 21)
  assert.equal(new Date(DAY.end).getDate(), 23)
  assert.equal(DAY.end - DAY.start, 24 * 60 * 60 * 1000)
  // 窗口外的最后一毫秒 / 第一毫秒
  assert.ok(DAY.start - 1 < DAY.start)
})

test('21:00 切日：20:59 算当天，21:00 整算次日，23:59 也算次日', () => {
  assert.equal(logical(20, 59), '2026-10-24', '20:59 还没过界，属于当天')
  assert.equal(logical(21, 0), '2026-10-25', '21:00 整已经过界，属于次日')
  assert.equal(logical(23, 59), '2026-10-25', '23:59 属于次日')
  assert.equal(logical(20, 59, 25), '2026-10-25', '次日 20:59 仍然属于次日')
  assert.equal(logical(21, 0, 25), '2026-10-26')
  // 跨日、跨月的边界也要跟着走
  assert.equal(mod.logicalDayFor(new Date(2026, 9, 31, 21, 0, 0)), '2026-11-01')
})

test('localDayBounds：标签 2026-10-25 的窗口从 10-24 21:00 开始', () => {
  const bounds = mod.localDayBounds('2026-10-25')
  assert.equal(bounds.label, '2026-10-25')
  assert.equal(bounds.start, new Date(2026, 9, 24, 21, 0, 0, 0).getTime())
  assert.equal(bounds.end, new Date(2026, 9, 25, 21, 0, 0, 0).getTime())
})

test('pickMessages 按新窗口切：20:59 进当天，21:00 进次日', () => {
  const events = [
    userAt(new Date(2026, 9, 24, 20, 59, 0, 0).getTime(), '还早'),
    userAt(new Date(2026, 9, 24, 21, 0, 0, 0).getTime(), '过界了'),
    userAt(new Date(2026, 9, 25, 20, 59, 0, 0).getTime(), '第二天傍晚'),
    userAt(new Date(2026, 9, 25, 21, 0, 0, 0).getTime(), '又过界了'),
  ]
  assert.deepEqual(mod.pickMessages(events, mod.localDayBounds('2026-10-25')).map((m) => m.text), ['过界了', '第二天傍晚'])
  assert.deepEqual(mod.pickMessages(events, mod.localDayBounds('2026-10-24')).map((m) => m.text), ['还早'])
})

test('只收 user/assistant，tool/result 一律不进摘要', () => {
  const events = [
    userAt(at(9, 0), '帮我看看这个报错'),
    assistantAt(at(9, 1), '嗯，我想想'),
    toolResultAt(at(9, 2), '整个文件内容都在这里，几万字'),
  ]
  const messages = mod.pickMessages(events, DAY)
  assert.equal(messages.length, 2)
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant'])
  assert.ok(!messages.some((m) => m.text.includes('几万字')))
})

test('时间窗是左闭右开：昨天的不算，明天的不算', () => {
  const events = [
    assistantAt(DAY.start - 1, '昨天的'),
    userAt(DAY.start, '今天零点整'),
    userAt(DAY.end - 1, '今天最后一毫秒'),
    userAt(DAY.end, '明天零点整'),
  ]
  const texts = mod.pickMessages(events, DAY).map((m) => m.text)
  assert.deepEqual(texts, ['今天零点整', '今天最后一毫秒'])
})

test('没有 time 的事件被丢掉（宁可漏一条，也不要算错一天）', () => {
  const events = [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: '没有时间戳' }] } } }]
  assert.equal(mod.pickMessages(events, DAY).length, 0)
})

test('单条消息超长会被截断，且截断处有省略号', () => {
  const long = '啊'.repeat(1000)
  const [message] = mod.pickMessages([userAt(at(10, 0), long)], DAY)
  assert.ok(message.text.length <= 401)
  assert.ok(message.text.endsWith('…'))
})

test('assistant 带上 provider/model，user 不带', () => {
  const messages = mod.pickMessages(
    [userAt(at(10, 0), '问'), assistantAt(at(10, 1), '答', { provider: 'buddy', model: 'hy3' })],
    DAY,
  )
  assert.equal(messages[0].model, undefined)
  assert.equal(messages[1].model, 'buddy/hy3')
})

test('用量汇总按 provider+model 分组，只加 outputTokens', () => {
  const events = [
    assistantAt(at(10, 0), 'a', { model: 'm1', outputTokens: 100 }),
    assistantAt(at(10, 1), 'b', { model: 'm1', outputTokens: 250 }),
    assistantAt(at(10, 2), 'c', { provider: 'buddy', model: 'hy3', outputTokens: 999 }),
  ]
  const usage = mod.usageOfSession(events, DAY)
  const m1 = usage.find((u) => u.model === 'm1')
  assert.equal(m1.outputTokens, 350)
  assert.equal(m1.messages, 2)
  // reasoningTokens 不重复计：造的数据里 input 是 1000，绝不能混进 output
  assert.ok(!usage.some((u) => u.outputTokens === 1350))
})

test('没有 usage 的消息不计入用量（但正文照样进摘要）', () => {
  const events = [assistantAt(at(10, 0), '有正文没用量', { outputTokens: null })]
  assert.equal(mod.usageOfSession(events, DAY).length, 0)
  assert.equal(mod.pickMessages(events, DAY).length, 1)
})

test('跨会话合并：同一个模型在两个会话里的 token 要加起来', () => {
  const a = mod.usageOfSession([assistantAt(at(10, 0), 'x', { outputTokens: 100 })], DAY)
  const b = mod.usageOfSession([assistantAt(at(11, 0), 'y', { outputTokens: 400 })], DAY)
  const merged = mod.mergeUsage([a, b])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].outputTokens, 500)
})

test('挑执笔：只认 DeepSeek，别的模型 token 再多也不选', () => {
  const usage = mod.mergeUsage([
    mod.usageOfSession(
      [
        assistantAt(at(10, 0), 'a', { provider: 'buddy', model: 'hy3', outputTokens: 99999 }),
        assistantAt(at(10, 1), 'b', { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash-1017', outputTokens: 1000 }),
      ],
      DAY,
    ),
  ])
  assert.equal(usage[0].model, 'hy3', '按 token 排，hy3 在最前')
  const diarist = mod.pickDiarist(usage)
  assert.equal(diarist.model, 'sn-deepseek-v4-1-flash-1017', '但执笔必须是 DeepSeek')
})

test('挑执笔：没有任何 DeepSeek 时返回 null，不偷偷换人', () => {
  const usage = mod.mergeUsage([mod.usageOfSession([assistantAt(at(10, 0), 'a', { provider: 'buddy', model: 'hy3' })], DAY)])
  assert.equal(mod.pickDiarist(usage), null)
})

test('摘要超量时按小时分桶取样：早上和晚上的事都得留下', () => {
  // 20 条横跨 9:00、14:00、20:00 三个时段，上限只给 6 条。
  const messages = []
  for (let i = 0; i < 20; i += 1) {
    const hour = i < 7 ? 9 : i < 14 ? 14 : 20
    messages.push({ role: 'user', at: at(hour, i % 7), text: `第${i}句-${hour}点` })
  }
  const { text, kept, dropped } = mod.buildDigest([{ sessionLabel: 'abcd1234', messages }], { maxMessages: 6 })
  assert.ok(kept <= 6, `不能超过上限，实际 ${kept}`)
  assert.equal(kept + dropped, 20)
  // 三个小时桶都要有代表：以前的"从最新往前塞"会把 9 点整段丢掉。
  assert.ok(text.includes('9点'), '早上那段不能被整段丢掉')
  assert.ok(text.includes('20点'), '晚上那段也要在')
  // 读起来仍然是时间正序
  assert.ok(text.indexOf('9点') < text.indexOf('20点'))
})

test('摘要是人读的格式：带时刻、带说话人', () => {
  const { text } = mod.buildDigest(
    [
      {
        sessionLabel: 'abcd1234',
        messages: [
          { role: 'user', at: at(14, 32), text: '挂件还是没显示' },
          { role: 'assistant', at: at(14, 33), text: '嗯……我看一下', model: 'raccoon/m1' },
        ],
      },
    ],
    {},
  )
  // 称呼改成她认得的「主人／我」，而且不夹模型名：
  // 一串 provider/model 一进日记就会被原样抄进正文（2026-10-23 实测）。
  assert.ok(text.includes('[14:32] 主人：挂件还是没显示'))
  assert.ok(text.includes('[14:33] 我：嗯……我看一下'))
  assert.ok(!text.includes('raccoon/m1'), '模型名不该出现在她读的记录里')
})

test('prompt：第一人称、她的语气、不许编、不许自我指认', () => {
  const prompt = mod.buildDiaryPrompt({ dateLabel: '2026-10-23', digest: '- 记录', diaristKey: 'raccoon/m1', personaName: '深度求索娘' })
  assert.ok(prompt.includes('2026-10-23'))
  assert.ok(prompt.includes('第一人称'))
  assert.ok(prompt.includes('不要编'))
  assert.ok(prompt.includes('作为 AI'))
  assert.ok(prompt.includes('不要标题'))
  // 2026-10-23 返工：日记要有小女孩的口气，不许写成工作汇报。
  assert.ok(prompt.includes('八九岁'))
  // 2026-10-30 返工后："搬进新房子"只许出现在反例里，不能再教模型打这种比方。
  assert.ok(prompt.includes('它搬进了新房子'), '反例留着当靶子')
  assert.ok(!prompt.includes('装插件是"搬进新房子"'), '不再把比喻当写作要求')
  assert.ok(prompt.includes('主人'))
  assert.ok(prompt.includes('需要你决定'), '要明确禁止把待办塞进日记')
  assert.ok(prompt.includes('不要总结'))
  // 2026-10-23 真机 timeout 的守门：子代理默认带全套工具，不明确禁就会去翻文件。
  assert.ok(prompt.includes('不要再调用任何工具'), '必须明说不要调工具，否则执笔会去翻文件而不是写日记')
  assert.ok(prompt.includes('不要读文件'))
  assert.ok(prompt.includes('- 记录'))
})

/* 用户第二次返工（逐字）：「'今天还有人问我是谁……我照例先抗议半句，然后还是应了。'
   这语气不像小女孩在写日记，像有个成年人在模仿鲁迅的文风。」
   这条测试守的就是那几句：反讽、自我概括、一句一段，都必须被明确禁掉，
   而且用户点名的那句要作为反例出现在 prompt 里。 */
test('prompt：不许"成年人模仿鲁迅"那套（反讽/自我概括/一句一段）', () => {
  const prompt = mod.buildDiaryPrompt({ dateLabel: '2026-10-23', digest: '- 记录', personaName: '深度求索娘' })
  assert.ok(prompt.includes('模仿鲁迅'), '用户点名的那种写法要作为反例写进 prompt')
  assert.ok(prompt.includes('照例先抗议半句'), '反例里要出现用户抄的那句原话')
  assert.ok(prompt.includes('反讽'), '要明确禁止反讽')
  assert.ok(prompt.includes('留白'))
  assert.ok(prompt.includes('一句一段'), '要明确禁止短句成段往下砸')
  assert.ok(prompt.includes('下概括'), '要明确禁止对自己下判断下概括')
  // 正向：要连着说、可以重复、可以改口、情绪直说、口头语
  assert.ok(prompt.includes('改口'))
  assert.ok(prompt.includes('情绪直接说出来'))
  assert.ok(prompt.includes('才不是'))
  assert.ok(prompt.includes('大白饭'))
  assert.ok(prompt.includes('800 到 1200'), '字数要有下限，写太短通常是没讲清')
  assert.ok(prompt.includes('写短了通常不是我没事可写'), '要把"写短=没讲清"这层因果说给模型')
})

/* 用户第三次返工（2026-10-30 逐字）：「日记感觉越写越短，而且乱用拟人。很多东西明明
   可以直接说他偏偏要用修辞拟人，到最后使人误会」。
   守两件事：①不再教它"装插件＝搬进新房子"这类比喻；②明确禁掉把工具当人（会害怕/会等我）。 */
test('prompt：拟人只许用在我自己的情绪上，记述事实必须直说', () => {
  const prompt = mod.buildDiaryPrompt({ dateLabel: '2026-10-30', digest: '- 记录', personaName: '深度求索娘' })
  assert.ok(!prompt.includes('搬进新房子'), '不许再把装插件教成"搬进新房子"——用户说这会让人误会')
  assert.ok(!prompt.includes('比喻只用小孩会用的'), '比喻条款整条删掉，别再鼓励打比方')
  assert.ok(prompt.includes('不把东西当人'), '要明确禁止把文件/插件/气泡当人')
  assert.ok(prompt.includes('躲起来'), '把"东西不会躲起来"具体写出来，模型才照做')
  assert.ok(prompt.includes('它搬进了新房子'), '反例要留在 prompt 里当靶子')
  assert.ok(prompt.includes('可是打开是空的'), '正例要给"直说"的写法')
})

test('prompt：没有摘要时也要说清"今天没有记录"', () => {
  const prompt = mod.buildDiaryPrompt({ dateLabel: '2026-10-23', digest: '' })
  assert.ok(prompt.includes('今天没有任何记录'))
})

test('sessionLabelOf：去掉 session- 前缀，只留前 8 位', () => {
  assert.equal(mod.sessionLabelOf('session-99a53c6a-6140-4249'), '99a53c6a')
  assert.equal(mod.sessionLabelOf('855b106e-bb85'), '855b106e')
})

test('collectDay：整条链路（注入假 IO，不碰真磁盘）', () => {
  const fakeFiles = {
    '/root/session-aaaa1111/session.v4.jsonl.zstd': [
      userAt(at(9, 0), '挂件还是没显示'),
      assistantAt(at(9, 1), '嗯……我看一下', { outputTokens: 120 }),
    ],
    '/root/session-bbbb2222/session.v4.jsonl.zstd': [
      assistantAt(at(10, 0), '改好了', { provider: 'buddy', model: 'hy3', outputTokens: 99999 }),
    ],
  }
  const day = mod.collectDay({
    sessionsRoot: '/root',
    now: new Date(2026, 9, 23, 12, 0, 0),
    listDirs: () => ['session-aaaa1111', 'session-bbbb2222', 'session-empty'],
    readEvents: (filePath) => fakeFiles[filePath] ?? [],
  })
  assert.equal(day.label, '2026-10-23')
  assert.equal(day.sessions.length, 2, '空会话不该进摘要')
  assert.equal(day.empty, false)
  assert.equal(day.kept, 3)
  assert.equal(day.diarist.key, 'raccoon/sn-deepseek-v4-1-flash-1017', 'hy3 token 更多但不当执笔')
  assert.ok(day.digest.includes('挂件还是没显示'))
})

test('collectDay：今天一条都没有 → empty，且执笔为 null', () => {
  const day = mod.collectDay({
    sessionsRoot: '/root',
    now: new Date(2026, 9, 23, 12, 0, 0),
    listDirs: () => ['session-aaaa1111'],
    readEvents: () => [userAt(at(9, 0) - 24 * 3600 * 1000, '昨天的')],
  })
  assert.equal(day.empty, true)
  assert.equal(day.diarist, null)
})

test('listSessionDirs：目录不存在就返回空数组，不抛', () => {
  assert.deepEqual(mod.listSessionDirs('/definitely/not/here'), [])
  const dirs = mod.listSessionDirs('/root', {
    readdirSync: () => [{ name: 'session-a', isDirectory: () => true }, { name: 'session.lock', isDirectory: () => false }],
  })
  assert.deepEqual(dirs, ['session-a'])
})

test('readSessionEvents：坏行只丢那一行，不影响别的行', () => {
  const jsonl = [JSON.stringify(userAt(at(9, 0), '好的')), '{"half": ', JSON.stringify(assistantAt(at(9, 1), '嗯'))].join('\n')
  const events = mod.readSessionEvents('/x/session.v4.jsonl.zstd', {
    readFileSync: () => Buffer.from('fake'),
    zstdDecompressSync: () => Buffer.from(jsonl, 'utf8'),
  })
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'user/message')
})

test('readSessionEvents：解压失败返回空数组，不冒泡', () => {
  const events = mod.readSessionEvents('/x/y.zstd', {
    readFileSync: () => {
      throw new Error('EACCES')
    },
  })
  assert.deepEqual(events, [])
})

/* ---------------- 多帧 zstd ---------------- */
/* 会话日志是追加写的，每追加一次多一个 zstd 帧。宿主 Node v24 的
   `zstdDecompressSync` 对整份 buffer 只解出第一帧（实测 340 KB → 241 字节 / 1 行），
   于是"今天有 96 个会话"被读成"今天什么都没聊"，而且不报错。
   所以这里断言：逐帧解必须拼出全部内容。 */

test('decompressZstdFrames：多帧拼回完整内容', async () => {
  const { zstdCompressSync, zstdDecompressSync } = await import('node:zlib')
  const { decompressZstdFrames } = await import('../src/diary-source.mjs')
  const frames = ['{"a":1}\n', '{"b":2}\n', '{"c":3}\n'].map((text) => zstdCompressSync(Buffer.from(text)))
  const plain = decompressZstdFrames(Buffer.concat(frames), zstdDecompressSync)
  assert.equal(plain.toString(), '{"a":1}\n{"b":2}\n{"c":3}\n')
})

test('decompressZstdFrames：单帧直接解，坏帧跳过不连累别人', async () => {
  const { zstdCompressSync, zstdDecompressSync } = await import('node:zlib')
  const { decompressZstdFrames } = await import('../src/diary-source.mjs')
  const good = zstdCompressSync(Buffer.from('ok'))
  assert.equal(decompressZstdFrames(good, zstdDecompressSync).toString(), 'ok')

  const junk = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00])
  const mixed = Buffer.concat([good, junk, good])
  assert.equal(decompressZstdFrames(mixed, zstdDecompressSync).toString(), 'okok')
})

test('zstdAvailable：能拿到解压函数就是 true', async () => {
  const { zstdAvailable } = await import('../src/diary-source.mjs')
  assert.equal(zstdAvailable({ zstdDecompressSync: () => Buffer.alloc(0) }), true)
})

test('去重的边界：20:00 手写与 21:00 定时落在同一个 label 上（writtenDates 才拦得住）', () => {
  // 台账 `writtenDates` 的键就是 label。21:00 定时写「刚刚结束的那一天」= logicalDayFor(now-1)，
  // 而 20:00 手动写的 label 是 logicalDayFor(20:00) = 当天。两者必须是同一个串，
  // 否则同一篇会被写两次（旧实现按 00:00 切日就是这么翻车的）。
  const manualAt20 = mod.logicalDayFor(new Date(2026, 9, 24, 20, 0, 0))
  const scheduledAt21 = mod.logicalDayFor(new Date(2026, 9, 24, 21, 0, 0).getTime() - 1)
  assert.equal(manualAt20, '2026-10-24')
  assert.equal(scheduledAt21, manualAt20)
  // 21:00 那一毫秒本身已经是「下一篇」了：定时器必须回退 1 毫秒再取标签。
  assert.notEqual(mod.logicalDayFor(new Date(2026, 9, 24, 21, 0, 0)), scheduledAt21)
})

test('切日点只有一个真源：diary-doc 的默认时刻必须等于 DAY_ROLLOVER_HOUR', async () => {
  // 「每天几点写」和「几点切日」是同一个概念。曾经 diary-doc / diary-store / index.js
  // 各写一份 '21:00'，改切日点时漏掉任何一处，就会变成「21 点切日、22 点才写」这种鬼状态。
  const doc = await import('../src/diary-doc.mjs')
  assert.equal(mod.DAY_ROLLOVER_HOUR, 21)
  assert.equal(doc.DAY_ROLLOVER_TIME, String(mod.DAY_ROLLOVER_HOUR).padStart(2, '0') + ':00')
})

// ── 2026-10-26 修的一组：日记在抄自己 ───────────────────────────────────────
// 用户原话：「日记太雷同了，尤其是开头」「今天的日记没讲我今天干的事情」。

/** 宿主的真实用户消息形状：正文在 data.content，`data.message` 根本不存在 */
function userFlatAt(time, text) {
  return {
    type: 'user/message',
    time,
    data: { role: 'user', id: `m${time}`, source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

test('主人说的话要进摘要（宿主把用户正文放在 data.content，不在 data.message 里）', () => {
  const events = [userFlatAt(at(10, 0), '今天写短视频稿子'), assistantAt(at(10, 1), '好，我来写')]
  const day = { start: at(0), end: at(23, 59) }
  const picked = mod.pickMessages(events, day)
  assert.equal(picked.length, 2)
  assert.equal(picked[0].role, 'user')
  assert.equal(picked[0].text, '今天写短视频稿子')
  const digest = mod.buildDigest([{ sessionLabel: 'aaaa', messages: picked }])
  assert.ok(digest.text.includes('主人：今天写短视频稿子'), '摘要里必须有主人这条')
})

test('宿主塞进来的运行时注记不进摘要（时间戳、记忆快照、技能目录通知）', () => {
  assert.equal(mod.isHarnessNoise('Time sampled while preparing turn 3, step 1: 2026-10-26T22:01'), true)
  assert.equal(mod.isHarnessNoise('Current runtime context. This snapshot supersedes'), true)
  assert.equal(mod.isHarnessNoise('MNEMON RUNTIME MEMORY SNAPSHOT\nUSER.md'), true)
  assert.equal(mod.isHarnessNoise('The available skill catalog changed. This complete catalog'), true)
  assert.equal(mod.isHarnessNoise('今天写短视频稿子'), false)
  // 一条真话里顺嘴提到"日记"，不能被当成噪音
  assert.equal(mod.isHarnessNoise('我要写日记了'), false)
})

test('dsh-ui 围栏整块换成占位，不把界面 JSON 喂给模型', () => {
  const text = '看这个\n```dsh-ui\n{"title":"x","items":[{"type":"stat","label":"a","value":1}]}\n```\n就是这样'
  const stripped = mod.stripUiFences(text)
  assert.ok(!stripped.includes('"type":"stat"'))
  assert.ok(stripped.includes('（发了一张界面卡片）'))
})

test('执笔会话整段丢掉：提示词里带着当天的摘要，不收就会自己抄自己', () => {
  const prompt = '今天是 2026-10-25。下面是我今天跟主人说话的记录（时间是大概的）：\n- [10:00] 主人：…' + 'x'.repeat(1300)
  const events = [userFlatAt(at(21, 0), prompt), assistantAt(at(21, 1), '今天主人让我改名字。')]
  assert.equal(mod.isDiarySelfSession(events), true)
  // 主人只是聊到写日记，不会被误判
  assert.equal(mod.isDiarySelfSession([userFlatAt(at(21, 0), '我要写日记了')]), false)
})

test('已经写进日记本的正文不会再回到摘要里（回执、正文副本都挡得住）', () => {
  const body = '今天主人让我改名字，说门牌号上写不了空格。'
  const events = [
    userFlatAt(at(10, 0), '今天干了很多事'),
    userFlatAt(at(21, 1), `Agent abc sent a message:\n\n日记已写好（正文如下）：\n\n${body}`),
    assistantAt(at(21, 2), body),
  ]
  const day = { start: at(0), end: at(23, 59) }
  const kept = mod.pickMessages(events, { ...day, excludeHeads: [body] })
  assert.equal(kept.length, 1, '只留那条真对话')
  assert.equal(kept[0].text, '今天干了很多事')
})

test('collectDay 会把执笔会话整个跳过，并报出跳了几个', () => {
  const prompt = '今天是 2026-10-25。下面是我今天跟主人说话的记录：' + 'y'.repeat(1300)
  const files = {
    'ws/session-human': [userFlatAt(at(10, 0), '写了短视频稿子'), assistantAt(at(10, 1), '收到')],
    'ws/session-writer': [userFlatAt(at(21, 0), prompt), assistantAt(at(21, 1), '今天主人让我改名字。')],
  }
  const day = mod.collectDay({
    sessionsRoot: '/sessions',
    now: at(20, 59),
    listDirs: () => Object.keys(files),
    readEvents: (file) => files[file.replace('/sessions/', '').replace(/\/session\.v4\.jsonl\.zstd$/, '')],
  })
  assert.equal(day.sessions.length, 1, '只认那个人味会话')
  assert.equal(day.selfSessions, 1, '跳过几个要能报出来，方便查')
  assert.ok(day.digest.includes('短视频稿子'))
  assert.ok(!day.digest.includes('今天主人让我改名字'))
})
