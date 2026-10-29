/**
 * 翻译桥：只读官方 translator 的状态，**绝不注册 `conversation.chat.reasoning.body`**。
 *
 * 为什么只读（这条是本项目最硬的一条技术红线，来自宿主源码）：
 *   `conversation.chat.reasoning.body` 是 **single** 槽。宿主槽注册表的原文逻辑是——
 *     同一个 priority 再注册 → **直接抛错**（"single slot already has a registration at
 *     priority N — register at a different priority to shadow it (lowest renders)"）；
 *     不同 priority → 数字小的胜出，等于把官方翻译顶掉。
 *   所以"我们也插一脚"只有两种结果：装的时候崩，或者静默抢走官方翻译。两个都不要。
 *
 * 我们能做的：
 *   1. 读 `ctx.translator.availableProviders()` / `maxTextChars`，在挂件上显示"翻译是否可用"；
 *   2. 在系统提示词里要求"用中文思考"（零成本零风险），降低对翻译的依赖；
 *   3. 如果用户没装官方 bundle，提示一句"去插件页启用思考过程翻译"。
 *
 * 出处：宿主 app.asar 内 `@deepseek-ai/dsh-experimental-translator` 与
 * `@deepseek-ai/dsh-experimental-client-ui-cot-translation` 的 README（MIT）。
 */

/** 官方支持的四条翻译路由。 */
export const TRANSLATOR_PROVIDERS = Object.freeze([
  'bing',
  'google',
  'deepseek-account',
  'deepseek-official',
])

/** 免费/付费分界：前两条是匿名端点，后两条要凭据。 */
export const ANONYMOUS_PROVIDERS = Object.freeze(['bing', 'google'])

/**
 * 探测 translator 服务是否在位（纯查询，不发网络请求）。
 *
 * @param {any} ctx 宿主 Context
 * @returns {{ available: boolean, providers: string[], maxTextChars: number|null, reason?: string }}
 */
export function probeTranslator(ctx) {
  let service
  try {
    service = ctx?.get?.('translator', false)
  } catch {
    service = undefined
  }
  if (!service) {
    return {
      available: false,
      providers: [],
      maxTextChars: null,
      reason: 'translator 服务未挂载：官方 cot-translation bundle 没启用',
    }
  }
  const providers = []
  try {
    // `availableProviders()` 是异步的，且会探测原生路由（可能慢）；
    // 这里只读同步可见的配置字段，异步探测交给 UI 层按需调用。
    if (typeof service.maxTextChars === 'number') providers.push(...TRANSLATOR_PROVIDERS)
  } catch {
    /* 读不到就当没配置 */
  }
  return {
    available: true,
    providers,
    maxTextChars: typeof service.maxTextChars === 'number' ? service.maxTextChars : null,
  }
}

/**
 * 给 UI 的一句话状态（挂件 hover 卡用）。
 * @param {{available:boolean, providers:string[], reason?:string}} probe
 * @returns {string}
 */
export function describeTranslator(probe) {
  if (!probe?.available) return '思考翻译：未启用'
  const paid = probe.providers.filter((p) => !ANONYMOUS_PROVIDERS.includes(p))
  if (probe.providers.length === 0) return '思考翻译：服务在位，未配置路由'
  return paid.length > 0 ? '思考翻译：可用（含付费原生路由）' : '思考翻译：可用（匿名端点）'
}
