/**
 * 日记 D2：执笔层（先做纯逻辑：请求怎么拼、回来的文本怎么验）。
 *
 * 为什么把"真正的模型调用"留给宿主半的上层去做，而不是写在这里：
 * 起子代理要用 `ctx.subagents.startActivation(...)`，那是宿主能力，纯模块里拿不到。
 * 所以这里只负责**两次关键判断**：
 *   1. 发给执笔模型的那份请求长什么样（可单测、可复现）；
 *   2. 模型回来的那坨文字，能不能直接落盘（校验规则在这里，不在 UI 里）。
 *
 * 设计稿：docs/设计方案-日记v1.md §三、§六。
 */

/** 正文长度下限。太短说明模型没认真写（或摘要太空）。 */
export const MIN_BODY_CHARS = 80
/** 正文长度上限。超过就不是日记了，是报告。 */
export const MAX_BODY_CHARS = 8000
/** 一句话里出现这些，说明它在跟我解释自己是什么，不是在写日记。 */
const SELF_REFERENCE = [/作为\s*(一个)?\s*(AI|人工智能|语言模型|大模型)/i, /as an ai\b/i, /我是一个?(语言)?模型/]

/**
 * 组装 `startActivation` 需要的 request 对象（纯函数，不碰宿主）。
 *
 * 形状取自宿主真实实现（`@deepseek-ai/dsh-tool-subagent/lib/index.js:461-472`）：
 * `request.prompt` 是 ContentBlock 数组，模型用 `agentOptions` 指定。
 *
 * @param {object} input
 * @param {string} input.prompt 已经拼好的正文（来自 `buildDiaryPrompt`）
 * @param {string} input.provider 执笔 provider，如 `raccoon`
 * @param {string} input.model 执笔 model
 * @param {string} [input.cwd] 工作目录（不传就用宿主默认）
 * @returns {{prompt: Array<{type:'text',text:string}>, agentOptions: {provider:string,model:string}, cwd?: string}}
 */
export function buildActivationRequest({ prompt, provider, model, cwd }) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('diary: prompt 不能为空')
  if (typeof provider !== 'string' || !provider) throw new Error('diary: provider 不能为空')
  if (typeof model !== 'string' || !model) throw new Error('diary: model 不能为空')
  const request = {
    prompt: [{ type: 'text', text: prompt }],
    agentOptions: { provider, model },
  }
  if (typeof cwd === 'string' && cwd) request.cwd = cwd
  return request
}

/**
 * 判断某个模型能不能写日记。
 *
 * 用户定死的规则（m01651）：「现在只支持 DeepSeek」。
 * 这条要**拦住**，不能变成"没有 DeepSeek 就随便找一个顶上"——那是骗人。
 *
 * @param {{provider?: string, model?: string}} selection
 * @returns {{ok:boolean, reason?:string}}
 */
export function checkDiaristSupported(selection) {
  const provider = String(selection?.provider ?? '')
  const model = String(selection?.model ?? '')
  if (!provider || !model) return { ok: false, reason: '没选执笔模型' }
  if (!/deepseek/i.test(`${provider}/${model}`)) {
    return { ok: false, reason: `只支持 DeepSeek 执笔，当前选的是 ${provider}/${model}` }
  }
  return { ok: true }
}

/**
 * 清理模型回来的正文：去掉它自作主张加的标题、代码围栏、前后寒暄。
 *
 * @param {string} raw
 * @returns {string}
 */
export function tidyDiaryBody(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw.replace(/\r\n?/g, '\n').trim()
  // 模型爱把整篇包进 ```markdown 里，拆掉围栏本身，保留内容
  const fenced = /^```(?:markdown|md|text)?\n([\s\S]*?)\n```$/.exec(text)
  if (fenced) text = fenced[1].trim()
  // 去掉首行的 markdown 标题（日期标题由 frontmatter 和渲染层负责）
  text = text.replace(/^#{1,3}\s*[^\n]*\n+/, '')
  return text.trim()
}

/**
 * 校验正文能不能落盘。
 *
 * 为什么不只看长度：模型最容易出的两种毛病是"解释自己"和"跑题复述摘要"，
 * 前者能靠关键词抓，后者抓不了——所以这里只管**硬失败**，
 * 质量留给用户的眼睛（日记是给人看的，不是给门禁看的）。
 *
 * @param {string} body 已经过 tidyDiaryBody
 * @returns {{ok:boolean, reason?:string, chars:number}}
 */
export function validateDiaryBody(body) {
  const text = typeof body === 'string' ? body.trim() : ''
  const chars = text.length
  if (chars === 0) return { ok: false, reason: '正文是空的', chars }
  if (chars < MIN_BODY_CHARS) return { ok: false, reason: `正文太短（${chars} 字，至少 ${MIN_BODY_CHARS}）`, chars }
  if (chars > MAX_BODY_CHARS) return { ok: false, reason: `正文太长（${chars} 字，最多 ${MAX_BODY_CHARS}）`, chars }
  for (const pattern of SELF_REFERENCE) {
    if (pattern.test(text)) return { ok: false, reason: '正文里出现了"作为 AI"这类自我指认', chars }
  }
  return { ok: true, chars }
}

/**
 * 日记文件名：`YYYY-MM-DD.md`。只认这个格式，方便按名字排序。
 * @param {string} label 来自 `localDayBounds().label`
 */
export function diaryFileName(label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(label ?? ''))) throw new Error(`diary: 日期标签不合法：${label}`)
  return `${label}.md`
}

/**
 * 拼整份文件（frontmatter + 正文）。
 *
 * frontmatter 里的字段只给**人和脚本**看，永远不进系统提示词（前缀缓存铁律）。
 *
 * @param {object} input
 * @param {string} input.label
 * @param {string} input.body
 * @param {string} [input.diarist] 如 `raccoon/sn-deepseek-v4-1-flash-1017`
 * @param {number} [input.outputTokens]
 * @param {number} [input.sessions]
 * @param {string} [input.writtenAt] ISO 时间串
 * @returns {string}
 */
/**
 * `2026-10-24` → `2026年10月24日`。**只用于渲染给人看的标题与落款**，
 * 不许拿去当文件名字段、记录文档的「日期」或 writtenDates 的键（那三处必须是 ISO）。
 */
export function chineseDate(label) {
  const text = String(label ?? '').trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return text
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`
}

export function renderDiaryFile({ label, body, diarist, outputTokens, sessions, writtenAt }) {
  const lines = ['---', `date: ${label}`]
  if (diarist) lines.push(`diarist: ${diarist}`)
  if (typeof outputTokens === 'number') lines.push(`output_tokens_today: ${outputTokens}`)
  if (typeof sessions === 'number') lines.push(`sessions: ${sessions}`)
  if (writtenAt) lines.push(`written_at: ${writtenAt}`)
  lines.push('---', '')
  // 用户 2026-10-24 的要求：「日记的标题和结尾可以带上日期。」
  // 标题用中文日期（人在文件列表里一眼看出是哪天），frontmatter 的 date 保持 ISO（程序要解析）。
  const pretty = chineseDate(label)
  lines.push(`# ${pretty}`, '')
  lines.push(String(body ?? '').trim(), '')
  lines.push(`—— ${pretty}`)
  // 结尾补一个换行：老日记文件都是以换行收尾的，追加/对比时才不会把两行粘到一起。
  return lines.join('\n') + '\n'
}

/**
 * 没得挑的时候用哪一条：「本机默认的 DeepSeek 路由」（用户账号那条 API）。
 *
 * 用户 2026-10-24 的要求：「日记的执笔模型也可以选择。默认 DeepSeek。」
 * 这个字面量是宿主自己的默认模型选择（`raccoon/sn-deepseek-v4-1-flash-1017`），
 * 不是从会话记录里推出来的——所以候选为空时也要能写，而不是报「今天没有可用的执笔」。
 */
export const DEFAULT_DIARIST_KEY = 'raccoon/sn-deepseek-v4-1-flash-1017'

/**
 * 选一个「默认执笔」。
 *
 * 以前没选过就是 `no-diarist` 直接失败——用户明明登着 DeepSeek 账号还被告知
 * 「今天没有可用的执笔」，很不像话。优先级：
 *   ① 候选里「官方 DeepSeek」（key 形如 `deepseek/...` 或含 `/deepseek-`）；
 *   ② 候选里任何 provider/model 含 `deepseek` 的；
 *   ③ 都没有（或压根没候选）→ `DEFAULT_DIARIST_KEY`。
 *
 * 入参两种形状都吃：`[{key:'raccoon/xxx'}]` 与 `[{provider:'raccoon', model:'xxx'}]`。
 *
 * @param {Array<{key?:string, provider?:string, model?:string}>} candidates
 * @returns {string} `provider/model` 形式
 */
export function pickDefaultDiarist(candidates) {
  const list = Array.isArray(candidates) ? candidates.filter((item) => item && typeof item === 'object') : []
  const keyOf = (item) => String(item.key || (item.provider && item.model ? `${item.provider}/${item.model}` : item.model || ''))
  // 优先「官方那条」（provider 就是 deepseek 的），其次才是别家挂的 DeepSeek 模型。
  const official = list.find((item) => keyOf(item).toLowerCase().startsWith('deepseek/'))
  if (official) return keyOf(official)
  const anyDeepSeek = list.find((item) => keyOf(item).toLowerCase().includes('deepseek'))
  return anyDeepSeek ? keyOf(anyDeepSeek) : DEFAULT_DIARIST_KEY
}
