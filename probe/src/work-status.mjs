/**
 * 工作态归约：把 DSH 的 `session/event` 压成挂件要显示的状态。
 *
 * 出处：PC2005-cloud/dsh-pet（MIT，commit 2026-10-19），文件 `src/host/work-status.ts`。
 * 本文件是**移植到纯 JS + 精简注释**，六档语义与三个判定逐条保持原样。
 *
 * 为什么抄它：这份归约里有三条是"踩过坑才写得出来"的，自己拍脑袋想不出来——
 *   1. turn/end 的 reason 决定终局，**aborted 必须清回空闲**，否则回合被打断后
 *      会永远卡在 working（原作者注释：当年"这一步正在进行中哦"挂死的根因）；
 *   2. **goal 续跑轮的 completed ≠ 任务完成**，中间轮只能算 result，不能庆祝；
 *   3. update_goal 的参数是 JSON 字符串，要解出 action 才能判断收尾语义。
 *
 * 档位：thinking / working / result / waiting / success / error
 * （比 `dsh-pet` 少了 vision/hungry 之类，那些是它自己的玩法，与本插件无关）
 */

/** 模型在等用户选答案时用的工具名。 */
export const USER_QUESTION_TOOL = 'ask_user_question'

/** 目标工具名；action=complete/blocked 表示本轮是该目标的收尾轮。 */
export const GOAL_UPDATE_TOOL = 'update_goal'

/**
 * 本轮 turn 级标志（不参与展示，只影响 turn/end 的终局语义）。
 * @typedef {{ goalRound?: boolean, closing?: 'complete'|'blocked'|null }} TurnContext
 */

/**
 * turn/end 的 reason.kind → 状态。
 * 注意末尾的"其余 → null"：aborted 等必须清回空闲，绝不能残留上一档。
 * @param {string} kind
 * @returns {'success'|'error'|'waiting'|null}
 */
export function turnEndState(kind) {
  if (kind === 'completed') return 'success'
  if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') return 'error'
  if (kind === 'blocked') return 'waiting' // 回合被阻塞，等用户确认
  return null
}

/**
 * 解析 update_goal 的参数（原始 JSON 字符串）→ 收尾动作；非法/非收尾 → null。
 * @param {string} args
 * @returns {'complete'|'blocked'|null}
 */
export function goalUpdateAction(args) {
  try {
    const o = JSON.parse(args)
    const action = String(o?.action ?? '')
    if (action === 'complete' || action === 'blocked') return action
  } catch {
    /* 非法 JSON：按未收尾处理 */
  }
  return null
}

/**
 * turn/end reason=completed 的终局判定。
 * @param {TurnContext|undefined} turn
 * @returns {'success'|'error'|'result'}
 */
export function completedState(turn) {
  if (!turn?.goalRound) return 'success'
  if (turn.closing === 'blocked') return 'error'
  if (turn.closing === 'complete') return 'success'
  return 'result' // 续跑轮中间轮：本轮完成 ≠ 整个任务完成，不庆祝
}

/**
 * 从一条会话事件压缩出工作状态；无变化/不关心返回 null。
 *
 * 事件形状取自 `session/event` 回调：`{ type, seq, time, data }`。
 * 注意字段是 **type**，历史上有人把 `kind` 当 type 用，导致 turn 边沿永不匹配。
 *
 * @param {{type?:string, data?:Record<string, any>}} event
 * @param {TurnContext} [turn]
 * @returns {'thinking'|'working'|'waiting'|'result'|'success'|'error'|null}
 */
export function reduceWorkStatus(event, turn) {
  switch (event?.type) {
    case 'turn/start':
      return 'thinking'
    case 'step/start':
      // 一轮里有多个 step；只有第一个 step 之前才算纯思考，其余交给 tool/message 事件。
      return null
    case 'tool/call': {
      const name = event.data?.name
      if (name === USER_QUESTION_TOOL) return 'waiting'
      return 'working'
    }
    case 'assistant/message':
      // 开始吐正文 = 从"思考/执行"转到"回答"
      return 'result'
    case 'turn/end': {
      const kind = event.data?.reason?.kind
      const state = turnEndState(kind)
      if (state !== 'success') return state
      return completedState(turn)
    }
    default:
      return null
  }
}

/**
 * 六档状态 → 挂件表情（与 `data/personas/*.json` 的 look 状态名对齐）。
 * 这张表是"状态机 ↔ 美术"的唯一接口，改表情只改这里。
 */
export const STATUS_TO_POSE = Object.freeze({
  thinking: 'thinking',
  working: 'working',
  waiting: 'startled', // 等用户确认：轻微一惊，提醒但不催促
  result: 'working',
  success: 'happy',
  error: 'annoyed',
})

/**
 * 把归约结果翻译成表情状态名；未知返回 idle。
 * @param {string|null|undefined} status
 */
export function poseOf(status) {
  if (!status) return 'idle'
  return STATUS_TO_POSE[status] ?? 'idle'
}
