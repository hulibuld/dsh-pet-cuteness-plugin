import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePersonaId, readSelection, resolvePersona } from '../src/model-identity.mjs'

/* 模型识别的守门断言。关键点是"匹配顺序"与"投影优先于 agent.options"。 */

const CASES = [
  ['deepseek', 'deepseek-chat', 'deepseek'],
  ['deepseek', 'deepseek-v4-pro', 'deepseek'],
  ['some-proxy', 'deepseek-v3', 'deepseek'],
  ['anthropic', 'claude-sonnet-4', 'claude'],
  ['openai', 'gpt-5', 'gpt'],
  ['openai', 'o3-mini', 'gpt'],
  ['google', 'gemini-2.5-pro', 'gemini'],
  ['xai', 'grok-4', 'grok'],
  ['aliyun', 'qwen-max', 'qwen'],
  ['baidu', 'ernie-4', 'ernie'],
  ['moonshot', 'kimi-k2', 'kimi'],
  ['zhipu', 'glm-4.5', 'glm'],
  ['bytedance', 'doubao-pro', 'doubao'],
  ['minimax', 'abab-6', 'minimax'],
  ['meta', 'llama-4', 'llama'],
  ['mistral', 'mixtral-8x', 'mistral'],
  ['perplexity', 'pplx-70b', 'perplexity'],
]

for (const [provider, model, expected] of CASES) {
  test(`识别：${provider}/${model} → ${expected}`, () => {
    assert.equal(normalizePersonaId(provider, model), expected)
  })
}

test('识别：认不出时回 generic，绝不返回空', () => {
  assert.equal(normalizePersonaId('some-vendor', 'unknown-model'), 'generic')
  assert.equal(normalizePersonaId(undefined, undefined), 'generic')
  assert.equal(normalizePersonaId('', ''), 'generic')
  assert.equal(normalizePersonaId(null, null), 'generic')
})

test('识别：deepseek-v4-pro 不能被 gpt 之类的更宽模式抢走', () => {
  // "v4" 里没有 o3/o4 的独立词形，但要有断言守住这条，防止将来改正则时回归。
  assert.equal(normalizePersonaId('deepseek', 'deepseek-v4-pro'), 'deepseek')
})

test('投影读取：next 优先于 lastUsed', () => {
  const snapshot = {
    values: {
      modelSelection: {
        lastUsed: { provider: 'anthropic', model: 'claude-sonnet-4' },
        next: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      },
    },
  }
  assert.equal(readSelection(snapshot).model, 'deepseek-v4-pro')
})

test('投影读取：next 为 null 时回落到 lastUsed', () => {
  const snapshot = {
    values: { modelSelection: { lastUsed: { provider: 'openai', model: 'gpt-5' }, next: null } },
  }
  assert.equal(readSelection(snapshot).model, 'gpt-5')
})

test('投影读取：结构不对时返回 undefined，不抛错', () => {
  assert.equal(readSelection(undefined), undefined)
  assert.equal(readSelection({}), undefined)
  assert.equal(readSelection({ values: {} }), undefined)
  assert.equal(readSelection({ values: { modelSelection: {} } }), undefined)
})

test('决策入口：投影优先于 agent.options（换模型后 options 是过期的）', () => {
  const out = resolvePersona({
    selection: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    options: { provider: 'anthropic', model: 'claude-sonnet-4' },
  })
  assert.equal(out.personaId, 'deepseek')
  assert.equal(out.source, 'modelSelection')
})

test('决策入口：投影读不到才用 options，并标明来源', () => {
  const out = resolvePersona({ selection: undefined, options: { provider: 'openai', model: 'gpt-5' } })
  assert.equal(out.personaId, 'gpt')
  assert.equal(out.source, 'agent.options')
})

test('决策入口：两者都没有时 generic', () => {
  const out = resolvePersona({})
  assert.equal(out.personaId, 'generic')
  assert.equal(out.source, 'fallback')
})
