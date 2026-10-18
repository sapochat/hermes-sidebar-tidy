/**
 * Sidebar Tidy v1.0
 *
 * Hide, auto-hide and reorder parts of the Hermes Desktop sidebar.
 *
 * Two layers, chosen by what the SDK actually sanctions:
 *   - Nav rows (New session, Messaging, Artifacts, Scheduled jobs, plugin rows)
 *     go through the official `sidebarNav.prefs` contribution: core does the
 *     hiding/ordering, and disabling the plugin brings every row back.
 *   - Session sections (Pinned, Sessions, messaging platforms, Cron jobs),
 *     the search field and the profile rail have no SDK seam yet, so they are
 *     identified in the DOM and hidden with one injected stylesheet. The
 *     classifier fails OPEN: anything it cannot identify stays visible.
 *
 * Extras: "When not empty" mode for Pinned, keyboard-only search, a focus
 * mode (⌘⌥B / Ctrl+Alt+B), and hold ⌥/Alt over the sidebar to peek at
 * whatever is hidden.
 */

import {
  atom,
  Button,
  Codicon,
  cn,
  haptic,
  host,
  KEYBINDS_AREA,
  ListRow,
  PALETTE_AREA,
  pluginSettingsHref,
  SegmentedControl,
  SIDEBAR_NAV_PREFS_AREA,
  STATUSBAR_AREAS,
  Switch,
  Tip,
  ToggleRow,
  translateNow,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'sidebar-tidy'
const VERSION = '1.0.0'
const SIDEBAR = '[data-tour="sessions-sidebar"]'
const CONTENT_CHILD = '[data-sidebar="content"] > *'
const PIN_STORAGE_KEY = 'hermes.desktop.pinnedSessions'
const STYLE_ID = 'sidebar-tidy-style'
const CORE_NAV = ['new-session', 'capabilities', 'messaging', 'artifacts', 'cron']
// Core refuses to hide this row: it hosts the Plugins tab (the off-switch).
const NEVER_HIDE = new Set(['capabilities'])
const MARK_ATTRS = ['data-sbt-section', 'data-sbt-hidden', 'data-sbt-search', 'data-sbt-has-value']

const DEFAULT_CONFIG = {
  v: 1,
  sections: {
    pinned: 'auto', // show | auto | hide
    sessions: 'show', // show | hide
    search: 'show', // show | keys | hide
    cron: 'show', // show | hide
    profileRail: 'show' // show | hide
  },
  messagingAll: 'show', // show | hide
  messaging: {}, // { [platform label]: 'hide' }
  nav: { hide: [], order: [] },
  focus: false
}

const FOCUS_SECTIONS = { pinned: 'auto', search: 'keys', cron: 'hide', profileRail: 'hide' }

// ─── state ──────────────────────────────────────────────────────────────────

const $config = atom(DEFAULT_CONFIG)
// What the classifier saw on the last pass — drives the settings page's
// "not on screen" hints, and remembers nav rows / platforms that are hidden.
const $seen = atom({ nav: [], platforms: [], present: {} })

let api = null // { ctx, update }

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const nav = cfg.nav && typeof cfg.nav === 'object' ? cfg.nav : {}
  const strings = list => (Array.isArray(list) ? list.filter(id => typeof id === 'string' && id) : [])

  return {
    ...DEFAULT_CONFIG,
    sections: { ...DEFAULT_CONFIG.sections, ...(cfg.sections || {}) },
    messagingAll: cfg.messagingAll === 'hide' ? 'hide' : 'show',
    messaging: cfg.messaging && typeof cfg.messaging === 'object' ? { ...cfg.messaging } : {},
    nav: { hide: strings(nav.hide), order: strings(nav.order) },
    focus: Boolean(cfg.focus)
  }
}

/** Focus mode overlays the saved config without overwriting it. */
function effectiveConfig(cfg = $config.get(), seen = $seen.get()) {
  if (!cfg.focus) {
    return cfg
  }

  const allNav = knownNav(seen).map(row => row.id)

  return {
    ...cfg,
    sections: { ...cfg.sections, ...FOCUS_SECTIONS },
    messagingAll: 'hide',
    nav: { order: cfg.nav.order, hide: allNav.filter(id => id !== 'new-session' && !NEVER_HIDE.has(id)) }
  }
}

function t(key, fallback) {
  try {
    const value = translateNow(key)

    return value && value !== key ? value : fallback
  } catch {
    return fallback
  }
}

function labels() {
  return {
    pinned: t('sidebar.pinned', 'Pinned'),
    cronJobs: t('sidebar.cronJobs', 'Cron jobs'),
    results: t('sidebar.results', 'Results'),
    searchAria: t('sidebar.searchAria', 'Search sessions')
  }
}

function navLabel(id) {
  return CORE_NAV.includes(id) ? t(`sidebar.nav.${id}`, id) : id
}

/** Every nav row we know about, in the user's order then discovery order. */
function knownNav(seen = $seen.get(), cfg = $config.get()) {
  const byId = new Map()

  for (const id of CORE_NAV) {
    byId.set(id, { id, label: navLabel(id) })
  }

  for (const row of seen.nav) {
    byId.set(row.id, { ...byId.get(row.id), ...row })
  }

  const ordered = []

  for (const id of cfg.nav.order) {
    if (byId.has(id)) {
      ordered.push(byId.get(id))
      byId.delete(id)
    }
  }

  return [...ordered, ...byId.values()]
}

// ─── pinned count (for "When not empty" while the section is collapsed) ────

let connections = { at: 0, list: null }

function refreshConnections() {
  if (Date.now() - connections.at < 60_000 || typeof host.connections !== 'function') {
    return
  }

  connections.at = Date.now()
  host
    .connections()
    .then(list => {
      connections.list = Array.isArray(list) ? list : null
    })
    .catch(() => undefined)
}

function readPinList(key) {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || '[]')

    return Array.isArray(value) ? value.length : 0
  } catch {
    return 0
  }
}

/** Number of pins for the active connection, or null when it can't be told. */
function storedPinCount() {
  let keys = []

  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)

      if (key === PIN_STORAGE_KEY || key?.startsWith(`${PIN_STORAGE_KEY}.remote.`)) {
        keys.push(key)
      }
    }
  } catch {
    return null
  }

  if (keys.length === 0) {
    return 0
  }

  refreshConnections()

  const activeId = typeof host.activeConnectionId === 'function' ? host.activeConnectionId() : null
  let key = null

  if (!activeId || activeId === 'local') {
    key = keys.includes(PIN_STORAGE_KEY) ? PIN_STORAGE_KEY : null
  } else {
    const url = connections.list?.find(c => c?.id === activeId)?.url

    if (url) {
      const variants = [url, url.replace(/\/+$/, ''), `${url.replace(/\/+$/, '')}/`]
      key = variants.map(u => `${PIN_STORAGE_KEY}.remote.${encodeURIComponent(u)}`).find(k => keys.includes(k)) || null
    }
  }

  if (!key && keys.length === 1) {
    key = keys[0]
  }

  if (key) {
    return readPinList(key)
  }

  // Ambiguous: only call it empty when every connection's pin list is empty.
  return keys.some(k => readPinList(k) > 0) ? null : 0
}

// ─── classifier + marks ─────────────────────────────────────────────────────

let marked = new Set()

function clearMarks(el) {
  for (const attr of MARK_ATTRS) {
    el.removeAttribute(attr)
  }
}

function setAttr(el, name, value) {
  if (value === null || value === false || value === undefined) {
    if (el.hasAttribute(name)) {
      el.removeAttribute(name)
    }
  } else if (el.getAttribute(name) !== String(value)) {
    el.setAttribute(name, String(value))
  }
}

function sectionLabel(group) {
  const header = group.firstElementChild

  return header?.querySelector('.uppercase .truncate')?.textContent?.trim() ?? ''
}

function classifyGroup(group, L) {
  const header = group.firstElementChild
  const label = sectionLabel(group)

  if (!header || !label) {
    return null
  }

  if (label === L.results) {
    return { kind: 'results', label }
  }

  if (label === L.pinned) {
    return { kind: 'pinned', label }
  }

  if (label === L.cronJobs) {
    return { kind: 'cron', label }
  }

  // Messaging platform headers carry a platform avatar chip before the label.
  if (header.querySelector('.inline-grid')) {
    return { kind: 'messaging', label }
  }

  return { kind: 'sessions', label }
}

function pinnedIsEmpty(group) {
  const open = Boolean(group.querySelector('[data-slot="sidebar-group-content"]'))

  if (open) {
    return group.querySelectorAll('.row-hover').length === 0
  }

  return storedPinCount() === 0
}

function pass() {
  const root = document.querySelector(SIDEBAR)

  if (!root) {
    return
  }

  const cfg = effectiveConfig()
  const L = labels()
  const next = new Set()
  const present = {}
  const navSeen = []
  const platforms = []

  const mark = (el, section, hidden) => {
    next.add(el)
    setAttr(el, 'data-sbt-section', section)
    setAttr(el, 'data-sbt-hidden', hidden ? '' : null)
  }

  // Nav rows: core hides them for us; we only remember ids + labels.
  for (const el of root.querySelectorAll('[data-tour^="sidebar-nav-"]')) {
    const id = el.getAttribute('data-tour').slice('sidebar-nav-'.length)
    const label = el.textContent?.trim() || id

    if (id) {
      navSeen.push({ id, label })
    }
  }

  // Search field.
  const input = root.querySelector(`input[aria-label="${CSS.escape(L.searchAria)}"]`)
  const searchWrap = input?.closest(CONTENT_CHILD)

  if (searchWrap) {
    const mode = cfg.sections.search
    present.search = true
    mark(searchWrap, 'search', mode === 'hide' && !input.value)
    setAttr(searchWrap, 'data-sbt-search', mode === 'keys' ? 'keys' : null)
    setAttr(searchWrap, 'data-sbt-has-value', input.value ? '' : null)
  }

  // Session sections.
  for (const group of root.querySelectorAll('[data-sessions-mode] > [data-slot="sidebar-group"]')) {
    const info = classifyGroup(group, L)

    if (!info) {
      continue
    }

    let hidden = false

    if (info.kind === 'pinned') {
      present.pinned = true
      const mode = cfg.sections.pinned
      hidden = mode === 'hide' || (mode === 'auto' && pinnedIsEmpty(group))
    } else if (info.kind === 'sessions') {
      present.sessions = true
      hidden = cfg.sections.sessions === 'hide'
    } else if (info.kind === 'cron') {
      present.cron = true
      hidden = cfg.sections.cron === 'hide'
    } else if (info.kind === 'messaging') {
      platforms.push(info.label)
      hidden = cfg.messagingAll === 'hide' || cfg.messaging[info.label] === 'hide'
    }

    mark(group, info.kind === 'messaging' ? `messaging:${info.label}` : info.kind, hidden)
  }

  // Profile rail.
  const rail = root.querySelector('[data-slot="profile-rail"]')?.closest(CONTENT_CHILD)

  if (rail) {
    present.profileRail = true
    mark(rail, 'profile-rail', cfg.sections.profileRail === 'hide')
  }

  for (const el of marked) {
    if (!next.has(el)) {
      clearMarks(el)
    }
  }

  marked = next
  rememberSeen(navSeen, platforms, present)
}

function rememberSeen(navSeen, platforms, present) {
  const prev = $seen.get()
  const nav = [...prev.nav]

  for (const row of navSeen) {
    const at = nav.findIndex(r => r.id === row.id)

    if (at === -1) {
      nav.push(row)
    } else if (nav[at].label !== row.label) {
      nav[at] = row
    }
  }

  const allPlatforms = [...new Set([...prev.platforms, ...platforms])]
  const next = { nav, platforms: allPlatforms, present }

  if (JSON.stringify(next) !== JSON.stringify(prev)) {
    $seen.set(next)
    api?.ctx.storage.set('seen', { nav, platforms: allPlatforms })
  }
}

// ─── styles ─────────────────────────────────────────────────────────────────

const CSS_TEXT = `
html:not([data-sbt-peek]) ${SIDEBAR} [data-sbt-hidden],
html[data-sbt-peek] ${SIDEBAR}:not(:hover) [data-sbt-hidden] {
  display: none !important;
}
html[data-sbt-peek] ${SIDEBAR}:hover [data-sbt-hidden] {
  opacity: 0.42;
  outline: 1px dashed var(--ui-stroke-secondary, currentColor);
  outline-offset: -1px;
  border-radius: 6px;
}
${SIDEBAR} [data-sbt-search="keys"] {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  transition: max-height 140ms ease, opacity 120ms ease, padding 140ms ease;
}
${SIDEBAR} [data-sbt-search="keys"]:focus-within,
${SIDEBAR} [data-sbt-search="keys"][data-sbt-has-value],
html[data-sbt-peek] ${SIDEBAR}:hover [data-sbt-search="keys"] {
  max-height: 2.75rem;
  opacity: 1;
  padding-top: 0.25rem !important;
  padding-bottom: 0.25rem !important;
}
`

function installStyle() {
  document.getElementById(STYLE_ID)?.remove()
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS_TEXT
  document.head.appendChild(style)

  return () => style.remove()
}

// ─── config mutations ───────────────────────────────────────────────────────

function setSection(key, value) {
  api?.update(cfg => ({ ...cfg, sections: { ...cfg.sections, [key]: value } }))
}

function setFocus(on) {
  api?.update(cfg => ({ ...cfg, focus: on }))
  host.notify({
    kind: 'info',
    message: on ? 'Sidebar focus mode on' : 'Sidebar focus mode off',
    durationMs: 1800
  })
}

function showEverything() {
  api?.update(cfg => ({
    ...cfg,
    sections: { pinned: 'show', sessions: 'show', search: 'show', cron: 'show', profileRail: 'show' },
    messagingAll: 'show',
    messaging: {},
    nav: { hide: [], order: cfg.nav.order },
    focus: false
  }))
}

function applyTidy() {
  api?.update(cfg => ({
    ...cfg,
    sections: { ...cfg.sections, pinned: 'auto', search: 'keys' },
    focus: false
  }))
}

function toggleNavHidden(id) {
  if (NEVER_HIDE.has(id)) {
    return
  }

  api?.update(cfg => {
    const hide = new Set(cfg.nav.hide)
    hide.has(id) ? hide.delete(id) : hide.add(id)

    return { ...cfg, nav: { ...cfg.nav, hide: [...hide] } }
  })
}

function moveNav(id, delta) {
  api?.update(cfg => {
    const order = knownNav($seen.get(), cfg).map(row => row.id)
    const from = order.indexOf(id)
    const to = from + delta

    if (from < 0 || to < 0 || to >= order.length) {
      return cfg
    }

    order.splice(to, 0, ...order.splice(from, 1))

    return { ...cfg, nav: { ...cfg.nav, order } }
  })
}

function setPlatformHidden(label, hidden) {
  api?.update(cfg => {
    const messaging = { ...cfg.messaging }
    hidden ? (messaging[label] = 'hide') : delete messaging[label]

    return { ...cfg, messaging }
  })
}

// ─── settings page ──────────────────────────────────────────────────────────

const PINNED_OPTIONS = [
  { id: 'show', label: 'Always' },
  { id: 'auto', label: 'When not empty' },
  { id: 'hide', label: 'Hidden' }
]
const SEARCH_OPTIONS = [
  { id: 'show', label: 'Shown' },
  { id: 'keys', label: 'Keyboard only' },
  { id: 'hide', label: 'Hidden' }
]
const BINARY_OPTIONS = [
  { id: 'show', label: 'Shown' },
  { id: 'hide', label: 'Hidden' }
]

function Heading({ children }) {
  return jsx('h3', {
    className: 'mb-1 mt-6 text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-(--ui-text-tertiary)',
    children
  })
}

function offscreen(present, key) {
  return present[key] ? undefined : 'Not on screen right now; the setting applies when it appears.'
}

function SectionRow({ title, description, value, options, onChange }) {
  return jsx(ListRow, {
    title,
    description,
    action: jsx(SegmentedControl, { options, value, onChange: id => (haptic('selection'), onChange(id)) })
  })
}

function NavRow({ row, index, count, hidden, locked, focusLocked }) {
  const iconButton = (icon, label, onClick, disabled) =>
    jsx(Tip, {
      label,
      children: jsx(Button, {
        'aria-label': label,
        disabled,
        onClick,
        size: 'icon-xs',
        variant: 'ghost',
        children: jsx(Codicon, { name: icon, size: '0.75rem' })
      })
    })

  return jsx(ListRow, {
    title: row.label,
    description: locked
      ? 'Always shown: it hosts Settings → Plugins, the off-switch for this plugin.'
      : focusLocked
        ? 'Hidden by focus mode.'
        : undefined,
    action: jsxs('div', {
      className: 'flex items-center gap-1',
      children: [
        iconButton('arrow-up', `Move ${row.label} up`, () => moveNav(row.id, -1), index === 0),
        iconButton('arrow-down', `Move ${row.label} down`, () => moveNav(row.id, 1), index === count - 1),
        jsx(Switch, {
          'aria-label': `Show ${row.label}`,
          checked: !hidden,
          disabled: locked,
          onCheckedChange: () => (haptic('selection'), toggleNavHidden(row.id))
        })
      ]
    })
  })
}

function SettingsPage() {
  const cfg = useValue($config)
  const seen = useValue($seen)
  const eff = effectiveConfig(cfg, seen)
  const present = seen.present || {}
  const nav = knownNav(seen, cfg)
  const disabledByFocus = cfg.focus

  return jsxs('div', {
    className: 'max-w-3xl pb-10',
    children: [
      jsx('p', {
        className: 'text-xs text-(--ui-text-secondary)',
        children:
          'Choose what the sidebar shows. Hold ⌥ Option / Alt with the pointer over the sidebar to peek at hidden parts. ' +
          'Disabling this plugin brings everything back.'
      }),
      jsxs('div', {
        className: 'mt-3 flex flex-wrap gap-2',
        children: [
          jsx(Button, { onClick: showEverything, size: 'sm', variant: 'outline', children: 'Show everything' }),
          jsx(Button, { onClick: applyTidy, size: 'sm', variant: 'outline', children: 'Tidy preset' })
        ]
      }),

      jsx(ToggleRow, {
        checked: cfg.focus,
        description:
          'Temporarily strips the sidebar to New session, Pinned (when not empty) and Sessions. Your settings below are kept. Shortcut: ⌘⌥B / Ctrl+Alt+B.',
        label: 'Focus mode',
        onChange: on => setFocus(on)
      }),

      jsx(Heading, { children: 'Sections' }),
      jsx(SectionRow, {
        title: 'Pinned',
        description: disabledByFocus ? 'Focus mode: when not empty.' : offscreen(present, 'pinned'),
        value: cfg.sections.pinned,
        options: PINNED_OPTIONS,
        onChange: v => setSection('pinned', v)
      }),
      jsx(SectionRow, {
        title: 'Sessions',
        description: offscreen(present, 'sessions'),
        value: cfg.sections.sessions,
        options: BINARY_OPTIONS,
        onChange: v => setSection('sessions', v)
      }),
      jsx(SectionRow, {
        title: 'Search sessions',
        description: disabledByFocus
          ? 'Focus mode: keyboard only.'
          : 'Keyboard only: hidden until you press the Focus session search shortcut (⌘⇧F / Ctrl+Shift+F) or type a query.',
        value: cfg.sections.search,
        options: SEARCH_OPTIONS,
        onChange: v => setSection('search', v)
      }),
      jsx(SectionRow, {
        title: 'Cron jobs',
        description: disabledByFocus ? 'Focus mode: hidden.' : offscreen(present, 'cron'),
        value: cfg.sections.cron,
        options: BINARY_OPTIONS,
        onChange: v => setSection('cron', v)
      }),
      jsx(SectionRow, {
        title: 'Profile rail',
        description: disabledByFocus ? 'Focus mode: hidden.' : offscreen(present, 'profileRail'),
        value: cfg.sections.profileRail,
        options: BINARY_OPTIONS,
        onChange: v => setSection('profileRail', v)
      }),

      jsx(Heading, { children: 'Messaging channels' }),
      jsx(ToggleRow, {
        checked: cfg.messagingAll !== 'hide',
        description: disabledByFocus ? 'Focus mode hides all messaging sections.' : undefined,
        label: 'Show messaging sections',
        onChange: on => api?.update(c => ({ ...c, messagingAll: on ? 'show' : 'hide' }))
      }),
      ...(seen.platforms.length
        ? seen.platforms.map(label =>
            jsx(
              ToggleRow,
              {
                checked: cfg.messaging[label] !== 'hide',
                disabled: cfg.messagingAll === 'hide',
                label,
                onChange: on => setPlatformHidden(label, !on)
              },
              `platform:${label}`
            )
          )
        : [
            jsx(
              'p',
              {
                className: 'py-2 text-xs text-(--ui-text-tertiary)',
                children: 'No messaging platforms seen yet. They appear here once the sidebar shows them.'
              },
              'no-platforms'
            )
          ]),

      jsx(Heading, { children: 'Navigation' }),
      ...nav.map((row, index) =>
        jsx(
          NavRow,
          {
            count: nav.length,
            focusLocked: cfg.focus && eff.nav.hide.includes(row.id),
            hidden: eff.nav.hide.includes(row.id),
            index,
            locked: NEVER_HIDE.has(row.id),
            row
          },
          `nav:${row.id}`
        )
      ),
      jsx('p', {
        className: 'mt-6 text-[0.6875rem] text-(--ui-text-quaternary)',
        children: `Sidebar Tidy ${VERSION}`
      })
    ]
  })
}

// ─── status chip (only while focus mode is on) ─────────────────────────────

function FocusChip() {
  const cfg = useValue($config)

  if (!cfg.focus) {
    return null
  }

  return jsx(Tip, {
    label: 'Sidebar focus mode is on. Click to turn it off.',
    children: jsxs('button', {
      className: cn(
        'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem]',
        'text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      onClick: () => (haptic('tap'), setFocus(false)),
      type: 'button',
      children: [jsx(Codicon, { name: 'eye-closed', size: '0.75rem' }), 'focus']
    })
  })
}

// ─── palette ────────────────────────────────────────────────────────────────

const onOff = v => (v === 'hide' ? 'hidden' : 'shown')
const PINNED_CYCLE = { show: 'auto', auto: 'hide', hide: 'show' }
const PINNED_NAMES = { show: 'always', auto: 'when not empty', hide: 'hidden' }
const SEARCH_CYCLE = { show: 'keys', keys: 'hide', hide: 'show' }
const SEARCH_NAMES = { show: 'shown', keys: 'keyboard only', hide: 'hidden' }

function paletteRows() {
  const flip = key => () => setSection(key, $config.get().sections[key] === 'hide' ? 'show' : 'hide')
  const row = (id, label, run, detail, keywords = []) => ({
    id: `palette-${id}`,
    area: PALETTE_AREA,
    data: {
      id: `${ID}.${id}`,
      label,
      run,
      detail,
      detailVariant: detail ? 'state' : undefined,
      keepOpen: Boolean(detail),
      keywords: ['sidebar', 'hide', 'show', 'tidy', ...keywords]
    }
  })

  return [
    row('customize', 'Sidebar: Customize…', () => host.navigate(pluginSettingsHref(ID)), undefined, ['settings']),
    row('focus', 'Sidebar: Toggle focus mode', () => setFocus(!$config.get().focus), () => ($config.get().focus ? 'on' : 'off'), [
      'focus',
      'zen',
      'minimal'
    ]),
    row('everything', 'Sidebar: Show everything', showEverything, undefined, ['reset', 'restore']),
    row(
      'pinned',
      'Sidebar: Cycle Pinned section',
      () => setSection('pinned', PINNED_CYCLE[$config.get().sections.pinned] || 'show'),
      () => PINNED_NAMES[$config.get().sections.pinned],
      ['pinned', 'pins']
    ),
    row(
      'search',
      'Sidebar: Cycle search field',
      () => setSection('search', SEARCH_CYCLE[$config.get().sections.search] || 'show'),
      () => SEARCH_NAMES[$config.get().sections.search],
      ['search']
    ),
    row('cron', 'Sidebar: Toggle Cron jobs', flip('cron'), () => onOff($config.get().sections.cron), ['cron', 'jobs']),
    row(
      'messaging',
      'Sidebar: Toggle messaging channels',
      () => api?.update(c => ({ ...c, messagingAll: c.messagingAll === 'hide' ? 'show' : 'hide' })),
      () => onOff($config.get().messagingAll),
      ['messaging', 'channels', 'telegram', 'discord', 'imessage']
    ),
    row('rail', 'Sidebar: Toggle profile rail', flip('profileRail'), () => onOff($config.get().sections.profileRail), [
      'profile',
      'rail'
    ])
  ]
}

// ─── plugin ─────────────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Sidebar Tidy',
  description: 'Hide, auto-hide and reorder sidebar sections, channels and nav rows.',

  register(ctx) {
    $config.set(normalizeConfig(ctx.storage.get('config', DEFAULT_CONFIG)))
    const savedSeen = ctx.storage.get('seen', {})
    $seen.set({
      nav: Array.isArray(savedSeen.nav) ? savedSeen.nav.filter(r => r && typeof r.id === 'string') : [],
      platforms: Array.isArray(savedSeen.platforms) ? savedSeen.platforms.filter(p => typeof p === 'string') : [],
      present: {}
    })

    // Nav rows: the sanctioned contribution, re-registered on every change.
    let disposeNav = () => {}
    let lastNav = ''
    const applyNav = () => {
      const eff = effectiveConfig()
      const data = { hide: eff.nav.hide.filter(id => !NEVER_HIDE.has(id)), order: eff.nav.order }
      const key = JSON.stringify(data)

      if (key === lastNav) {
        return
      }

      lastNav = key
      disposeNav()
      disposeNav = ctx.register({ id: 'nav-prefs', area: SIDEBAR_NAV_PREFS_AREA, data })
    }

    // DOM pass, coalesced to one per frame.
    let raf = 0
    const schedule = () => {
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0

          try {
            pass()
          } catch (error) {
            console.warn('[sidebar-tidy] pass failed; leaving the sidebar untouched', error)
          }
        })
      }
    }

    api = {
      ctx,
      update(fn) {
        const next = normalizeConfig(fn($config.get()))
        $config.set(next)
        ctx.storage.set('config', next)
        applyNav()
        schedule()
      }
    }

    const removeStyle = installStyle()
    applyNav()

    // Watch only the sidebar subtree; re-bind if the sidebar remounts.
    let observed = null
    const observer = new MutationObserver(schedule)
    const bind = () => {
      const root = document.querySelector(SIDEBAR)

      if (root !== observed) {
        observer.disconnect()
        observed = root

        if (root) {
          observer.observe(root, { childList: true, subtree: true, characterData: true })
        }
      }

      schedule()
    }

    bind()
    // Cheap heartbeat: sidebar remounts, collapsed-Pinned pin-count changes,
    // and a focus-mode nav list that grew because a new plugin row appeared.
    ctx.setInterval(() => {
      bind()

      if ($config.get().focus) {
        applyNav()
      }
    }, 1500)

    // Peek: hold Alt/Option with the pointer over the sidebar.
    const html = document.documentElement
    const endPeek = () => html.removeAttribute('data-sbt-peek')
    ctx.addEventListener(window, 'keydown', event => {
      if (event.key === 'Alt' && !event.repeat) {
        html.setAttribute('data-sbt-peek', '')
      } else if (event.key !== 'Alt') {
        endPeek() // Alt+<key> is a shortcut, not a peek.
      }
    })
    ctx.addEventListener(window, 'keyup', event => {
      if (event.key === 'Alt') {
        endPeek()
      }
    })
    ctx.addEventListener(window, 'blur', endPeek)

    ctx.registerSettingsPage?.({
      id: 'settings',
      title: 'Sidebar Tidy',
      icon: 'layout-sidebar-left',
      render: () => jsx(SettingsPage, {})
    })

    ctx.registerMany([
      ...paletteRows(),
      {
        id: 'keybind-focus',
        area: KEYBINDS_AREA,
        data: {
          id: `${ID}.focus`,
          label: 'Toggle sidebar focus mode',
          category: 'view',
          defaults: ['mod+alt+b'],
          run: () => setFocus(!$config.get().focus)
        }
      },
      {
        id: 'focus-chip',
        area: STATUSBAR_AREAS.left,
        order: 900,
        render: () => jsx(FocusChip, {})
      }
    ])

    ctx.onDispose(() => {
      observer.disconnect()

      if (raf) {
        cancelAnimationFrame(raf)
      }

      for (const el of marked) {
        clearMarks(el)
      }

      marked = new Set()
      endPeek()
      removeStyle()
      api = null
    })
  }
}
