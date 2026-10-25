/**
 * 挂件拖拽的纯几何层。
 *
 * 为什么单独抽一个模块：拖拽的手感全在「松手之后落在哪里」这几行算术上，
 * 而这部分在浏览器里根本没法测（要真的拿鼠标拖）。抽出来之后
 * 「拖到屏幕外」「贴边吸附」「拖一下就算点击吗」都能用断言钉住。
 *
 * 约定：坐标一律是**视口坐标**（`left` / `top`，单位 px），左上角为原点。
 */

/** 松手时距离边缘多近就吸附过去。24px 是 macOS 滚动条 + 手指抖动的折中。 */
export const SNAP_THRESHOLD = 24

/** 四周至少留出的空隙，免得挂件贴着屏幕边被裁掉一半。 */
export const EDGE_MARGIN = 8

/** 位移超过这个像素数才算「拖拽」而不是「点击」。 */
export const DRAG_THRESHOLD = 4

/**
 * 把位置夹进视口内。
 *
 * 两种情况必须处理，否则用户会丢挂件：
 *   - 窗口被拉小：之前存的坐标可能已经在视口外；
 *   - 外接屏拔掉：负坐标或超大坐标会让她出现在不存在的屏幕上。
 *
 * @param {{x: number, y: number}} position 期望位置
 * @param {{width: number, height: number}} size 挂件尺寸
 * @param {{width: number, height: number}} viewport 视口尺寸
 * @param {number} [margin] 贴边留出的空隙
 * @returns {{x: number, y: number}} 夹紧后的位置
 */
export function clampToViewport(position, size, viewport, margin = EDGE_MARGIN) {
  const maxX = Math.max(margin, viewport.width - size.width - margin)
  const maxY = Math.max(margin, viewport.height - size.height - margin)
  return {
    x: Math.min(Math.max(position.x, margin), maxX),
    y: Math.min(Math.max(position.y, margin), maxY),
  }
}

/**
 * 松手时吸附到最近的左右边缘。
 *
 * 只吸附左右，不吸附上下：上下吸附会让挂件跳到标题栏或输入框上，
 * 而那些位置是会变化的。左右吸附才是桌宠的习惯。
 *
 * @param {{x: number, y: number}} position 松手位置（已夹紧）
 * @param {{width: number}} size 挂件尺寸
 * @param {{width: number}} viewport 视口尺寸
 * @param {number} [threshold] 吸附距离
 * @returns {{position: {x: number, y: number}, edge: 'left'|'right'|null}}
 */
export function snapToEdge(position, size, viewport, threshold = SNAP_THRESHOLD) {
  const margin = EDGE_MARGIN
  const leftDistance = position.x - margin
  const rightDistance = viewport.width - (position.x + size.width) - margin
  if (leftDistance <= threshold && leftDistance <= rightDistance) {
    return { position: { x: margin, y: position.y }, edge: 'left' }
  }
  if (rightDistance <= threshold && rightDistance < leftDistance) {
    return { position: { x: Math.max(margin, viewport.width - size.width - margin), y: position.y }, edge: 'right' }
  }
  return { position: { x: position.x, y: position.y }, edge: null }
}

/**
 * 这次按下-抬起算拖拽还是算点击？
 *
 * 不区分的话，用户每次想把她挪个位置都会触发一句台词——越拖越吵。
 *
 * @param {{x: number, y: number}} start 按下位置
 * @param {{x: number, y: number}} end 当前/抬起位置
 * @param {number} [threshold] 阈值
 * @returns {boolean} true = 算拖拽
 */
export function isDragGesture(start, end, threshold = DRAG_THRESHOLD) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  return dx * dx + dy * dy > threshold * threshold
}

/**
 * 拖到左半屏时整个挂件镜像翻转（脸朝屏幕内侧）。
 *
 * 这是桌宠的通用做法：她站在左边就该往右看，否则和气泡方向相反，
 * 看起来像背对着用户说话。
 *
 * @param {number} x 当前左边缘
 * @param {number} width 挂件宽度
 * @param {number} viewportWidth 视口宽度
 * @returns {boolean} true = 需要水平翻转
 */
export function shouldFlip(x, width, viewportWidth) {
  return x + width / 2 < viewportWidth / 2
}

/**
 * 校验从本地偏好里读回来的坐标。
 *
 * 本地存储是可以被用户/旧版本写坏的，读回来先洗一遍：
 * NaN、Infinity、字符串、负值一律当作「没存过」，回落到默认角落。
 *
 * @param {unknown} value 从 localStorage 读到的值
 * @returns {{x: number, y: number} | null} 合法坐标，或 null
 */
export function normalizeStoredPosition(value) {
  if (!value || typeof value !== 'object') return null
  const x = value.x
  const y = value.y
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}
