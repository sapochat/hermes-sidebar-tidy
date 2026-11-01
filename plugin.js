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
 * mode (⌘⌥B / Ctrl+Alt+B), hold ⌥/Alt over the sidebar to peek at whatever
 * is hidden, and profile marks: a small swatch on each session row in its
 * profile's color (the same color the profile rail shows), through the
 * official `sessionRow.leading` slot.
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
// Newer SDK exports read through the namespace so an older Desktop build that
// lacks them still loads the rest of the plugin (a missing named import would
// fail the whole module at link time).
import * as sdk from '@hermes/plugin-sdk'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'sidebar-tidy'
const VERSION = '1.1.0'
const SIDEBAR = '[data-tour="sessions-sidebar"]'
const CONTENT_CHILD = '[data-sidebar="content"] > *'
const PIN_STORAGE_KEY = 'hermes.desktop.pinnedSessions'
const STYLE_ID = 'sidebar-tidy-style'
const CORE_NAV = ['new-session', 'capabilities', 'messaging', 'artifacts', 'cron']
// Core refuses to hide this row: it hosts the Plugins tab (the off-switch).
const NEVER_HIDE = new Set(['capabilities'])
const MARK_ATTRS = ['data-sbt-section', 'data-sbt-hidden', 'data-sbt-search', 'data-sbt-has-value']
const PROFILE_COLORS_KEY = 'hermes.desktop.profileColors'
const MARK_STYLES = ['off', 'edge', 'dot', 'tint']

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
  focus: false,
  profileMarks: { style: 'edge', includeDefault: false } // style: off | edge | dot | tint
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
    focus: Boolean(cfg.focus),
    profileMarks: normalizeMarks(cfg.profileMarks)
  }
}

function normalizeMarks(raw) {
  const marks = raw && typeof raw === 'object' ? raw : {}

  return {
    style: MARK_STYLES.includes(marks.style) ? marks.style : DEFAULT_CONFIG.profileMarks.style,
    includeDefault: Boolean(marks.includeDefault)
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

// ─── profile marks ──────────────────────────────────────────────────────────
//
// The row slot hands us only the session's stored id, so ownership comes from
// one read-only listing across every profile (`host.listPersistedSessions`,
// the same endpoint the All-profiles sidebar reads). Rows outside that window
// simply get no mark; nothing is ever written back.

const OWNERS_LIMIT = 500
const OWNERS_TTL_MS = 60_000
const OWNERS_RETRY_MS = 15_000

const $owners = atom({}) // stored or live session id -> profile name
const $profileColors = atom({}) // user-picked rail colors (profile -> css color)

const owners = { at: 0, inflight: false, epoch: 0 }

function marksSupported() {
  return Boolean(sdk.SESSION_ROW_AREAS?.leading) && typeof host.listPersistedSessions === 'function'
}

function profileKey(name) {
  return (typeof name === 'string' ? name.trim() : '') || 'default'
}

function readProfileColors() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROFILE_COLORS_KEY) || '{}')

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string' && v))
  } catch {
    return {}
  }
}

function syncProfileColors() {
  const next = readProfileColors()

  if (JSON.stringify(next) !== JSON.stringify($profileColors.get())) {
    $profileColors.set(next)
  }
}

// Mirrors core's lib/profile-color hash, used only if the SDK predates the
// `profileColor` export.
function fallbackProfileColor(key) {
  let hash = 0

  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  }

  return `hsl(${hash % 360} 68% 58%)`
}

/** Same answer as core's resolveProfileColor: override, else the stable hue.
 *  Default stays neutral (null), as it does on the profile rail. */
function colorForProfile(name, overrides = $profileColors.get()) {
  const key = profileKey(name)

  if (key === 'default') {
    return null
  }

  return overrides[key] || (typeof sdk.profileColor === 'function' ? sdk.profileColor(key) : null) || fallbackProfileColor(key)
}

function refreshOwners({ force = false } = {}) {
  if (!marksSupported() || owners.inflight) {
    return
  }

  const wait = force || !owners.at ? 0 : OWNERS_RETRY_MS

  if (Date.now() - owners.at < wait) {
    return
  }

  owners.at = Date.now()
  owners.inflight = true
  const epoch = owners.epoch

  Promise.resolve()
    .then(() => host.listPersistedSessions(null, { profile: 'all', limit: OWNERS_LIMIT }))
    .then(result => {
      if (epoch !== owners.epoch) {
        return
      }

      const next = { ...$owners.get() }
      let changed = false

      for (const row of Array.isArray(result?.sessions) ? result.sessions : []) {
        const profile = profileKey(row?.profile)
        const ids = [row?.id, row?._lineage_root_id, ...(Array.isArray(row?._lineage_ids) ? row._lineage_ids : [])]

        for (const id of ids) {
          if (typeof id === 'string' && id && next[id] !== profile) {
            next[id] = profile
            changed = true
          }
        }
      }

      if (changed) {
        $owners.set(next)
      }
    })
    .catch(error => console.warn('[sidebar-tidy] could not read session owners; profile marks paused', error))
    .finally(() => {
      if (epoch === owners.epoch) {
        owners.inflight = false
      }
    })
}

const MARK_BASE = {
  display: 'inline-block',
  flexShrink: 0,
  alignSelf: 'center',
  boxSizing: 'border-box'
}

const DOT_SIZE = '0.375rem'

// Default has no color of its own: an outline, like the rail's neutral tile.
function swatchPaint(color) {
  return {
    background: color || 'transparent',
    border: color ? 'none' : '1px solid var(--ui-text-quaternary, currentColor)'
  }
}

/**
 * Edge: a short stripe in the row's left padding. The slot itself is zero
 * width and cancels the row's flex gap, so the title starts exactly where it
 * does on an unmarked row; the stripe is positioned from measured geometry,
 * not from core's class names.
 */
function EdgeMark({ color, label, profile }) {
  const ref = useRef(null)

  useLayoutEffect(() => {
    const slot = ref.current
    const stripe = slot?.querySelector('[role="img"]')
    const cluster = slot?.parentElement
    const row = cluster?.parentElement

    if (!slot || !stripe || !cluster || !row) {
      return
    }

    const gap = parseFloat(getComputedStyle(cluster).columnGap) || 0
    slot.style.marginRight = gap ? `-${gap}px` : '0px'
    const offset = row.getBoundingClientRect().left - slot.getBoundingClientRect().left
    stripe.style.left = `${Math.round(offset + 3)}px`
  })

  return jsx('span', {
    'data-sbt-profile': profile,
    'data-sbt-mark': 'edge',
    ref,
    style: { position: 'relative', flexShrink: 0, width: 0, alignSelf: 'stretch' },
    children: jsx(Tip, {
      label,
      children: jsx('span', {
        'aria-label': label,
        role: 'img',
        style: {
          position: 'absolute',
          top: '50%',
          width: '3px',
          height: '0.875rem',
          transform: 'translateY(-50%)',
          borderRadius: '2px',
          boxSizing: 'border-box',
          ...swatchPaint(color)
        }
      })
    })
  })
}

/** Dot: an inline swatch after the status dot. Unmarked rows get the same
 *  empty box so every title keeps one left edge. */
function DotMark({ color, label, profile }) {
  const box = { ...MARK_BASE, width: DOT_SIZE, height: DOT_SIZE, borderRadius: '999px' }

  if (!profile) {
    return jsx('span', { 'aria-hidden': 'true', 'data-sbt-mark': 'spacer', style: box })
  }

  return jsx(Tip, {
    label,
    children: jsx('span', {
      'aria-label': label,
      'data-sbt-mark': 'dot',
      'data-sbt-profile': profile,
      role: 'img',
      style: { ...box, ...swatchPaint(color) }
    })
  })
}

/**
 * Tint: no mark of our own. Desktop's idle status dot is recolored instead, so
 * a row keeps one dot. Core owns that dot and has no hook for it, so this is
 * the one DOM-reliant style: the slot (zero width, gap cancelled) puts the
 * color on its row cluster as --sbt-tint, and a stylesheet rule paints only a
 * dot that is idle and has no project/session color of its own. Working,
 * unread and needs-input dots keep their meaning; if core's markup changes
 * the rule matches nothing and the dot stays grey.
 */
function TintMark({ color, label, profile }) {
  const ref = useRef(null)

  useLayoutEffect(() => {
    const slot = ref.current
    const cluster = slot?.parentElement

    if (!slot || !cluster) {
      return
    }

    const gap = parseFloat(getComputedStyle(cluster).columnGap) || 0
    slot.style.marginRight = gap ? `-${gap}px` : '0px'
    cluster.style.setProperty('--sbt-tint', color)

    return () => cluster.style.removeProperty('--sbt-tint')
  }, [color])

  return jsx('span', {
    'aria-label': label,
    'data-sbt-mark': 'tint',
    'data-sbt-profile': profile,
    ref,
    role: 'img',
    style: { flexShrink: 0, width: 0, height: 0, overflow: 'hidden' }
  })
}

function ProfileMark({ sessionId }) {
  const marks = useValue($config).profileMarks
  const profile = useValue($owners)[sessionId]
  const overrides = useValue($profileColors)
  const off = marks.style === 'off'

  // An id we haven't seen is a session newer than the last listing.
  useEffect(() => {
    if (!off && !profile) {
      refreshOwners()
    }
  }, [off, profile, sessionId])

  if (off) {
    return null
  }

  const shown = profile && (profile !== 'default' || marks.includeDefault) ? profile : null

  if (marks.style === 'dot') {
    return jsx(DotMark, { color: shown && colorForProfile(shown, overrides), label: `${shown} profile`, profile: shown })
  }

  if (!shown) {
    return null
  }

  if (marks.style === 'tint') {
    const tint = colorForProfile(shown, overrides)
    // Default has no color: its idle dot is already Desktop's grey.
    return tint ? jsx(TintMark, { color: tint, label: `${shown} profile`, profile: shown }) : null
  }

  return jsx(EdgeMark, { color: colorForProfile(shown, overrides), label: `${shown} profile`, profile: shown })
}

function setMarks(patch) {
  api?.update(cfg => ({ ...cfg, profileMarks: { ...cfg.profileMarks, ...patch } }))
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
${SIDEBAR} :has(> [data-sbt-mark="tint"]) > :not([data-sbt-mark]) .size-1.rounded-full[aria-hidden="true"]:not([style*="background"]) {
  background-color: var(--sbt-tint) !important;
  width: 0.375rem;
  height: 0.375rem;
  margin: -1px;
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
const MARK_OPTIONS = [
  { id: 'off', label: 'Off' },
  { id: 'edge', label: 'Edge' },
  { id: 'dot', label: 'Dot' },
  { id: 'tint', label: 'Tint' }
]

/** Every profile the owner listing has seen, with the color its mark uses. */
function ProfileLegend() {
  const ownerMap = useValue($owners)
  const overrides = useValue($profileColors)
  const marks = useValue($config).profileMarks
  const names = [...new Set(Object.values(ownerMap))]
    .filter(name => name !== 'default' || marks.includeDefault)
    .sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)))

  if (!names.length) {
    return jsx('p', {
      className: 'py-2 text-xs text-(--ui-text-tertiary)',
      children: 'No named-profile sessions seen yet.'
    })
  }

  return jsx('div', {
    className: 'flex flex-wrap gap-x-4 gap-y-1.5 py-2 text-xs text-(--ui-text-secondary)',
    children: names.map(name => {
      const color = colorForProfile(name, overrides)

      return jsxs(
        'span',
        {
          className: 'inline-flex items-center',
          'data-sbt-legend': name,
          children: [
            jsx('span', {
              style: {
                ...MARK_BASE,
                marginRight: '0.375rem',
                width: marks.style === 'edge' ? '3px' : '0.5rem',
                height: marks.style === 'edge' ? '0.875rem' : '0.5rem',
                borderRadius: marks.style === 'edge' ? '2px' : '999px',
                ...swatchPaint(color)
              }
            }),
            name
          ]
        },
        name
      )
    })
  })
}

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

      jsx(Heading, { children: 'Profile marks' }),
      marksSupported()
        ? jsx(SectionRow, {
            title: 'Session rows',
            description:
              'Color each session by its profile, matching the profile rail. Edge is a stripe in the row\'s left margin and never moves the title; Dot sits after the status dot and indents every row slightly; Tint recolors the status dot itself while a session is idle (working, unread and waiting dots keep their own colors, and so do sessions with a project color). Change a profile\'s color by right-clicking its square in the rail → Color.',
            value: cfg.profileMarks.style,
            options: MARK_OPTIONS,
            onChange: v => setMarks({ style: v })
          })
        : jsx('p', {
            className: 'py-2 text-xs text-(--ui-text-tertiary)',
            children: 'Needs a newer Hermes Desktop (the session-row slot isn\'t available in this build).'
          }),
      marksSupported() &&
        jsx(ToggleRow, {
          checked: cfg.profileMarks.includeDefault,
          description:
            cfg.profileMarks.style === 'tint'
              ? 'Not used by Tint: default sessions already have Desktop\'s grey dot.'
              : 'The default profile has no color, so it gets an outline.',
          disabled: cfg.profileMarks.style === 'off' || cfg.profileMarks.style === 'tint',
          label: 'Mark default-profile sessions too',
          onChange: on => setMarks({ includeDefault: on })
        }),
      marksSupported() && cfg.profileMarks.style !== 'off' && jsx(ProfileLegend, {}),

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
const MARK_CYCLE = { off: 'edge', edge: 'dot', dot: 'tint', tint: 'off' }

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
    ]),
    row(
      'marks',
      'Sidebar: Cycle profile marks',
      () => setMarks({ style: MARK_CYCLE[$config.get().profileMarks.style] || 'edge' }),
      () => $config.get().profileMarks.style,
      ['profile', 'color', 'dot', 'marks']
    )
  ]
}

// ─── plugin ─────────────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Sidebar Tidy',
  description: 'Hide, auto-hide and reorder sidebar sections, channels and nav rows; color-mark sessions by profile.',

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
      syncProfileColors() // the rail's color picker writes localStorage

      if ($config.get().focus) {
        applyNav()
      }
    }, 1500)

    // Profile marks: the official row slot; ownership refreshes once a minute.
    syncProfileColors()

    if (marksSupported()) {
      refreshOwners({ force: true })
      ctx.setInterval(() => {
        if ($config.get().profileMarks.style !== 'off') {
          refreshOwners({ force: true })
        }
      }, OWNERS_TTL_MS)
      ctx.register({
        id: 'profile-mark',
        area: sdk.SESSION_ROW_AREAS.leading,
        data: { render: ({ sessionId }) => jsx(ProfileMark, { sessionId }) }
      })
    }

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
      owners.epoch += 1
      owners.inflight = false
      owners.at = 0
      endPeek()
      removeStyle()
      api = null
    })
  }
}
