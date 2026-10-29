import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EDGE_MARGIN,
  SNAP_THRESHOLD,
  DRAG_THRESHOLD,
  clampToViewport,
  snapToEdge,
  isDragGesture,
  shouldFlip,
  normalizeStoredPosition,
} from '../src/drag-position.mjs'

const SIZE = { width: 52, height: 52 }
const VIEWPORT = { width: 1440, height: 900 }

test('clampToViewport：正常位置原样返回', () => {
  assert.deepEqual(clampToViewport({ x: 500, y: 300 }, SIZE, VIEWPORT), { x: 500, y: 300 })
})

test('clampToViewport：负坐标被推回边缘留白内', () => {
  assert.deepEqual(clampToViewport({ x: -300, y: -80 }, SIZE, VIEWPORT), { x: EDGE_MARGIN, y: EDGE_MARGIN })
})

test('clampToViewport：超出右下角被拉回视口内（窗口被拉小的场景）', () => {
  assert.deepEqual(clampToViewport({ x: 9999, y: 9999 }, SIZE, VIEWPORT), {
    x: VIEWPORT.width - SIZE.width - EDGE_MARGIN,
    y: VIEWPORT.height - SIZE.height - EDGE_MARGIN,
  })
})

test('clampToViewport：视口比挂件还小时不产生负区间', () => {
  // 极端情况：用户把窗口缩到 40x40。max 必须退化成 margin，否则 min>max 会算出负数。
  const tiny = { width: 40, height: 40 }
  const result = clampToViewport({ x: 100, y: 100 }, SIZE, tiny)
  assert.equal(result.x, EDGE_MARGIN)
  assert.equal(result.y, EDGE_MARGIN)
})

test('snapToEdge：靠近左边吸到左边', () => {
  const result = snapToEdge({ x: EDGE_MARGIN + 10, y: 300 }, SIZE, VIEWPORT)
  assert.equal(result.edge, 'left')
  assert.equal(result.position.x, EDGE_MARGIN)
  assert.equal(result.position.y, 300, '吸附只动 x，不动 y')
})

test('snapToEdge：靠近右边吸到右边', () => {
  const x = VIEWPORT.width - SIZE.width - EDGE_MARGIN - 10
  const result = snapToEdge({ x, y: 300 }, SIZE, VIEWPORT)
  assert.equal(result.edge, 'right')
  assert.equal(result.position.x, VIEWPORT.width - SIZE.width - EDGE_MARGIN)
})

test('snapToEdge：屏幕中间不吸附', () => {
  const result = snapToEdge({ x: 700, y: 400 }, SIZE, VIEWPORT)
  assert.equal(result.edge, null)
  assert.deepEqual(result.position, { x: 700, y: 400 })
})

test('snapToEdge：超过阈值就不吸（免得轻轻一拖就被拽到边上）', () => {
  const result = snapToEdge({ x: EDGE_MARGIN + SNAP_THRESHOLD + 1, y: 300 }, SIZE, VIEWPORT)
  assert.equal(result.edge, null)
})

test('isDragGesture：微小抖动算点击', () => {
  assert.equal(isDragGesture({ x: 100, y: 100 }, { x: 101, y: 102 }), false)
})

test('isDragGesture：超过阈值算拖拽', () => {
  assert.equal(isDragGesture({ x: 100, y: 100 }, { x: 100 + DRAG_THRESHOLD + 2, y: 100 }), true)
})

test('isDragGesture：原地不动算点击', () => {
  assert.equal(isDragGesture({ x: 100, y: 100 }, { x: 100, y: 100 }), false)
})

test('shouldFlip：在左半屏要翻转', () => {
  assert.equal(shouldFlip(10, 52, 1440), true)
})

test('shouldFlip：在右半屏不翻转', () => {
  assert.equal(shouldFlip(1300, 52, 1440), false)
})

test('shouldFlip：跨中线时按中心点判定，不按左边缘', () => {
  // 中心正好在中线右边一点点
  assert.equal(shouldFlip(720 - 20, 52, 1440), false)
  // 中心在中线左边一点点
  assert.equal(shouldFlip(720 - 30, 52, 1440), true)
})

test('normalizeStoredPosition：合法值原样返回', () => {
  assert.deepEqual(normalizeStoredPosition({ x: 10, y: 20 }), { x: 10, y: 20 })
})

test('normalizeStoredPosition：NaN / Infinity 当作没存过', () => {
  assert.equal(normalizeStoredPosition({ x: NaN, y: 20 }), null)
  assert.equal(normalizeStoredPosition({ x: 10, y: Infinity }), null)
})

test('normalizeStoredPosition：字符串坐标当作没存过（旧版本可能写进去过）', () => {
  assert.equal(normalizeStoredPosition({ x: '10', y: '20' }), null)
})

test('normalizeStoredPosition：null / 数组 / 非对象都返回 null', () => {
  assert.equal(normalizeStoredPosition(null), null)
  assert.equal(normalizeStoredPosition(undefined), null)
  assert.equal(normalizeStoredPosition({}), null)
  assert.equal(normalizeStoredPosition(42), null)
})
