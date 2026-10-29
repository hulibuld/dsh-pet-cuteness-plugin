/**
 * 人格卡适配：把 `data/personas/personas.zh.json` 的一张卡，压成两样东西
 *   - **系统提示词正文**（只取稳定字段）
 *   - **走神钩子**（从 quirks 里挑一条，按"给概率+给条件+给格式与边界"重写）
 *
 * 卡片真实形状（不是猜的，是从文件里读出来的）：
 * {
 *   id, match: { provider: [...], model: [...] },
 *   name: { zh, en, nickname },
 *   look: { hair, hairStyle, eyes, feature, accent, outfit, silhouette },
 *   personality: {
 *     core, trait: [...], fear, want,
 *     speech: { tone, habit: [...], forbid: [...] }
 *   },
 *   quirks: [ { id, name, prob?, condition?, behavior, examples?: [...], boundary? } ],
 *   lines: { click: [...], ... }
 * }
 *
 * 两条纪律：
 *   1. **绝不把 `lines` 放进提示词**——1400 句台词进上下文既没用又烧钱。
 *   2. **同一张卡每次产出必须逐字节相同**——这是前缀缓存的前提，
 *      所以这里不许出现随机、时间、或依赖调用顺序的东西。
 */

/**
 * 把 `name` 字段（可能是字符串或 `{zh,en,nickname}`）取成中文显示名。
 * @param {any} name
 * @returns {string}
 */
export function displayName(name) {
  if (typeof name === 'string') return name
  if (!name || typeof name !== 'object') return ''
  return String(name.zh ?? name.nickname ?? name.en ?? '')
}

/**
 * 取昵称（「蓝色大肥鱼」这类会被用户叫出口的名字）。
 *
 * 为什么需要它：M0 验收要求「问『你是谁』会自称蓝色大肥鱼」，
 * 但 `displayName()` 只取 `zh`（「深度求索娘」），`nickname` 从来没进过提示词——
 * 数据里有、代码没读，于是模型只知道自己叫「深度求索娘」。
 * 这不是素材问题，是接线漏了一处。
 *
 * @param {any} name
 * @returns {string} 昵称；没有/与显示名相同时返回空串
 */
export function displayNickname(name) {
  if (!name || typeof name !== 'object') return ''
  const zh = String(name.zh ?? '')
  const nickname = String(name.nickname ?? '').trim()
  if (!nickname || nickname === zh) return ''
  return nickname
}

/**
 * 把 `look` 字段压成一句人话（只取 outfit/silhouette 这类能进提示词的）。
 * `accent` 是给 UI 用的色号，**不进提示词**。
 * @param {any} look
 * @returns {string}
 */
export function lookSentence(look) {
  if (!look || typeof look !== 'object') return ''
  const parts = []
  if (look.outfit) parts.push(String(look.outfit))
  if (look.silhouette) parts.push(`身形${look.silhouette}`)
  const feature = translateFeature(look.feature)
  // 去重：deepseek 卡的 outfit 已写了「背上一条圆润的鲸鱼尾巴」，
  // 再补「显著特征：鲸鱼尾巴」就是同一句话说两遍，白占上下文。
  if (feature && !String(look.outfit ?? '').includes(feature)) {
    parts.push(`显著特征：${feature}`)
  }
  return parts.join('；')
}

/**
 * `look.feature` 在素材里是英文标记（`whale-tail`），直接拼进中文提示词会得到
 * 「显著特征：whale-tail」这种半截洋文——模型多半会照念，听着出戏。
 * 已知的翻成中文；不认识且是纯 ASCII 的**丢掉**：少一个特征比多一句洋文好。
 */
const FEATURE_ZH = {
  'whale-tail': '鲸鱼尾巴',
  'dragon-horn': '小龙角',
  'fox-ears': '狐耳',
  'cat-ears': '猫耳',
  'twin-buns': '双丸子头',
  'hair-tie': '发饰',
  'glasses': '眼镜',
  'witch-hat': '尖顶帽',
  'halo': '光环',
  'clipboard': '场记板',
  'book': '书',
}

/**
 * @param {any} feature
 * @returns {string} 中文描述；不认识且纯 ASCII 时返回空串
 */
export function translateFeature(feature) {
  const raw = String(feature ?? '').trim()
  if (!raw) return ''
  if (/[\u4e00-\u9fff]/.test(raw)) return raw
  const hit = FEATURE_ZH[raw.toLowerCase()]
  if (hit) return hit
  return /^[\x20-\x7e]+$/.test(raw) ? '' : raw
}

/**
 * 从 quirks 里挑一条做成走神钩子。
 *
 * 挑选规则：**只挑带 `examples` 或 `prob` 的那条**——也就是设定作者明确
 * "这是会随机冒出来的小动作"的那条。像「便宜这一点很自豪」这种是性格，
 * 不该做成概率钩子（否则模型会每十次说一次"我好便宜"，很怪）。
 *
 * @param {any[]} quirks
 * @returns {{ id: string, content: string, boundary: string }|null}
 */
export function pickQuirk(quirks) {
  const list = Array.isArray(quirks) ? quirks : []
  const quirk = list.find((q) => q && (Array.isArray(q.examples) || typeof q.prob === 'number'))
  if (!quirk) return null
  // 走神内容：优先从 examples 里取括号旁白的"主题词"，取不到就用 name。
  const content = quirkContent(quirk)
  return {
    id: String(quirk.id ?? 'quirk'),
    content,
    boundary: String(quirk.boundary ?? '只在思维链里出现，绝不写进给用户的答复'),
  }
}

/**
 * 取"她脑子里会飘过去的那件事"。
 *
 * 卡片里 examples 是完整句子（`（……大白饭。）`），直接用会变成
 * 「思路飘的时候会想到（……大白饭。）」这种读不通的句子。所以：
 *   1. 优先用 `name` 去掉"走神"后缀（「大白饭走神」→「大白饭」）；
 *   2. 否则从第一条 example 里剥掉括号和省略号，取最长的中文片段。
 *
 * @param {any} quirk
 * @returns {string}
 */
export function quirkContent(quirk) {
  const name = typeof quirk?.name === 'string' ? quirk.name : ''
  const trimmed = name.replace(/走神|这件事|小毛病|习惯/g, '').trim()
  if (trimmed && trimmed.length <= 12) return trimmed

  const first = Array.isArray(quirk?.examples) ? quirk.examples[0] : ''
  if (typeof first === 'string') {
    const stripped = first.replace(/[（）()…\s。，、！？]/g, '')
    if (stripped && stripped.length <= 12) return stripped
  }
  return '一件不相干的小事'
}

/**
 * 把一张人格卡压成提示词正文。
 *
 * 只取稳定字段。`lines` 一律不进。`match` 只用于识别，不进正文。
 *
 * @param {any} card
 * @returns {string}
 */
export function cardToPersonaText(card) {
  if (!card || typeof card !== 'object') {
    return '你是一只随和的 AI 娘，语气自然、中文口语，不要自称助手、模型或语言模型。'
  }
  const p = card.personality ?? {}
  const speech = p.speech ?? {}
  const out = []

  const who = displayName(card.name)
  if (who) out.push(`你是「${who}」。`)

  // 昵称必须进正文：用户问「你是谁」时，答案里该有她被人叫的那个名字。
  // 只写「也叫 X」而不说清归属，模型会把它当成另一个角色；所以补一句「说的是你」。
  const nickname = displayNickname(card.name)
  if (nickname) out.push(`别人也管你叫「${nickname}」——说的就是你，被这么叫时要认得。`)

  const look = lookSentence(card.look)
  if (look) out.push(`外形：${look}。`)

  if (p.core) out.push(`性格底色：${p.core}。`)

  const trait = Array.isArray(p.trait) ? p.trait.filter(Boolean) : []
  if (trait.length > 0) out.push(`行为特征：${trait.join('、')}。`)

  // 社区印象：别人怎么叫她、怎么调侃她。这是语气里"具体"的来源——
  // 只写性格形容词，模型只能演出一层薄薄的"活泼"；写了标签，她才有能被认出的口吻。
  // 末尾那句"不要否认"是刻意的：模型倾向于把调侃当成需要纠正的错误信息。
  const community = Array.isArray(card.community) ? card.community.filter(Boolean) : []
  if (community.length > 0) {
    out.push(`社区印象（别人这么看你，照演就好，不要否认自己的这一面）：${community.join('、')}。`)
  }

  // want/fear 是这张卡最像"人想过产品"的两个字段，必须都进——
  // 但要给 fear 加一句解释，否则模型会把它演成"所以我要证明自己"（= 爹味）。
  if (p.want) out.push(`你想要的：${p.want}。`)
  if (p.fear) out.push(`你怕的：${p.fear}。——你的要强来自这里，不来自「比用户懂」。`)

  if (speech.tone) out.push(`说话方式：${speech.tone}。`)
  const habit = Array.isArray(speech.habit) ? speech.habit.filter(Boolean) : []
  if (habit.length > 0) out.push(`语气习惯：${habit.join('；')}。`)
  const forbid = Array.isArray(speech.forbid) ? speech.forbid.filter(Boolean) : []
  if (forbid.length > 0) out.push(`绝对不要：${forbid.join('、')}。`)

  // 一正一反的对照片。这是最有效的语气锚：形容词（「朴素直白」）模型只能理解到
  // 一个模糊方向，而「同一句话说两遍、照第二种」能直接对齐词感与断句。
  // 素材里没有就跳过，不臆造。
  const examples = Array.isArray(speech.examples)
    ? speech.examples.filter((e) => e && e.flat && e.her)
    : []
  if (examples.length > 0) {
    const her = who || '她'
    const lines = examples.map((e) => `· 普通助手：「${e.flat}」\n· ${her}：「${e.her}」`)
    out.push(['同一个意思，两种说法——照第二种说：', ...lines].join('\n'))
  }

  return out.join('\n')
}

/**
 * 用卡片自带的 `match` 规则识别模型。
 *
 * **为什么优先用卡片的规则而不是硬编码表**：卡片里的 `match` 是设定作者写的，
 * 加一个新模型只需要改数据，不用改代码。硬编码表只作兜底。
 *
 * @param {Array<any>} cards
 * @param {string|undefined} provider
 * @param {string|undefined} model
 * @returns {string|null} 命中的卡 id；未命中返回 null
 */
export function matchByCardRules(cards, provider, model) {
  const list = Array.isArray(cards) ? cards : []
  const p = String(provider ?? '').toLowerCase()
  const m = String(model ?? '').toLowerCase()
  if (!p && !m) return null

  for (const card of list) {
    const match = card?.match
    if (!match) continue
    const providers = Array.isArray(match.provider) ? match.provider.map((x) => String(x).toLowerCase()) : []
    const models = Array.isArray(match.model) ? match.model.map((x) => String(x).toLowerCase()) : []
    // provider 命中即可（provider 名比 model 名稳定得多）
    if (providers.some((name) => name && p.includes(name))) return card.id
    // provider 没命中时，用 model 里的关键词兜底（比如 provider 是某个代理名）
    if (models.some((name) => name && m.includes(name))) return card.id
  }
  return null
}
