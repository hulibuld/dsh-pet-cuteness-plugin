import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_BODY_CHARS,
  MIN_BODY_CHARS,
  buildActivationRequest,
  DEFAULT_DIARIST_KEY,
  checkDiaristSupported,
  chineseDate,
  diaryFileName,
  pickDefaultDiarist,
  renderDiaryFile,
  tidyDiaryBody,
  validateDiaryBody,
} from '../src/diary-writer.mjs'

/* ---------------- 请求组装 ---------------- */

test('buildActivationRequest：prompt 变成 ContentBlock 数组，agentOptions 带 provider/model', () => {
  const request = buildActivationRequest({ prompt: '写日记', provider: 'raccoon', model: 'sn-deepseek-v4-1-flash-1017' })
  assert.deepEqual(request.prompt, [{ type: 'text', text: '写日记' }])
  assert.deepEqual(request.agentOptions, { provider: 'raccoon', model: 'sn-deepseek-v4-1-flash-1017' })
  assert.equal('cwd' in request, false)
})

test('buildActivationRequest：给了 cwd 才带上，空串当没给', () => {
  assert.equal(buildActivationRequest({ prompt: 'x', provider: 'a', model: 'b', cwd: '/tmp' }).cwd, '/tmp')
  assert.equal('cwd' in buildActivationRequest({ prompt: 'x', provider: 'a', model: 'b', cwd: '' }), false)
})

test('buildActivationRequest：缺 prompt / provider / model 一律抛错，不许带着半个请求去起子代理', () => {
  assert.throws(() => buildActivationRequest({ prompt: '   ', provider: 'a', model: 'b' }), /prompt/)
  assert.throws(() => buildActivationRequest({ prompt: 'x', provider: '', model: 'b' }), /provider/)
  assert.throws(() => buildActivationRequest({ prompt: 'x', provider: 'a', model: '' }), /model/)
})

/* ---------------- 执笔资格 ---------------- */

test('checkDiaristSupported：DeepSeek 放行（provider 或 model 任一命中即可）', () => {
  assert.equal(checkDiaristSupported({ provider: 'raccoon', model: 'sn-deepseek-v4-1-flash-1017' }).ok, true)
  assert.equal(checkDiaristSupported({ provider: 'deepseek-account', model: 'deepseek-flash' }).ok, true)
})

test('checkDiaristSupported：非 DeepSeek 必须拒绝，并把实际选的那对写进 reason', () => {
  const result = checkDiaristSupported({ provider: 'anthropic', model: 'claude-sonnet' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /anthropic\/claude-sonnet/)
})

test('checkDiaristSupported：没选模型时给的是"没选"而不是"不支持"', () => {
  assert.match(checkDiaristSupported({}).reason, /没选/)
  assert.match(checkDiaristSupported(null).reason, /没选/)
})

/* ---------------- 正文清理 ---------------- */

test('tidyDiaryBody：拆掉 markdown 围栏，只留里面的话', () => {
  const raw = '```markdown\n今天写了很多东西。\n```'
  assert.equal(tidyDiaryBody(raw), '今天写了很多东西。')
})

test('tidyDiaryBody：去掉模型自己加的日期标题（标题由渲染层统一给）', () => {
  assert.equal(tidyDiaryBody('## 2026-10-22\n今天很累。'), '今天很累。')
  assert.equal(tidyDiaryBody('# 日记\n今天很累。'), '今天很累。')
})

test('tidyDiaryBody：CRLF 归一、首尾空白去掉、非字符串给空串', () => {
  assert.equal(tidyDiaryBody('  第一行\r\n第二行  '), '第一行\n第二行')
  assert.equal(tidyDiaryBody(null), '')
  assert.equal(tidyDiaryBody(undefined), '')
})

test('tidyDiaryBody：正文里的二级标题不会被误删（只清最开头那行）', () => {
  const raw = '今天读了一点书。\n\n## 下午\n困。'
  assert.equal(tidyDiaryBody(raw), '今天读了一点书。\n\n## 下午\n困。')
})

/* ---------------- 正文校验 ---------------- */

test('validateDiaryBody：正常长度通过，并回带字数', () => {
  const body = '今'.repeat(MIN_BODY_CHARS)
  const result = validateDiaryBody(body)
  assert.equal(result.ok, true)
  assert.equal(result.chars, MIN_BODY_CHARS)
})

test('validateDiaryBody：空正文 / 太短 / 太长都硬失败', () => {
  assert.equal(validateDiaryBody('').ok, false)
  assert.match(validateDiaryBody('太短了').reason, /太短/)
  assert.equal(validateDiaryBody('字'.repeat(MAX_BODY_CHARS + 1)).ok, false)
})

test('validateDiaryBody：出现"作为 AI"这类自我指认就拒', () => {
  const sentences = [
    '作为 AI，我今天学到很多。',
    'As an AI, I cannot feel.',
    '我是一个语言模型，今天很开心。',
  ]
  for (const body of sentences) {
    const result = validateDiaryBody(body.padEnd(MIN_BODY_CHARS, '。'))
    assert.equal(result.ok, false, body)
    assert.match(result.reason, /自我指认/)
  }
})

test('validateDiaryBody：只在长度够时才查自我指认，先报最要紧的那条', () => {
  assert.match(validateDiaryBody('作为 AI').reason, /太短/)
})

/* ---------------- 文件名与整份文件 ---------------- */

test('diaryFileName：只认 YYYY-MM-DD', () => {
  assert.equal(diaryFileName('2026-10-22'), '2026-10-22.md')
  assert.throws(() => diaryFileName('2026-1-1'), /不合法/)
  assert.throws(() => diaryFileName('../../etc/passwd'), /不合法/)
  assert.throws(() => diaryFileName(undefined), /不合法/)
})

test('renderDiaryFile：frontmatter 字段按序输出，正文另起', () => {
  const text = renderDiaryFile({
    label: '2026-10-22',
    body: '今天写完了台词层。',
    diarist: 'raccoon/sn-deepseek-v4-1-flash-1017',
    outputTokens: 104993,
    sessions: 5,
    writtenAt: '2026-10-22T21:00:03+08:00',
  })
  const lines = text.split('\n')
  assert.equal(lines[0], '---')
  assert.equal(lines[1], 'date: 2026-10-22')
  assert.equal(lines[2], 'diarist: raccoon/sn-deepseek-v4-1-flash-1017')
  assert.equal(lines[3], 'output_tokens_today: 104993')
  assert.equal(lines[4], 'sessions: 5')
  assert.equal(lines[5], 'written_at: 2026-10-22T21:00:03+08:00')
  assert.equal(lines[6], '---')
  assert.equal(lines[7], '')
  assert.equal(lines[8], '# 2026年10月22日')
  assert.match(text, /今天写完了台词层。/)
  assert.equal(text.endsWith('\n'), true)
})

test('正文标题与结尾落款都带中文日期，中间各留一个空行', () => {
  const text = renderDiaryFile({ label: '2026-10-24', body: '今天我把插件的开关做完了。' })
  const pretty = '2026年10月24日'
  assert.ok(text.includes(`# ${pretty}`), '标题必须是一级标题 + 中文日期')
  assert.ok(text.endsWith(`\n\n—— ${pretty}\n`), '结尾必须是一行署名式日期，且正文与它之间留一个空行')
  // 正文 → 空行 → 落款：不许挤在一起，也不许多空几行
  assert.ok(text.includes(`今天我把插件的开关做完了。\n\n—— ${pretty}`))
  assert.equal(text.includes('星期'), false, '不要加星期：一周七天的多语言纠结不值当')
})

test('renderDiaryFile 是幂等的：同一份入参渲染两次完全一致', () => {
  const input = {
    label: '2026-10-24',
    body: '正文第一段。\n\n正文第二段。',
    diarist: 'raccoon/sn-deepseek-v4-1-flash-1017',
    outputTokens: 1234,
    sessions: 3,
    writtenAt: '2026-10-24T21:00:01+08:00',
  }
  assert.equal(renderDiaryFile(input), renderDiaryFile(input))
  // 入参对象不能被我改（纯函数）
  assert.deepEqual(input, {
    label: '2026-10-24',
    body: '正文第一段。\n\n正文第二段。',
    diarist: 'raccoon/sn-deepseek-v4-1-flash-1017',
    outputTokens: 1234,
    sessions: 3,
    writtenAt: '2026-10-24T21:00:01+08:00',
  })
})

test('renderDiaryFile：label 不合法就原样放，不抛错', () => {
  assert.equal(chineseDate('2026-1-1'), '2026-1-1')
  assert.equal(chineseDate('今天'), '今天')
  const text = renderDiaryFile({ label: '今天', body: '正文' })
  assert.ok(text.includes('# 今天'))
  assert.ok(text.includes('—— 今天'))
})

test('pickDefaultDiarist：有 DeepSeek 候选就挑 DeepSeek', () => {
  assert.equal(
    pickDefaultDiarist([
      { key: 'buddy/hy3' },
      { key: 'raccoon/sn-deepseek-v4-1-flash-1017' },
      { key: 'buddy/hy4' },
    ]),
    'raccoon/sn-deepseek-v4-1-flash-1017',
  )
  // {provider, model} 两种形状都吃得下
  assert.equal(
    pickDefaultDiarist([{ provider: 'buddy', model: 'hy3' }, { provider: 'raccoon', model: 'DeepSeek-V4' }]),
    'raccoon/DeepSeek-V4',
  )
  // 官方 DeepSeek 优先于别家的 deepseek
  assert.equal(
    pickDefaultDiarist([{ key: 'other/deepseek-v3' }, { key: 'deepseek/deepseek-chat' }]),
    'deepseek/deepseek-chat',
  )
})

test('pickDefaultDiarist：一个候选都没有也返回默认 DeepSeek，不返回空', () => {
  assert.equal(pickDefaultDiarist([]), DEFAULT_DIARIST_KEY)
  assert.equal(pickDefaultDiarist(undefined), DEFAULT_DIARIST_KEY)
  assert.equal(pickDefaultDiarist([null, 'x', 3]), DEFAULT_DIARIST_KEY)
  assert.equal(DEFAULT_DIARIST_KEY, 'raccoon/sn-deepseek-v4-1-flash-1017')
})

test('pickDefaultDiarist：候选全是非 DeepSeek 才回落到默认那条', () => {
  assert.equal(pickDefaultDiarist([{ key: 'buddy/hy3' }, { key: 'buddy/hy4' }]), DEFAULT_DIARIST_KEY)
})

test('renderDiaryFile：可选字段缺省时不写空行占位', () => {
  const text = renderDiaryFile({ label: '2026-10-22', body: '正文' })
  assert.equal(text.includes('diarist'), false)
  assert.equal(text.includes('output_tokens_today'), false)
  assert.equal(text.includes('written_at'), false)
})
