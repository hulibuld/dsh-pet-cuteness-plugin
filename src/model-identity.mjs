/**
 * 模型识别：provider / model → 人格卡 id。
 *
 * 与 v2 的差别：不再只靠 `agent.options`（创建时的默认值，用户中途换模型就过期），
 * 主来源改成 `modelSelection` 投影的 `next`。
 *
 * 匹配顺序很重要：先精确匹配 provider，再匹配 model 子串。
 * `deepseek-v4-pro` 必须被 deepseek 命中，不能被更宽的模式抢走。
 */

/** provider / model 名 → 人格卡 id。数组顺序即优先级。 */
export const MATCHERS = [
  ['deepseek', /deepseek|深度求索/i],
  ['claude', /claude|anthropic|sonnet|opus|haiku/i],
  // gpt 的正则要挡住 o3/o4 之外的 o 开头的词，同时不能让 "openai" 之外的串误命中
  ['gpt', /(?:^|[^a-z])gpt|openai|chatgpt|(?:^|[^a-z])o[34](?:[^0-9]|$)/i],
  ['gemini', /gemini|bard/i],
  ['grok', /grok|xai|x\.ai/i],
  ['qwen', /qwen|tongyi|通义|千问/i],
  ['ernie', /ernie|wenxin|文心/i],
  ['kimi', /kimi|moonshot|月之暗面/i],
  ['glm', /glm|zhipu|chatglm|智谱/i],
  ['doubao', /doubao|seed|豆包/i],
  ['minimax', /minimax|abab/i],
  ['llama', /llama|meta-llama/i],
  ['mistral', /mistral|mixtral/i],
  ['perplexity', /perplexity|pplx/i],
]

/**
 * 归一化：provider 与 model 拼起来一起匹配，先命中者胜。
 * 认不出就回 `generic` —— 任何模型都必须有娘，这是体验底线，不是兜底丑化。
 *
 * @param {string|undefined|null} provider
 * @param {string|undefined|null} model
 * @returns {string}
 */
export function normalizePersonaId(provider, model) {
  const haystack = `${provider ?? ''} ${model ?? ''}`
  if (!haystack.trim()) return 'generic'
  for (const [id, pattern] of MATCHERS) {
    if (pattern.test(haystack)) return id
  }
  return 'generic'
}

/**
 * 从会话投影快照里读「现在真正在用的模型」。
 *
 * 语义：`modelSelection.next` = 下一个请求要用的选择（显式选择先挂 pending，
 * 直到同路由的 request/header 消费它）；`lastUsed` = 上一个请求实际用的。
 * 当前在用的 = next ?? lastUsed。
 *
 * @param {any} snapshot `projections.snapshot(session, ['modelSelection'])` 的返回值
 * @returns {{provider?: string, model?: string}|undefined}
 */
export function readSelection(snapshot) {
  try {
    const values = snapshot?.values
    const selection = values?.modelSelection
    const next = selection?.next ?? selection?.lastUsed
    if (next && typeof next.model === 'string') return next
  } catch {
    /* 投影服务不可用或还没算出值 */
  }
  return undefined
}

/**
 * 决定人格卡 id 的唯一入口（宿主半与浏览器半共用，避免两边判断不一致）。
 *
 * 来源优先级：
 *   1. `modelSelection.next`（投影，最准）
 *   2. `agent.options`（创建时的默认值，只在投影读不到时用；会过期）
 *   3. `generic`
 *
 * @param {object} input
 * @param {{provider?:string, model?:string}|undefined} [input.selection]
 * @param {{provider?:string, model?:string}|undefined} [input.options]
 * @returns {{ personaId: string, provider: string|undefined, model: string|undefined, source: string }}
 */
export function resolvePersona({ selection, options } = {}) {
  if (selection && (selection.provider || selection.model)) {
    return {
      personaId: normalizePersonaId(selection.provider, selection.model),
      provider: selection.provider,
      model: selection.model,
      source: 'modelSelection',
    }
  }
  if (options && (options.provider || options.model)) {
    return {
      personaId: normalizePersonaId(options.provider, options.model),
      provider: options.provider,
      model: options.model,
      source: 'agent.options',
    }
  }
  return { personaId: 'generic', provider: undefined, model: undefined, source: 'fallback' }
}
