/**
 * 气泡定位：把挂在角色上的浮层（气泡 / 状态卡 / 菜单）收敛进视口。
 *
 * 出处：vlln/whale-girl（MIT，commit 8e70c30，2026-10-19 拉取）
 *   文件 lib/client/overlay-placement.mjs
 * 本文件是**移植 + 改注释 + 补边界用例**，算法逐行保持原样。
 *
 * 为什么连这个都要抄：几何符号错误在浏览器里极难发现（气泡只是"看起来有点歪"），
 * 而原作者的注释记录了一个真实 issue——只比 `size.h` 会漏掉 `offsetY` 这一条窄带，
 * 导致"代码认为放得下、实际溢出 5px 被裁"。这种坑不值得我们再踩一次。
 *
 * 契约：入参全为数值/矩形，出参是可直接写进内联样式的字符串。零 DOM，可单测。
 *   - 纵向：优先请求的朝向；该侧空间不足且另一侧更宽裕时翻面。
 *     可用空间扣掉 offsetY（角色与浮层之间的间隙）与 margin。
 *   - 横向：浮层以角色中心居中；居中会越出视口时反向平移；比视口还宽时以视口居中。
 *   - left 用 calc(50% ± Npx) 表达位移，不用 transform——气泡入场动画的关键帧占用了 transform。
 *
 * @param {object} input
 * @param {{top:number,bottom:number,left:number,width:number}} input.rect 角色在视口中的位置
 * @param {{w:number,h:number}} input.viewport 视口尺寸
 * @param {{w:number,h:number}} input.size 浮层的实测尺寸
 * @param {boolean} input.above 请求的朝向：true = 角色上方
 * @param {number} [input.offsetY=0] 角色与浮层之间的间隙
 * @param {number} [input.margin=8] 与视口边缘保留的最小距离
 */
export function planOverlay({ rect, viewport, size, above, offsetY = 0, margin = 8 }) {
  // 浮层实际占 (rect.top - offsetY - size.h) … (rect.top - offsetY)（上方），
  // 或 (rect.bottom + offsetY) … (rect.bottom + offsetY + size.h)（下方），
  // 所以两侧可用空间都要扣掉 offsetY。
  const roomAbove = rect.top - margin - offsetY
  const roomBelow = viewport.h - rect.bottom - margin - offsetY

  // 纵向：请求的朝向放不下、且另一侧更宽裕 → 翻面（两侧都不足时取宽裕的一侧）。
  let up = above
  if (above && roomAbove < size.h && roomBelow > roomAbove) up = false
  else if (!above && roomBelow < size.h && roomAbove > roomBelow) up = true

  // 横向：居中位置 = 角色中心 ± 半宽；越界则平移回视口内（左右各留 margin）。
  const centerX = rect.left + rect.width / 2
  let dx = 0
  if (size.w >= viewport.w - margin * 2) dx = viewport.w / 2 - centerX // 比视口还宽：以视口居中
  else if (centerX - size.w / 2 < margin) dx = margin - centerX + size.w / 2
  else if (centerX + size.w / 2 > viewport.w - margin) dx = viewport.w - margin - centerX - size.w / 2

  const shift = Math.round(dx)
  return {
    up,
    top: up ? `-${offsetY}px` : `calc(100% + ${offsetY}px)`,
    transform: up ? 'translate(-50%, -100%)' : 'translateX(-50%)',
    left: shift === 0 ? '50%' : `calc(50% ${shift > 0 ? '+' : '-'} ${Math.abs(shift)}px)`,
  }
}
