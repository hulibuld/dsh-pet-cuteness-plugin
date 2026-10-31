/**
 * 设置页的共用原语（色板 / 标度 / 组件）。
 *
 * 为什么单独一个文件：设置页有 12 个卡片、几十个按钮和输入框，之前每一处都手写
 * 内联样式，于是同一个"次要文字"出现过四种灰度、同一类按钮有三种圆角。
 * 用户 2026-10-31 的返工意见（逐字）：「新增 client/src/ui.js，共用原语」，
 * 并给了三层清单：色板、标度、组件。
 *
 * 三条纪律（违反会退回到手写样式的状态）：
 *   1. **颜色只从 `C` 取**，不在组件里写 `rgba(...)` 字面量。C 的每一项形如
 *      `var(--dsw-alias-…, 深色兜底)`，宿主主题换色时自动跟随；深色兜底值
 *      是给"宿主没给变量"的场景用的（旧版宿主、单测假环境）。
 *   2. **尺寸只从 `UI_FONT` / `UI_SPACE` / `UI_RADIUS` 取**，四档间距、三档字号、四档圆角。
 *   3. **不碰 DOM、不读 window**：`h` 由调用方注入（浏览器半里就是 React.createElement），
 *      这样模块可以在 node 里直接被单测渲染，不需要 jsdom。
 *
 * 这一层只负责"长什么样"，不负责"取什么数据"——数据仍然由调用方传 props。
 */

/** 字号三档。15 用于页面标题，13 用于卡片标题/正文强调，11.5 用于说明与注释。 */
export const UI_FONT = { lg: 15, md: 13, sm: 11.5 }

/** 间距四档。s 用于行内小间隙，m 用于一行之内，l 用于卡片内边距，xl 用于页面留白。 */
export const UI_SPACE = { s: 6, m: 10, l: 16, xl: 24 }

/** 圆角四档。xs 用于徽标，sm 用于输入框/按钮，md 用于卡片，pill 用于胶囊。 */
export const UI_RADIUS = { xs: 4, sm: 8, md: 12, pill: 999 }

/** 深色主题判定：宿主 <html> 主题属性 → class → 系统偏好，读不到按深色。 */
export function isDarkTheme(env) {
  const scope = env || (typeof globalThis !== 'undefined' ? globalThis : {})
  try {
    const doc = scope.document
    const root = doc && doc.documentElement
    if (root) {
      const attr = root.getAttribute && root.getAttribute('data-theme')
      if (attr === 'dark') return true
      if (attr === 'light') return false
      const cls = typeof root.className === 'string' ? root.className : ''
      // class 里常见写成 theme-dark / dark-mode，所以把连字符也当边界。
      if (/(^|[\s-])dark([\s-]|$)/.test(cls)) return true
      if (/(^|[\s-])light([\s-]|$)/.test(cls)) return false
    }
    const mm = scope.matchMedia
    if (typeof mm === 'function') {
      const mql = mm('(prefers-color-scheme: dark)')
      if (mql && typeof mql.matches === 'boolean') return mql.matches
    }
  } catch {
    /* 读不到就按兜底走 */
  }
  return true
}

/** 色板：每项是"宿主变量 + 兜底值"，深/浅各一套兜底。 */
export function palette(dark) {
  const isDark = dark !== false
  const fallback = {
    text: isDark ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.88)',
    sub: isDark ? 'rgba(255,255,255,0.62)' : 'rgba(0,0,0,0.58)',
    faint: isDark ? 'rgba(255,255,255,0.42)' : 'rgba(0,0,0,0.38)',
    bg1: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
    bg2: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
    border: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)',
    border2: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.20)',
    accent: isDark ? '#8ab4ff' : '#2f6fdb',
    accentSoft: isDark ? 'rgba(138,180,255,0.16)' : 'rgba(47,111,219,0.12)',
    ok: isDark ? '#5fd18a' : '#1f8f4e',
    warn: isDark ? '#e8b84b' : '#8a6300',
    error: isDark ? '#ff6b6b' : '#c33a3a',
  }
  return {
    text: `var(--dsw-alias-label-primary, ${fallback.text})`,
    sub: `var(--dsw-alias-label-secondary, ${fallback.sub})`,
    faint: `var(--dsw-alias-label-tertiary, ${fallback.faint})`,
    bg1: `var(--dsw-alias-bg-layer-1, ${fallback.bg1})`,
    bg2: `var(--dsw-alias-bg-layer-2, ${fallback.bg2})`,
    border: `var(--dsw-alias-border-l1, ${fallback.border})`,
    border2: `var(--dsw-alias-border-l2, ${fallback.border2})`,
    accent: `var(--dsw-alias-brand-primary, ${fallback.accent})`,
    accentSoft: `var(--dsw-alias-brand-weak, ${fallback.accentSoft})`,
    ok: `var(--dsw-alias-label-success, ${fallback.ok})`,
    warn: `var(--dsw-alias-label-warning, ${fallback.warn})`,
    error: `var(--dsw-alias-label-error, ${fallback.error})`,
  }
}

/** 把"用户给的样式"盖在"我们算好的样式"上。空对象也是合法输入。 */
function merge(base, extra) {
  return extra && typeof extra === 'object' ? Object.assign({}, base, extra) : base
}

/**
 * 造一整套原语。浏览器半里 `h` 就是 `React.createElement`。
 *
 * @param {(type: any, props?: any, ...children: any[]) => any} h
 * @param {{ dark?: boolean, env?: object }} [options]
 * @returns {object} 含 C / FONT / SPACE / RADIUS 与十个组件
 */
export function makePrimitives(h, options) {
  if (typeof h !== 'function') throw new Error('makePrimitives 需要一个 createElement 实现')
  const opts = options && typeof options === 'object' ? options : {}
  const dark = typeof opts.dark === 'boolean' ? opts.dark : isDarkTheme(opts.env)
  const C = palette(dark)

  /** 页面外壳：限宽 + 纵向留白。设置面板本身就窄，限宽防大屏下被拉成一行长文。 */
  function Page(props) {
    const p = props || {}
    return h(
      'div',
      {
        style: merge(
          { maxWidth: 760, padding: `${UI_SPACE.s}px 0 ${UI_SPACE.l}px`, color: C.text },
          p.style,
        ),
      },
      p.children,
    )
  }

  /** 页头：标题 + 一句说明 + 右侧动作。说明必须短（用户要求「别写长」）。 */
  function PageHeader(props) {
    const p = props || {}
    const hasSub = typeof p.subtitle === 'string' && p.subtitle.length > 0
    return h(
      'div',
      { style: { padding: `2px 0 ${UI_SPACE.m}px` } },
      h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: UI_SPACE.m,
          },
        },
        h('div', { style: { fontSize: UI_FONT.lg, fontWeight: 600, color: C.text } }, p.title),
        p.right ? h('div', { style: { flex: '0 0 auto' } }, p.right) : null,
      ),
      hasSub
        ? h(
            'div',
            { style: { marginTop: 2, fontSize: UI_FONT.sm, lineHeight: 1.6, color: C.sub } },
            p.subtitle,
          )
        : null,
    )
  }

  /** 卡片：一块带边框的面板，标题可选。卡片之间靠 marginTop 拉开，不用额外包裹层。 */
  function Card(props) {
    const p = props || {}
    const title = p.title
    const sub = p.subtitle
    return h(
      'section',
      {
        style: merge(
          {
            marginTop: UI_SPACE.m,
            padding: `${UI_SPACE.s}px ${UI_SPACE.l - 4}px ${UI_SPACE.m}px`,
            border: `1px solid ${C.border2}`,
            borderRadius: UI_RADIUS.md,
            background: C.bg1,
          },
          p.style,
        ),
      },
      title
        ? h(
            'div',
            {
              style: {
                fontSize: UI_FONT.md,
                fontWeight: 600,
                margin: `${UI_SPACE.s}px 0 2px`,
                color: C.sub,
              },
            },
            title,
          )
        : null,
      typeof sub === 'string' && sub
        ? h(
            'div',
            { style: { fontSize: UI_FONT.sm, lineHeight: 1.6, color: C.faint } },
            sub,
          )
        : null,
      p.children,
    )
  }

  const BUTTON_VARIANTS = {
    primary: { background: C.accent, color: '#fff', border: `1px solid ${C.accent}` },
    secondary: { background: C.bg2, color: C.text, border: `1px solid ${C.border2}` },
    ghost: { background: 'transparent', color: C.sub, border: '1px solid transparent' },
    danger: { background: 'transparent', color: C.error, border: `1px solid ${C.error}` },
  }

  /** 按钮：四种意图。尺寸只有一种（小），因为设置页里没有主行动按钮的余地。 */
  function Button(props) {
    const p = props || {}
    const variant = BUTTON_VARIANTS[p.variant] ? p.variant : 'secondary'
    const look = BUTTON_VARIANTS[variant]
    return h(
      'button',
      {
        type: p.type || 'button',
        disabled: p.disabled === true,
        title: p.title,
        onClick: p.onClick,
        'aria-label': p.ariaLabel,
        style: merge(
          {
            padding: '4px 10px',
            fontSize: UI_FONT.sm,
            lineHeight: 1.5,
            borderRadius: UI_RADIUS.sm,
            cursor: p.disabled === true ? 'not-allowed' : 'pointer',
            opacity: p.disabled === true ? 0.5 : 1,
            background: look.background,
            color: look.color,
            border: look.border,
          },
          p.style,
        ),
      },
      p.children,
    )
  }

  /** 开关。用 role="switch"：读屏器会念"开/关"，与宿主其它开关一致。 */
  function Switch(props) {
    const p = props || {}
    const on = p.checked === true
    return h(
      'button',
      {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': p.ariaLabel,
        disabled: p.disabled === true,
        onClick: p.onChange,
        style: merge(
          {
            display: 'inline-flex',
            alignItems: 'center',
            gap: UI_SPACE.s,
            padding: '2px 0',
            border: 'none',
            background: 'transparent',
            color: on ? C.text : C.sub,
            fontSize: UI_FONT.sm,
            cursor: p.disabled === true ? 'not-allowed' : 'pointer',
            opacity: p.disabled === true ? 0.5 : 1,
          },
          p.style,
        ),
      },
      h('span', {
        'aria-hidden': 'true',
        style: {
          width: 26,
          height: 15,
          borderRadius: UI_RADIUS.pill,
          background: on ? C.accent : C.bg2,
          border: `1px solid ${on ? C.accent : C.border2}`,
          position: 'relative',
          transition: 'background 120ms ease',
          flex: '0 0 auto',
        },
      }),
      p.label ? h('span', null, p.label) : null,
    )
  }

  /** 单行输入。数字用 `type="number"`，其余一律文本。 */
  function Input(props) {
    const p = props || {}
    return h('input', {
      type: p.type || 'text',
      value: p.value === undefined || p.value === null ? '' : String(p.value),
      placeholder: p.placeholder,
      disabled: p.disabled === true,
      inputMode: p.inputMode,
      'aria-label': p.ariaLabel,
      onChange: p.onChange,
      onKeyDown: p.onKeyDown,
      style: merge(
        {
          padding: '4px 8px',
          fontSize: UI_FONT.sm,
          lineHeight: 1.5,
          borderRadius: UI_RADIUS.sm,
          border: `1px solid ${C.border2}`,
          background: C.bg2,
          color: C.text,
          minWidth: p.wide === true ? 200 : 0,
        },
        p.style,
      ),
    })
  }

  /** 下拉。`options` 形如 `[{ value, label }]`。 */
  function Select(props) {
    const p = props || {}
    const list = Array.isArray(p.options) ? p.options : []
    return h(
      'select',
      {
        value: p.value === undefined || p.value === null ? '' : String(p.value),
        disabled: p.disabled === true,
        'aria-label': p.ariaLabel,
        onChange: p.onChange,
        style: merge(
          {
            padding: '4px 6px',
            fontSize: UI_FONT.sm,
            lineHeight: 1.5,
            borderRadius: UI_RADIUS.sm,
            border: `1px solid ${C.border2}`,
            background: C.bg2,
            color: C.text,
          },
          p.style,
        ),
      },
      list.map((item) =>
        h('option', { key: String(item.value), value: String(item.value) }, item.label),
      ),
    )
  }

  const BADGE_TONES = {
    info: { bg: C.accentSoft, fg: C.accent },
    ok: { bg: C.bg2, fg: C.ok },
    warn: { bg: C.bg2, fg: C.warn },
    error: { bg: C.bg2, fg: C.error },
    plain: { bg: C.bg2, fg: C.sub },
  }

  /** 小徽标：显示"已开启/未生效/上限 20"这类短状态。 */
  function Badge(props) {
    const p = props || {}
    const tone = BADGE_TONES[p.tone] ? p.tone : 'plain'
    const look = BADGE_TONES[tone]
    return h(
      'span',
      {
        style: merge(
          {
            display: 'inline-block',
            padding: '1px 6px',
            fontSize: UI_FONT.sm,
            lineHeight: 1.6,
            borderRadius: UI_RADIUS.xs,
            background: look.bg,
            color: look.fg,
            whiteSpace: 'nowrap',
          },
          p.style,
        ),
      },
      p.children,
    )
  }

  const NOTE_TONES = { info: 'sub', ok: 'ok', warn: 'warn', error: 'error', faint: 'faint' }

  /** 说明文字：一行小字，可选语义色。比 Badge 长、比正文弱。 */
  function Note(props) {
    const p = props || {}
    const key = NOTE_TONES[p.tone] || 'sub'
    return h(
      'div',
      {
        role: p.tone === 'error' ? 'alert' : undefined,
        style: merge(
          { fontSize: UI_FONT.sm, lineHeight: 1.6, color: C[key] },
          p.style,
        ),
      },
      p.children,
    )
  }

  /** 表单一行：左边标签（固定宽），右边控件，下面可挂一句提示。 */
  function Field(props) {
    const p = props || {}
    return h(
      'div',
      { style: merge({ display: 'flex', alignItems: 'center', gap: UI_SPACE.m, marginTop: UI_SPACE.s }, p.style) },
      p.label
        ? h(
            'label',
            {
              htmlFor: p.htmlFor,
              style: {
                flex: '0 0 auto',
                minWidth: p.labelWidth || 88,
                fontSize: UI_FONT.sm,
                color: C.sub,
              },
            },
            p.label,
          )
        : null,
      h(
        'div',
        { style: { flex: '1 1 auto', minWidth: 0 } },
        p.children,
        p.hint
          ? h(
              'div',
              { style: { marginTop: 2, fontSize: UI_FONT.sm, lineHeight: 1.6, color: C.faint } },
              p.hint,
            )
          : null,
      ),
    )
  }

  return {
    C,
    palette: C,
    FONT: UI_FONT,
    SPACE: UI_SPACE,
    RADIUS: UI_RADIUS,
    dark,
    Page,
    PageHeader,
    Card,
    Button,
    Switch,
    Input,
    Select,
    Badge,
    Note,
    Field,
  }
}
