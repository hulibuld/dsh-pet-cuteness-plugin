import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LINE_LIMITS,
  REJECTION_KEYS,
  emptyRejections,
  isSpeakable,
  looksLikeMutter,
  rejectionOf,
  scoreLine,
  splitCandidates,
  tidyLine,
  extractLines,
  createLineFeed,
  cardLineTexts,
  rotateLine,
} from '../src/voice-lines.mjs'

/* 台词层的守门。
   这一层是"从模型的思考过程里摘人话"：摘错了会显示一堆代码碎片，
   摘多了会刷屏，摘不到就等于这功能不存在。所以每条规则都要有断言。 */

test('tidyLine：剥掉列表符、编号、成对引号括号，句内文字一个字不改', () => {
  assert.equal(tidyLine('- 嗯，这里有点麻烦'), '嗯，这里有点麻烦')
  assert.equal(tidyLine('1. 好像不太对'), '好像不太对')
  assert.equal(tidyLine('「哎呀」'), '哎呀')
  assert.equal(tidyLine('（唔……）'), '唔……')
  // 句子内部的括号不能动：那是她原话的一部分
  assert.equal(tidyLine('先看 (a) 再决定'), '先看 (a) 再决定')
  // 落单的引号要清掉（实跑里出现过 `"嗯` 这种半个引号开头的句子）
  assert.equal(tidyLine('"嗯'), '嗯')
  assert.equal(tidyLine('好像不对“'), '好像不对')
})

test('isSpeakable：代码、路径、英文、数字开头一律不配当台词', () => {
  assert.equal(isSpeakable('嗯，好像是这里'), true)
  assert.equal(isSpeakable('糟了'), true)
  // 太短：单字只有语气词放行（「嗯」单独冒出来最像人在嘀咕）
  assert.equal(isSpeakable('看'), false)
  assert.equal(isSpeakable('嗯'), true)
  assert.equal(isSpeakable('诶'), true)
  assert.equal(isSpeakable('这'.repeat(LINE_LIMITS.maxLength + 1)), false)
  // 技术味的东西
  for (const bad of [
    '看 http://example.com',
    '路径是 src/index.js',
    'const x = 1',
    '调用 foo() 就行',
    '返回 {ok:true}',
    'import React from react',
    'ABCDEF',
  ]) {
    assert.equal(isSpeakable(bad), false, `不该说：${bad}`)
  }
  // 数字开头
  assert.equal(isSpeakable('123 个文件'), false)
  // 纯符号
  assert.equal(isSpeakable('——'), false)
})

test('scoreLine：带语气词/第一人称/问叹号的句子得分更高', () => {
  const lively = scoreLine('诶？好像有点不对呀')
  const flat = scoreLine('检查文件结构是否一致')
  assert.ok(lively > flat, `语气词句应该更高分：${lively} vs ${flat}`)
  assert.ok(scoreLine('我觉得可以') > 0, '第一人称也要加分')
})

test('splitCandidates：按句号/逗号切开，标点留在句尾，只留能说的', () => {
  const text = '先看看目录。嗯，这里好像不对，要不要重写？执行 npm run build 试试'
  const out = splitCandidates(text)
  assert.ok(out.includes('先看看目录。'), '正常短句要留下，并且保留句尾标点')
  assert.ok(out.includes('嗯'), '单独的语气词要留下（尾随逗号会被剥掉）')
  assert.ok(out.includes('要不要重写？'), '问句要留下，问号是语气的一部分')
  assert.ok(!out.some((line) => line.includes('npm')), '命令行不该出现在台词里')
})

test('extractLines：按分数取前 N，但输出保持她想到的顺序', () => {
  const text = '第一步看配置。诶？好像不太对呀。算了先跑一遍。'
  const out = extractLines(text, { limit: 2 })
  assert.equal(out.length, 2)
  // 「诶？好像不太对呀」分数最高，必须入选
  assert.ok(out.some((line) => line.includes('诶')), '最高分那句必须入选')
  // 输出顺序 = 原文顺序（不能因为打分把时间线打乱）
  const indexes = out.map((line) => text.indexOf(line))
  assert.deepEqual([...indexes].sort((a, b) => a - b), indexes, '输出要保持原顺序')
})

test('extractLines：limit 生效，且空输入不抛错', () => {
  assert.equal(extractLines('好。嗯。对。呀。', { limit: 2 }).length, 2)
  for (const bad of [undefined, null, '', 42]) {
    assert.doesNotThrow(() => extractLines(bad))
    assert.deepEqual(extractLines(bad), [])
  }
})

test('feed：推一条读一条，cursor 只往后走', () => {
  let t = 0
  const feed = createLineFeed({ now: () => (t += 1000) })
  const accepted = feed.push('s1', '这里好像不对呀。')
  assert.equal(accepted.length, 1)

  const first = feed.read('s1', 0)
  assert.equal(first.lines.length, 1)
  assert.equal(first.cursor, 1)
  // 用同一个 cursor 再读：没有新内容
  assert.equal(feed.read('s1', first.cursor).lines.length, 0)
})

test('feed：按会话分桶，别的会话的嘀咕不会串台', () => {
  let t = 0
  const feed = createLineFeed({ now: () => (t += 1000) })
  feed.push('a', '这边好像不太对呀。')
  feed.push('b', '居然是这样吗。')
  assert.equal(feed.read('a', 0).lines.length, 1)
  assert.equal(feed.read('b', 0).lines.length, 1)
  assert.match(feed.read('a', 0).lines[0].text, /这边/, 'a 会话只能读到自己的台词')
  assert.equal(feed.read('c', 0).lines.length, 0, '没有台词的会话读到空')
})

test('feed：环形缓冲只留最近 N 条（长会话不会把内存吃满）', () => {
  let t = 0
  const feed = createLineFeed({ now: () => (t += 1000), bufferSize: 3, dedupeWindowMs: 0 })
  for (let i = 0; i < 6; i += 1) feed.push('s1', `嗯，第${i}次好像不太对呀。`)
  const page = feed.read('s1', 0)
  assert.equal(page.lines.length, 3, '只保留最近 3 条')
})

test('feed：同一句在去重窗口内不重复冒出来', () => {
  let t = 0
  const feed = createLineFeed({ now: () => (t += 1000) })
  assert.equal(feed.push('s1', '这里好像不对呀。').length, 1)
  t += 3000
  assert.equal(feed.push('s1', '这里好像不对呀。').length, 0, '重复的句子要被吃掉')
  t += LINE_LIMITS.dedupeWindowMs
  assert.equal(feed.push('s1', '这里好像不对呀。').length, 1, '过了窗口可以再说一次')
})

test('feed：两次推送之间要留间隔（否则连续两步推理连成一片）', () => {
  let t = 0
  const feed = createLineFeed({ now: () => (t += 100) })
  assert.equal(feed.push('s1', '先看看目录吧。').length, 1)
  // 间隔不够（100ms < minGapMs）：这一步整体丢弃
  assert.equal(feed.push('s1', '这里好像不太对呀。').length, 0)
  t += LINE_LIMITS.minGapMs
  assert.equal(feed.push('s1', '这里好像不太对呀。').length, 1)
})

test('feed：长轮询 —— 有台词立刻返回，没台词等超时也是 resolve（不 reject）', async () => {
  const feed = createLineFeed()
  const started = Date.now()
  await feed.wait('s1', 0, 30)
  assert.ok(Date.now() - started >= 20, '没东西时要真的等一会儿')
  // 推送会立刻唤醒等待者
  const pending = feed.wait('s1', 0, 5000)
  feed.push('s1', '这里好像不对呀。')
  await pending
  assert.equal(feed.read('s1', 0).lines.length, 1)
})

test('feed：脏输入不抛错（空 sessionId / 非字符串 / 负数 cursor）', () => {
  const feed = createLineFeed()
  assert.deepEqual(feed.push('', '好像不对呀。'), [])
  assert.deepEqual(feed.push(undefined, '好像不对呀。'), [])
  assert.doesNotThrow(() => feed.read(undefined, -5))
  assert.doesNotThrow(() => feed.read('s1', Number.NaN))
})

test('台词偶尔挂颜文字：稳定、不改原句、不叠两层', async () => {
  const { decorateLine, KAOMOJI } = await import('../src/voice-lines.mjs')
  // 同一句话永远同一个结果（用哈希决定，不用 Math.random）——
  // 否则刷新页面台词会换个表情，测试也没法断言。
  const line = '这里好像不对呀。'
  assert.equal(decorateLine(line), decorateLine(line))
  const decorated = decorateLine(line)
  assert.ok(decorated.startsWith(line), '只准在句尾追加，原句一个字都不许改')
  if (decorated !== line) {
    assert.ok(
      KAOMOJI.some((face) => decorated.endsWith(face)),
      '追加的必须是 KAOMOJI 里的一员',
    )
  }
  // 模型自己已经打了表情的句子不再叠一层
  assert.equal(decorateLine('好耶 (｡･ω･｡)'), '好耶 (｡･ω･｡)')
  // ratio 0 关得掉（给"嫌吵"的用户留后路）
  assert.equal(decorateLine(line, { ratio: 0 }), line)
})

test('颜文字只在句尾，冷却与去重不受影响', async () => {
  const { createLineFeed } = await import('../src/voice-lines.mjs')
  const feed = createLineFeed({ minGapMs: 0, dedupeWindowMs: 60_000 })
  const first = feed.push('s', '嗯……这里好像不对呀。')
  assert.ok(first.length >= 1, '至少要摘出一句')
  const read = feed.read('s', 0)
  assert.equal(read.lines.length, first.length)
  // 同一句再来一次：按原句去重，即使装饰后的字符串不同也必须挡住
  const second = feed.push('s', '嗯……这里好像不对呀。')
  assert.equal(second.length, 0, '去重要按原句算，不能被颜文字骗过去')
})

test('cardLineTexts：摊平角色卡台词，两种存法都认', () => {
  const card = {
    lines: {
      working: [{ text: '我去翻一下。', shape: 'state' }, '稍等，找找看。'],
      thinking: [{ text: '嗯……这个得算一下。' }],
      empty: [],
    },
  }
  assert.deepEqual(cardLineTexts(card, ['working']), ['我去翻一下。', '稍等，找找看。'])
  assert.deepEqual(cardLineTexts(card, ['empty', 'thinking']), ['嗯……这个得算一下。'], '空桶要跳过，落到下一个')
  assert.deepEqual(cardLineTexts(card, ['nope']), [])
  assert.deepEqual(cardLineTexts(null, ['working']), [], '没有卡就返回空，不许抛')
  assert.deepEqual(cardLineTexts({ lines: { working: [null, { text: '   ' }, 42] } }, ['working']), [])
})

test('rotateLine：按会话自己轮转，不随机、不越界', () => {
  const list = ['a', 'b', 'c']
  assert.equal(rotateLine(list, 0), 'a')
  assert.equal(rotateLine(list, 1), 'b')
  assert.equal(rotateLine(list, 3), 'a', '绕回开头')
  assert.equal(rotateLine(list, -1), 'b', '负数也要能算')
  assert.equal(rotateLine([], 5), '')
  assert.equal(rotateLine(null, 5), '')
})

/* ── 2026-10-24 用户报「气泡全是台词库」之后补的一层 ─────────────────────────
   /debug 上只有 `pushed: 21` 这一个总数，谁也说不清 6330 个推理帧死在哪一档。
   下面的断言全部围绕"拒绝原因可归因"与"卡片垫句不许反客为主"。 */

test('rejectionOf：每一档拒绝都有名字，判定本身与 isSpeakable 完全一致', () => {
  assert.deepEqual([...REJECTION_KEYS], [
    'tooShort',
    'tooLong',
    'technical',
    'dup',
    'perStep',
    'noBoundary',
    'gap',
    'other',
  ])
  assert.equal(rejectionOf('嗯，好像是这里'), null)
  assert.equal(rejectionOf('看'), 'tooShort')
  assert.equal(rejectionOf('这'.repeat(LINE_LIMITS.maxLength + 1)), 'tooLong')
  assert.equal(rejectionOf('路径是 src/index.js'), 'technical')
  assert.equal(rejectionOf('123 个文件'), 'other')
  // 同一个输入，两条 API 必须同答案（否则 /debug 的账和实际行为会各说一套）
  for (const line of ['嗯，好像是这里', '看', '路径是 src/index.js', '123 个文件', 'ABCDEF']) {
    assert.equal(rejectionOf(line) === null, isSpeakable(line), line)
  }
})

test('extractLines / splitCandidates：传 stats 后按原因计数，并留下原句样本', () => {
  const stats = { pushed: 0, rejected: emptyRejections() }
  const lines = extractLines(
    '路径是 src/index.js。嗯，好像不太对呀。' + '这'.repeat(LINE_LIMITS.maxLength + 1) + '。',
    { stats },
  )
  assert.deepEqual(lines, ['嗯', '好像不太对呀。'])
  assert.equal(stats.rejected.technical, 1)
  assert.equal(stats.rejected.tooLong, 1)
  assert.ok(Array.isArray(stats.samples.technical), '样本要能看见是哪句话被技术味闸拦了')
  assert.match(stats.samples.technical[0], /src\/index\.js/)
})

test('英文句号也是句子边界（本机模型整段用英文推理时，否则一句都切不开）', () => {
  const stats = { pushed: 0, rejected: emptyRejections() }
  const lines = extractLines('Hmm. Wait. The user wants a plugin that does many things here.', { stats })
  assert.ok(lines.includes('Hmm.'), '短语气词要能冒出来')
  assert.ok(lines.includes('Wait.'), JSON.stringify(lines))
  // 长英文句仍然被技术味闸拦掉——纪律没破，只是不再"整段一起死"
  assert.equal(lines.some((line) => line.includes('The user wants')), false)
  // 句号后面没有空白（index.js / v1.2）不许切
  assert.deepEqual(splitCandidates('看看 config.json 这个文件'), [])
})

test('looksLikeMutter：只放行纯语气词，不放过任何代码或长句', () => {
  for (const ok of ['Hmm', 'hmm.', 'Wait', 'Okay.', 'oh no']) assert.equal(looksLikeMutter(ok), true, ok)
  for (const bad of [
    'import React from react',
    'ABCDEF',
    'Let me check the config',
    'Hmm, the config.json looks fine',
    'const',
  ]) {
    assert.equal(looksLikeMutter(bad), false, bad)
  }
})

test('feed：间隔闸是"整次推送"的属性——撞上间隔只记 1 次 gap，不是每句各记一次', () => {
  let t = 0
  const feed = createLineFeed({ now: () => (t += 100) })
  const stats = { pushed: 0, rejected: emptyRejections() }
  assert.equal(feed.push('s1', '先看看目录吧。', { stats }).length, 1)
  // 同一口气里的三句：老写法会把三句全判掉、且 gap 记 3 次（无法归因）
  const dropped = feed.push('s1', '这里好像不太对呀。要不要再确认一下。先别急着改。', { stats })
  assert.deepEqual(dropped, [])
  assert.equal(stats.rejected.gap, 1)
  t += LINE_LIMITS.minGapMs
  assert.ok(feed.push('s1', '这里好像不太对呀。', { stats }).length >= 1)
})

test('feed：pending 反映"还有几句没被浏览器捞走"，read 之后归零', () => {
  let t = 0
  const feed = createLineFeed({ now: () => (t += 1000) })
  assert.equal(feed.pending('s1'), 0)
  feed.push('s1', '先看看目录吧。', {})
  assert.equal(feed.pending('s1'), 1)
  const page = feed.read('s1', 0)
  assert.equal(page.lines.length, 1)
  assert.equal(feed.pending('s1'), 0)
})

test('feed：stats 是累计账本，pushed 与 rejected 加起来对得上候选句', () => {
  let t = 0
  const feed = createLineFeed({ now: () => (t += 5000) })
  const stats = feed.stats
  const before = stats.pushed
  const pushed = feed.push('s1', '嗯，好像不太对呀。路径是 src/index.js。', {})
  assert.deepEqual(pushed, ['嗯', '好像不太对呀。'])
  assert.equal(stats.pushed, before + pushed.length)
  assert.equal(stats.rejected.technical, 1)
})

test('游标比队列还靠前（插件重载/宿主重启）时自愈，不会永久停住', async () => {
  // 用户 2026-10-25 实测：「停在一个会话里，几分钟后头顶气泡就不说话了，切到别的会话才恢复」。
  // 根因：插件重载把 feed 的 seq 归零，浏览器还拿着旧的大游标，id > from 永远不成立。
  const feed = createLineFeed({ minGapMs: 0, dedupeWindowMs: 0 })
  feed.push('s1', '第一句')
  feed.push('s1', '第二句')
  const first = feed.read('s1', 0)
  assert.equal(first.lines.length, 2)

  // 模拟「浏览器拿着旧的巨大游标来问」：不能回空游标（否则死循环），要对齐到队尾。
  const healed = feed.read('s1', 9999)
  assert.deepEqual(healed.lines, [], '过期游标不重放旧句')
  assert.equal(healed.cursor, 2, '游标应被对齐到当前队尾')

  // 对齐之后再推一句，用自愈后的游标必须能读到。
  feed.push('s1', '第三句')
  const next = feed.read('s1', healed.cursor)
  assert.equal(next.lines.length, 1)
  assert.equal(next.lines[0].text.includes('第三句'), true)
})

test('过期游标不会让长轮询白等满超时', async () => {
  const feed = createLineFeed({ minGapMs: 0, dedupeWindowMs: 0 })
  feed.push('s2', '一句')
  const startedAt = Date.now()
  await feed.wait('s2', 9999, 5000)
  assert.ok(Date.now() - startedAt < 1000, '过期游标应立即返回，不能等满 5 秒')
})
