// Sidebar Tidy E2E: drives a running Hermes Desktop over CDP and checks the
// real rendered sidebar. Writes only plugin config (renderer localStorage of
// the instance under test) — never pins, never touches sessions.
//
//   node run.mjs [--port 9333] [--match 5194] [--out results.json]
import { writeFileSync } from 'node:fs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : fallback
}
const port = Number(arg('port', 9333))
const match = arg('match', '')
const out = arg('out', new URL('./results.json', import.meta.url).pathname)

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = targets.find(t => t.type === 'page' && t.url.includes(match))
if (!target) throw new Error('no page target')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map()
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id)
})
const send = (method, params = {}) =>
  new Promise(r => {
    const id = ++seq
    pending.set(id, r)
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async expr => {
  const m = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400))
  return m.result?.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const key = async (type, key, code, modifiers = 0) =>
  send('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode: key === 'Alt' ? 18 : 0 })

const CFG = 'hermes.plugin.sidebar-tidy.config'
// State snapshot of everything the plugin can hide.
const SNAP = `(() => {
  const root = document.querySelector('[data-tour="sessions-sidebar"]')
  const shown = el => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0
  const groups = {}
  for (const g of root.querySelectorAll('[data-sessions-mode] > [data-slot="sidebar-group"]')) {
    groups[g.getAttribute('data-sbt-section') || '?' + g.querySelector('.uppercase .truncate')?.textContent] = shown(g)
  }
  const nav = {}
  for (const n of root.querySelectorAll('[data-tour^="sidebar-nav-"]')) nav[n.dataset.tour.slice(12)] = shown(n)
  const search = root.querySelector('input[aria-label="Search sessions"]')?.closest('[data-sidebar="content"] > *')
  return { groups, nav, search: search ? { shown: shown(search), h: search.getBoundingClientRect().height, mode: search.getAttribute('data-sbt-search') } : null,
           marks: document.querySelectorAll('[data-sbt-section]').length, style: !!document.getElementById('sidebar-tidy-style'),
           peek: document.documentElement.hasAttribute('data-sbt-peek') }
})()`
const snap = () => evaluate(SNAP)

// Config is written the way the settings page writes it, then the plugin is
// reloaded so register() re-reads storage — exercises the persistence path.
const reload = async () => {
  await evaluate(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => /Reload desktop plugins/.test(b.textContent))
    return !!btn
  })()`)
}
const setConfig = async patch =>
  evaluate(`(() => {
    const cur = JSON.parse(localStorage.getItem(${JSON.stringify(CFG)}) || '{}')
    const next = ${JSON.stringify(patch)}
    localStorage.setItem(${JSON.stringify(CFG)}, JSON.stringify({ ...cur, ...next, sections: { ...(cur.sections||{}), ...(next.sections||{}) } }))
  })()`)

// Drive the real settings UI: click a SegmentedControl option within a row.
const clickSegment = (rowTitle, option) =>
  evaluate(`(() => {
    const title = [...(document.querySelector('main') || document).querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(rowTitle)} && e.closest('.\\\\@container'))
    const row = title?.closest('.\\\\@container')
    const btn = row && [...row.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(option)})
    if (!btn) return false
    btn.click(); return true
  })()`)
const clickSwitch = label =>
  evaluate(`(() => { const s = document.querySelector('[role="switch"][aria-label=${JSON.stringify(label)}]'); if (!s) return false; s.click(); return true })()`)

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail)}`)
}

// 0. Baseline: All-profiles sidebar (where profile marks matter), setup card dismissed.
if ((await evaluate(`localStorage.getItem('hermes.desktop.showAllProfiles')`)) !== 'true') {
  await evaluate(`localStorage.setItem('hermes.desktop.showAllProfiles', 'true'), location.reload()`)
  await sleep(8000)
}
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === "I'll choose a provider later")?.click()`)
await sleep(500)
await evaluate(`location.hash = '#/settings?tab=plugins&plugin=sidebar-tidy'`)
await sleep(1500)
await clickSegment('Pinned', 'Always') // known start
await sleep(400)
let s = await snap()
check('plugin loaded: stylesheet injected and sections marked', s.style && s.marks >= 4, s)
const original = s
check('Pinned "Always": empty Pinned visible', s.groups.pinned === true, s.groups)

// 1. Pinned: When not empty (no pins in this instance) → hidden
await clickSegment('Pinned', 'When not empty')
await sleep(400)
s = await snap()
check('Pinned "When not empty": hidden while empty', s.groups.pinned === false, s.groups)
check('persisted to plugin storage', (await evaluate(`JSON.parse(localStorage.getItem('${CFG}')).sections.pinned`)) === 'auto')

// 1b. auto + open section with a row → shown (synthetic row, no real pin write)
await evaluate(`(() => {
  const g = document.querySelector('[data-sbt-section="pinned"]')
  const c = g.querySelector('[data-slot="sidebar-group-content"]')
  if (!c) return 'collapsed'
  const fake = document.createElement('div'); fake.className = 'row-hover'; fake.id = 'sbt-fake-row'; c.appendChild(fake); return 'ok'
})()`)
await sleep(400)
s = await snap()
check('Pinned "When not empty": shown once it has a row', s.groups.pinned === true, s.groups)
await evaluate(`document.getElementById('sbt-fake-row')?.remove()`)
await sleep(400)
s = await snap()
check('Pinned "When not empty": hides again when the row goes', s.groups.pinned === false, s.groups)

// 2. Hidden
await clickSegment('Pinned', 'Hidden')
await sleep(400)
check('Pinned "Hidden"', (await snap()).groups.pinned === false)

// 3. Cron, messaging per-platform, messaging all, sessions
await clickSegment('Cron jobs', 'Hidden')
await sleep(400)
s = await snap()
check('Cron jobs hidden; others intact', s.groups.cron === false && s.groups.sessions === true, s.groups)
const platforms = Object.keys(original.groups).filter(k => k.startsWith('messaging:'))
if (platforms.length) {
  const p = platforms[0].slice(10)
  await clickSwitch(p)
  await sleep(400)
  s = await snap()
  check(`one platform (${p}) hidden, others shown`, s.groups[platforms[0]] === false && platforms.slice(1).every(k => s.groups[k] === true), s.groups)
  await clickSwitch('Show messaging sections')
  await sleep(400)
  s = await snap()
  check('all messaging sections hidden', platforms.every(k => s.groups[k] === false), s.groups)
  await clickSwitch('Show messaging sections')
  await clickSwitch(p)
  await sleep(400)
}
await clickSegment('Sessions', 'Hidden')
await sleep(400)
check('Sessions hidden', (await snap()).groups.sessions === false)
await clickSegment('Sessions', 'Shown')

// 4. Search: keyboard only collapses; focus reveals
await clickSegment('Search sessions', 'Keyboard only')
await sleep(500)
s = await snap()
check('search "Keyboard only": collapsed to 0 height', s.search && s.search.h < 1, s.search)
await evaluate(`document.querySelector('input[aria-label="Search sessions"]').focus()`)
await sleep(400)
s = await snap()
check('search "Keyboard only": expands on focus', s.search && s.search.h > 10, s.search)
await evaluate(`document.activeElement.blur()`)
await clickSegment('Search sessions', 'Shown')

// 5. Nav row via the official sidebarNav.prefs contribution
await clickSwitch('Show Artifacts')
await sleep(400)
s = await snap()
check('nav: Artifacts hidden through sidebarNav.prefs (row unmounted)', !('artifacts' in s.nav) && s.nav['new-session'], s.nav)
const capSwitch = await evaluate(`document.querySelector('[role="switch"][aria-label="Show Capabilities"]')?.disabled`)
check('nav: Capabilities switch locked', capSwitch === true)
await evaluate(`[...document.querySelectorAll('button[aria-label="Move Scheduled jobs up"]')][0]?.click()`)
await sleep(100)
await evaluate(`[...document.querySelectorAll('button[aria-label="Move Scheduled jobs up"]')][0]?.click()`)
await sleep(400)
s = await snap()
const order = Object.keys(s.nav)
check('nav: reorder moves Scheduled jobs above Messaging', order.indexOf('cron') < order.indexOf('messaging'), order)

// 6. Peek: hold Alt over the sidebar
await key('keyDown', 'Alt', 'AltLeft', 1)
await sleep(150)
const peekCss = await evaluate(`(() => {
  document.querySelector('[data-tour="sessions-sidebar"]').matches(':hover')
  return document.documentElement.hasAttribute('data-sbt-peek')
})()`)
check('peek: Alt sets data-sbt-peek', peekCss === true)
await key('keyUp', 'Alt', 'AltLeft', 0)
await sleep(150)
check('peek: releasing Alt clears it', (await snap()).peek === false)

// 7. Focus mode via keybind (Ctrl+Alt+B on Linux)
await clickSegment('Pinned', 'Always')
await sleep(300)
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', modifiers: 1 | 2, windowsVirtualKeyCode: 66 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', modifiers: 1 | 2, windowsVirtualKeyCode: 66 })
await sleep(600)
s = await snap()
const focusOn = await evaluate(`JSON.parse(localStorage.getItem('${CFG}')).focus`)
check('focus mode: Ctrl+Alt+B turns it on', focusOn === true, focusOn)
check(
  'focus mode: only New session + Capabilities nav; cron/messaging hidden; empty Pinned hidden',
  Object.keys(s.nav).sort().join() === 'capabilities,new-session' && s.groups.cron === false && s.groups.pinned === false &&
    platforms.every(k => s.groups[k] === false),
  s
)
const savedPinned = await evaluate(`JSON.parse(localStorage.getItem('${CFG}')).sections.pinned`)
check('focus mode: saved settings untouched', savedPinned === 'show', savedPinned)
const chip = await evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'focus')`)
check('focus mode: status-bar chip visible', chip)
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'focus').click()`)
await sleep(500)
check('focus mode: chip click turns it off', (await evaluate(`JSON.parse(localStorage.getItem('${CFG}')).focus`)) === false)

// 8. Palette contributions registered
const paletteOk = await evaluate(`(async () => {
  location.hash = '#/'
  await new Promise(r => setTimeout(r, 800))
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true }))
  await new Promise(r => setTimeout(r, 700))
  const input = document.querySelector('[data-slot=command] input, [cmdk-input]')
  if (!input) return 'no palette'
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Sidebar')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 600))
  const items = [...document.querySelectorAll('[cmdk-item]')].map(e => e.textContent.trim()).filter(t => t.startsWith('Sidebar:'))
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  return items
})()`)
check('palette: Sidebar commands listed', Array.isArray(paletteOk) && paletteOk.length === 9, paletteOk)

// 9. Profile marks (needs sessions from at least two profiles; the fixture in
//    e2e/fixture_sql.py provides default + research + writing).
const MARKS = `(async () => {
  const api = await window.hermesDesktop.api({ path: '/api/profiles/sessions?limit=200&offset=0&min_messages=0&archived=exclude&order=recent&profile=all' })
  const owner = Object.fromEntries(api.sessions.map(s => [s.title, s.profile || 'default']))
  const root = document.querySelector('[data-tour="sessions-sidebar"] [data-sessions-mode]')
  const rows = [...root.querySelectorAll('button')].filter(b => b.textContent.trim() in owner).map(b => {
    let mark = null
    for (let el = b.parentElement, i = 0; el && !mark && i < 5; el = el.parentElement, i++) {
      mark = el.querySelector(':scope > [data-sbt-mark]')
    }
    const sw = mark && (mark.querySelector('[role="img"]') || mark)
    const r = sw?.getBoundingClientRect()
    return { title: b.textContent.trim(), profile: owner[b.textContent.trim()], titleX: Math.round(b.getBoundingClientRect().left),
             mark: mark?.dataset.sbtMark || null, markProfile: mark?.dataset.sbtProfile || null,
             color: sw && mark.dataset.sbtMark !== 'spacer' ? getComputedStyle(sw).backgroundColor : null,
             visible: !!r && r.width > 0 && r.height > 0 }
  })
  const rail = {}
  for (const b of document.querySelectorAll('[data-slot="profile-rail"] button[aria-label]')) {
    const c = getComputedStyle(b).color
    rail[b.getAttribute('aria-label')] = c
  }
  return { rows, rail, profiles: [...new Set(api.sessions.map(s => s.profile || 'default'))] }
})()`
const marks = () => evaluate(MARKS)
await evaluate(`localStorage.setItem('hermes.desktop.showAllProfiles', 'true')`)
await evaluate(`location.hash = '#/settings?tab=plugins&plugin=sidebar-tidy'`)
await sleep(800)
let m = await marks()
const named = m.rows.filter(r => r.profile !== 'default')
if (m.profiles.length < 2 || !named.length) {
  check('profile marks: fixture with named-profile sessions present', false, m)
} else {
  await clickSegment('Session rows', 'Edge')
  await sleep(1500)
  m = await marks()
  check(
    'profile marks "Edge": every named-profile row striped with its own profile, default rows bare',
    m.rows.every(r => (r.profile === 'default' ? r.mark === null : r.mark === 'edge' && r.markProfile === r.profile && r.visible)),
    m.rows
  )
  check(
    'profile marks: colors match the profile rail',
    m.rows.filter(r => r.mark === 'edge').every(r => m.rail[r.profile] && r.color === m.rail[r.profile]),
    { rows: m.rows, rail: m.rail }
  )
  check('profile marks "Edge": titles keep one left edge', new Set(m.rows.map(r => r.titleX)).size === 1, m.rows)

  await clickSegment('Session rows', 'Dot')
  await sleep(600)
  m = await marks()
  check(
    'profile marks "Dot": named rows get a dot, default rows a same-size spacer',
    m.rows.every(r => (r.profile === 'default' ? r.mark === 'spacer' : r.mark === 'dot' && r.markProfile === r.profile)),
    m.rows
  )
  check('profile marks "Dot": titles keep one left edge', new Set(m.rows.map(r => r.titleX)).size === 1, m.rows)

  await clickSwitch('Mark default-profile sessions too')
  await sleep(600)
  m = await marks()
  check(
    'profile marks: "Mark default" outlines default rows',
    m.rows.filter(r => r.profile === 'default').every(r => r.mark === 'dot' && r.markProfile === 'default'),
    m.rows
  )
  await clickSwitch('Mark default-profile sessions too')

  const legend = await evaluate(`[...document.querySelectorAll('[data-sbt-legend]')].map(e => e.dataset.sbtLegend)`)
  check('profile marks: settings legend lists the named profiles', named.every(r => legend.includes(r.profile)), legend)

  await clickSegment('Session rows', 'Off')
  await sleep(600)
  m = await marks()
  check('profile marks "Off": no marks at all', m.rows.every(r => r.mark === null), m.rows)
  check('profile marks: persisted', (await evaluate(`JSON.parse(localStorage.getItem('${CFG}')).profileMarks.style`)) === 'off')
  await clickSegment('Session rows', 'Edge')
  await sleep(1000)
}

// 10. Show everything restores the original sidebar
await evaluate(`location.hash = '#/settings?tab=plugins&plugin=sidebar-tidy'`)
await sleep(800)
await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Show everything').click()`)
await sleep(500)
s = await snap()
check(
  '"Show everything" restores every section and nav row',
  JSON.stringify(s.groups) === JSON.stringify(original.groups) && Object.keys(s.nav).length === Object.keys(original.nav).length,
  { now: s, original }
)

// 11. Disable the plugin → all marks, style, nav prefs and profile marks gone
const disabled = await evaluate(`(async () => {
  location.hash = '#/capabilities?tab=plugins'
  await new Promise(r => setTimeout(r, 1500))
  let sw = [...document.querySelectorAll('[role="switch"]')].find(e => /Sidebar Tidy|sidebar-tidy/.test(e.getAttribute('aria-label') || ''))
  let via = 'plugins page switch'
  if (!sw) {
    // Newer builds list disk plugins outside this page; fall back to the same
    // store call the switch makes (dev server only: same module instance).
    const store = await import('/src/contrib/plugins-store.ts').catch(() => null)
    if (!store?.setPluginEnabled) return 'no switch'
    let on = true
    sw = { click: () => { on = !on; return store.setPluginEnabled('sidebar-tidy', on) } }
    via = 'plugins-store setPluginEnabled'
  }
  await sw.click(); await new Promise(r => setTimeout(r, 800))
  const r = { style: !!document.getElementById('sidebar-tidy-style'), marks: document.querySelectorAll('[data-sbt-section]').length,
              profileMarks: document.querySelectorAll('[data-sbt-mark]').length }
  r.via = via
  await sw.click(); await new Promise(r => setTimeout(r, 1200))
  await new Promise(r => setTimeout(r, 1500))
  r.reenabled = !!document.getElementById('sidebar-tidy-style')
  r.profileMarksBack = document.querySelectorAll('[data-sbt-mark]').length
  return r
})()`)
check(
  'disable: stylesheet, section marks and profile marks removed; re-enable restores',
  disabled?.style === false && disabled?.marks === 0 && disabled?.profileMarks === 0 && disabled?.reenabled && disabled?.profileMarksBack > 0,
  disabled
)

const pass = results.filter(r => r.ok).length
const env = await evaluate(`JSON.stringify({ ua: navigator.userAgent, url: location.href })`)
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), pass, total: results.length, env: JSON.parse(env), results }, null, 2))
console.log(`\n${pass}/${results.length} passed → ${out}`)
ws.close()
process.exit(pass === results.length ? 0 : 1)
