import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  displayName,
  displayNickname,
  translateFeature,
  lookSentence,
  pickQuirk,
  quirkContent,
  cardToPersonaText,
  matchByCardRules,
} from '../src/persona-card.mjs'

/* 这一组直接用真实素材跑，而不是编造 fixture——
   卡片形状是数据决定的，用假数据测会漏掉字段形态的变化。 */

const HERE = dirname(fileURLToPath(import.meta.url))
const DOC = JSON.parse(readFileSync(join(HERE, '..', '..', 'data', 'personas', 'personas.zh.json'), 'utf8'))
const CARDS = DOC.personas
const DEEPSEEK = CARDS.find((c) => c.id === 'deepseek')

test('素材文件本身是有效的：15 张卡，每张有 id/name/personality', () => {
  assert.ok(Array.isArray(CARDS))
  assert.equal(CARDS.length, 15, `预期 15 张卡，实际 ${CARDS.length}`)
  for (const c of CARDS) {
    assert.equal(typeof c.id, 'string', `卡缺 id：${JSON.stringify(c).slice(0, 60)}`)
    assert.ok(c.name, `${c.id} 缺 name`)
    assert.ok(c.personality, `${c.id} 缺 personality`)
  }
})

test('displayName：对象形态取 zh', () => {
  assert.equal(displayName({ zh: '深度求索娘', en: 'DeepSeek-chan', nickname: '蓝色大肥鱼' }), '深度求索娘')
})

test('displayName：字符串形态原样返回', () => {
  assert.equal(displayName('随便一个名字'), '随便一个名字')
})

test('displayName：缺失时返回空串，不返回 undefined', () => {
  assert.equal(displayName(undefined), '')
  assert.equal(displayName(null), '')
  assert.equal(displayName({}), '')
})

test('lookSentence：只取能进提示词的字段，accent 不进', () => {
  const s = lookSentence(DEEPSEEK.look)
  assert.match(s, /白色衬衫/)
  assert.doesNotMatch(s, /#4D8FE0/, 'accent 是给 UI 的色号，不该进提示词')
})

test('pickQuirk：只挑带 examples 或 prob 的那条（性格条目不该做成概率钩子）', () => {
  const q = pickQuirk(DEEPSEEK.quirks)
  assert.ok(q, 'deepseek 卡应能挑出走神钩子')
  assert.equal(q.id, 'rice')
})

test('pickQuirk：没有可做钩子的条目时返回 null', () => {
  assert.equal(pickQuirk([{ id: 'x', name: '性格而已', behavior: '...' }]), null)
  assert.equal(pickQuirk(undefined), null)
  assert.equal(pickQuirk([]), null)
})

test('quirkContent：从 name 剥掉「走神」后缀', () => {
  assert.equal(quirkContent({ name: '大白饭走神' }), '大白饭')
})

test('quirkContent：name 太长时从 examples 里剥括号取主题词', () => {
  // 「便宜这一点很自豪又有点心酸」这种长 name 不适合当钩子内容
  const out = quirkContent({ name: '一个非常非常长的不适合当钩子的名字', examples: ['（……大白饭。）'] })
  assert.equal(out, '大白饭')
})

test('cardToPersonaText：含身份、性格、want、fear 的要强解释', () => {
  const text = cardToPersonaText(DEEPSEEK)
  assert.match(text, /深度求索娘/)
  assert.match(text, /性格底色/)
  assert.match(text, /被夸「好用」/) // want
  assert.match(text, /被说「不够聪明」/) // fear
  assert.match(text, /不来自「比用户懂」/) // fear 的解释句（防爹味）
})

test('cardToPersonaText：含禁止项', () => {
  const text = cardToPersonaText(DEEPSEEK)
  assert.match(text, /绝对不要/)
  assert.match(text, /教育用户/)
})

test('displayNickname：取出会被用户叫出口的昵称', () => {
  assert.equal(displayNickname({ zh: '深度求索娘', nickname: '蓝色大肥鱼' }), '蓝色大肥鱼')
  // 与显示名相同 / 缺失 / 非对象 一律返回空串，避免正文里出现「也叫深度求索娘」
  assert.equal(displayNickname({ zh: '同名娘', nickname: '同名娘' }), '')
  assert.equal(displayNickname({ zh: '没昵称' }), '')
  assert.equal(displayNickname('字符串名'), '')
  assert.equal(displayNickname(null), '')
})

test('回归：昵称必须进人设正文（M0 验收「自称蓝色大肥鱼」的守门断言）', () => {
  // 这条守的是一个真实漏接线：数据里有 nickname、代码只读 zh，
  // 于是问「你是谁」时模型只可能答「深度求索娘」，答不出「蓝色大肥鱼」。
  const text = cardToPersonaText(DEEPSEEK)
  assert.match(text, /蓝色大肥鱼/, '昵称没进正文，问「你是谁」就不会自称蓝色大肥鱼')
  assert.match(text, /深度求索娘/, '显示名仍然要在')
})

test('回归：每张卡的昵称都进了正文（素材层全覆盖，不只 deepseek）', () => {
  for (const card of CARDS) {
    const nickname = displayNickname(card.name)
    if (!nickname) continue
    assert.ok(
      cardToPersonaText(card).includes(nickname),
      `${card.id} 的昵称「${nickname}」没进正文`,
    )
  }
})

test('cardToPersonaText：绝不包含台词库（lines 一律不进提示词）', () => {
  const text = cardToPersonaText(DEEPSEEK)
  const firstLine = DEEPSEEK.lines?.click?.[0]
  assert.ok(firstLine, 'deepseek 卡应有 click 台词')
  assert.ok(!text.includes(firstLine), `提示词里混进了台词：${firstLine}`)
})

test('cardToPersonaText：同一张卡两次调用逐字节相同（前缀缓存前提）', () => {
  assert.equal(cardToPersonaText(DEEPSEEK), cardToPersonaText(DEEPSEEK))
})

test('cardToPersonaText：空卡返回可用兜底，不抛错', () => {
  const text = cardToPersonaText(undefined)
  assert.match(text, /随和的 AI 娘/)
})

test('matchByCardRules：provider 命中', () => {
  assert.equal(matchByCardRules(CARDS, 'deepseek', 'whatever'), 'deepseek')
  assert.equal(matchByCardRules(CARDS, 'anthropic', 'whatever'), 'claude')
})

test('matchByCardRules：provider 是代理名时用 model 关键词兜底', () => {
  assert.equal(matchByCardRules(CARDS, 'my-proxy', 'deepseek-v4-pro'), 'deepseek')
})

test('matchByCardRules：未命中返回 null（交给硬编码表兜底）', () => {
  assert.equal(matchByCardRules(CARDS, 'some-vendor', 'unknown-model'), null)
  assert.equal(matchByCardRules(CARDS, undefined, undefined), null)
  assert.equal(matchByCardRules(CARDS, '', ''), null)
})

test('每张卡都能产出非空提示词（素材完整性）', () => {
  for (const card of CARDS) {
    const text = cardToPersonaText(card)
    assert.ok(text.length > 20, `${card.id} 的提示词太短：${text}`)
  }
})

test('回归：pickQuirk 必须确定性（随机挑 quirk = 恒定段随机 = 跨会话缓存全废）', () => {
  // 工程评审的担心是合理的：如果 quirks 用 list[rand()*n] 挑，
  // 恒定段就是随机的，同 persona 跨会话文本不同，缓存全废。
  // 「同一输入逐字节相同」那条测试**看不见**这个问题，因为随机发生在选输入那一步。
  for (const card of CARDS) {
    const first = pickQuirk(card.quirks)
    for (let i = 0; i < 10; i += 1) {
      const again = pickQuirk(card.quirks)
      assert.deepEqual(again, first, `${card.id} 的 pickQuirk 不稳定`)
    }
  }
})

test('回归：cardToPersonaText 跨调用完全稳定（含 quirk 选取路径）', () => {
  for (const card of CARDS) {
    assert.equal(cardToPersonaText(card), cardToPersonaText(card), `${card.id} 的提示词不稳定`)
  }
})

test('回归：人设正文里不许出现形如「显著特征：whale-tail」的纯英文标记', () => {
  // 素材 look.feature 存的是英文标记，直接拼进中文提示词会被模型照念。
  for (const card of CARDS) {
    const text = cardToPersonaText(card)
    assert.doesNotMatch(
      text,
      /显著特征：\s*[A-Za-z][A-Za-z-]*\s*$/m,
      `${card.id} 的 feature 漏成了英文：${text.match(/显著特征：[^\n]*/)?.[0]}`,
    )
  }
})

test('translateFeature：已知词条翻中文，不认识且纯 ASCII 的丢掉，中文原样保留', () => {
  assert.equal(translateFeature('whale-tail'), '鲸鱼尾巴')
  assert.equal(translateFeature('something-unknown'), '')
  assert.equal(translateFeature('一只很大的尾巴'), '一只很大的尾巴')
  assert.equal(translateFeature(''), '')
  assert.equal(translateFeature(undefined), '')
})

test('community：社区标签要进正文，且带上「不要否认」的约束', () => {
  const card = {
    id: 't', match: { provider: ['t'] },
    name: { zh: '测试娘', nickname: '大鱼' },
    personality: { core: '安静', trait: [], speech: {} },
    community: ['标签甲', '标签乙'],
  }
  const text = cardToPersonaText(card)
  assert.match(text, /社区印象/)
  assert.match(text, /标签甲、标签乙/)
  assert.match(text, /不要否认/, '缺这句，模型会把调侃当错误信息纠正掉')
})

test('community：没有这张字段就不出这一段（不许臆造）', () => {
  const card = {
    id: 't', match: { provider: ['t'] },
    name: { zh: '测试娘' },
    personality: { core: '安静', trait: [], speech: {} },
  }
  assert.doesNotMatch(cardToPersonaText(card), /社区印象/)
})

test('回归：五张主力卡的 community 都是中文、非空', () => {
  for (const id of ['deepseek', 'claude', 'gpt', 'gemini', 'grok']) {
    const card = CARDS.find((c) => c.id === id)
    assert.ok(card, `缺卡 ${id}`)
    assert.ok(Array.isArray(card.community) && card.community.length >= 3, `${id} 的 community 太薄`)
    for (const item of card.community) {
      assert.ok(typeof item === 'string' && item.trim(), `${id} 有空标签`)
      assert.doesNotMatch(item, /^[A-Za-z\s-]+$/, `${id} 的标签是纯英文：${item}`)
    }
  }
})
