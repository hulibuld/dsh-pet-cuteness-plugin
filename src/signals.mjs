/**
 * 轻量信号：从**用户刚发的那句话**里读一个桶名。
 *
 * 为什么需要它：`praise` 桶有 126 句（15 人 × 约 8 句），内容是全项目最像"人"的一批
 * （「我会更努力的」「那我要更努力才行」——正是 deepseek 卡里 `fear: 被说不够聪明` 的台词化），
 * 但 12 类触发里**没有一条会产出 praise**。台词写得再好，没触发就是死代码。
 *
 * 设计纪律（沿用设计方案 §5.2 的「只读轻量信号」）：
 *   - **只读最近一条用户消息**，不读全文、不读工具输出、不存原文。
 *   - **只做正则判定，不调用模型**（调模型 = 每条消息都多一次请求，成本不可控）。
 *   - 判定失败一律返回 null，让调用方退回状态驱动。
 *
 * 这一层刻意做得"笨"：宁可漏判（少一次共鸣），也不要误判（用户没夸她，她突然害羞，很尬）。
 */

/** 夸奖：这些词出现时她应该有点不好意思。 */
const PRAISE = [
  /谢谢(你|啦|了)?/,
  /谢了/,
  /厉害/,
  /好用/,
  /不错/,
  /很棒|真棒|太棒/,
  /好的呀/,
  /辛苦了|辛苦啦/,
  /帮大忙|帮了大忙/,
  /牛(啊|呀|哇)?(?![奶排仔])/,
  /靠谱/,
]

/** 道歉/安慰：她该软一点，而不是邀功。 */
const APOLOGY = [/对不起|抱歉|不好意思|是我错|我弄错/]

/** 夸她「聪明」是最容易触发 fear 的一句，单独拎出来。 */
const SMART = [/聪明/, /机灵/, /厉害/, /比不上/, /不如你/]

/**
 * 从一条用户消息里读桶名。
 *
 * @param {string|undefined|null} text 用户刚发的消息（纯文本）
 * @returns {string|null} 命中的桶名；没命中返回 null
 */
export function bucketFromUserMessage(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  // 超长消息多半是在贴代码/日志，里面的 "不错"/"谢谢" 是噪声，不做情绪判定。
  if (text.length > 400) return null

  const trimmed = text.trim()
  if (trimmed.length === 0) return null

  // 顺序有意义：先说"对不起"的时候不该被当成夸奖。
  if (APOLOGY.some((re) => re.test(trimmed))) return 'headpat'
  // 夸聪明 → praise（她的 fear 就在这里，反应最强）
  if (SMART.some((re) => re.test(trimmed))) return 'praise'
  if (PRAISE.some((re) => re.test(trimmed))) return 'praise'
  return null
}

/**
 * 判断一条用户消息是不是「在问问题」——用于让她少在这种时候插话。
 * 只做粗判：有问号，或以疑问词开头。
 * @param {string|undefined|null} text
 * @returns {boolean}
 */
export function looksLikeQuestion(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  if (/[?？]/.test(text)) return true
  return /^(怎么|为什么|为啥|如何|什么|哪|谁|多少|能不能|可不可以|是不是)/.test(text.trim())
}
