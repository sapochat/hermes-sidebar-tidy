# Sidebar Tidy

A [Hermes Desktop](https://hermes-agent.nousresearch.com/docs) plugin that lets you hide, auto-hide and reorder parts of the sidebar.

It started with a small annoyance: the **Pinned** section shows up even when nothing is pinned. Sidebar Tidy fixes that by default, and also lets you control every other section.

## Features

| Part | Modes |
|---|---|
| **Pinned** | Always · **When not empty** (default) · Hidden |
| **Sessions** | Shown · Hidden |
| **Search sessions** | Shown · **Keyboard only** · Hidden |
| **Cron jobs** | Shown · Hidden |
| **Profile rail** | Shown · Hidden |
| **Messaging channels** | All on/off, plus a switch per platform (Discord, Telegram, iMessage, …) |
| **Nav rows** | Show/hide and reorder New session, Messaging, Artifacts, Scheduled jobs, and rows added by other plugins |

**Keyboard only** search stays out of sight until you press the *Focus session search* shortcut (⌘⇧F / Ctrl+Shift+F) or there's a query in it.

**Capabilities** can't be hidden. It holds Settings → Plugins, which is where you'd turn this plugin off.

### Extras

- **Focus mode**: ⌘⌥B / Ctrl+Alt+B, rebindable in Keyboard Shortcuts. Leaves only New session, Pinned (if anything is pinned) and Sessions. Your saved settings stay as they were. A `focus` chip in the status bar shows it's on, and clicking it turns focus mode off.
- **Peek**: hold ⌥ Option / Alt with the pointer over the sidebar to see hidden parts, faded and outlined.
- **Command palette**: ⌘K → `Sidebar:` has Customize, Toggle focus mode, Show everything, and quick toggles for Pinned, search, Cron jobs, messaging and the profile rail.
- **Settings page**: Settings → Plugins → Sidebar Tidy, with a "Show everything" reset and a "Tidy preset" (Pinned when not empty, search keyboard only).

## Install

Desktop plugins load on **the computer running Hermes Desktop**, even when your gateway is remote.

1. In Hermes Desktop, open **Settings → Plugins → Reveal plugins folder**.
2. Put this repo there as a folder named `sidebar-tidy`:

   ```bash
   cd "<plugins folder>"          # usually ~/.hermes/desktop-plugins
   git clone https://github.com/sapochat/hermes-sidebar-tidy sidebar-tidy
   ```

   The result must be `desktop-plugins/sidebar-tidy/plugin.js`.
3. It loads within a few seconds, no restart. If it doesn't, run **Reload desktop plugins** from ⌘K.

To update, run `git pull` in that folder; Desktop hot-reloads it. To remove it, turn it off in **Capabilities → Plugins** or delete the folder. Turning it off puts the sidebar back to stock immediately.

## How it works

The plugin uses the official SDK wherever there is one, and keeps its own DOM work narrow and fail-safe where there isn't.

- **Nav rows** go through the SDK's `sidebarNav.prefs` contribution area. Core renders the hiding and ordering, and unloading the plugin removes the preference.
- **Session sections, search and the profile rail** have no SDK hook yet. The plugin finds them by their stable `data-*` attributes and their (localized) section labels, marks them with `data-sbt-*` attributes, and hides them with one injected stylesheet. A `MutationObserver` scoped to the sidebar keeps the marks current.
- **Fails open**: anything the plugin can't identify is left visible. If a Desktop update changes the sidebar markup, sections reappear rather than vanish.
- **"When not empty" for a collapsed Pinned section** reads Desktop's stored pin list, because a collapsed section renders no rows to count.
- **Storage**: settings live in the plugin's own `ctx.storage`. The plugin never writes pins, sessions or core settings.
- **Cleanup**: every listener, timer, observer, mark and the stylesheet are released when the plugin is disabled or reloaded.

### Known limits

- Session-section hiding depends on Desktop's current sidebar markup, so a future Desktop release could stop it working. Nothing gets hidden by mistake when that happens.
- With several **remote** connections, "When not empty" on a *collapsed* Pinned section may not be able to tell which connection's pins apply. In that case it shows the section.
- Messaging platforms appear in the settings once the sidebar has shown them at least once.

## Tests

`e2e/run.mjs` is an end-to-end test that drives a real, running Hermes Desktop over the Chrome DevTools Protocol. It checks the rendered sidebar after clicking through the plugin's own settings UI. It writes only this plugin's settings and never pins or edits sessions.

It covers each mode of every section, settings persistence, Pinned auto-hide as rows appear and disappear, per-platform and all-messaging hiding, keyboard-only search, nav hide and reorder, the locked Capabilities row, peek, the focus-mode keybind and status chip, the palette commands, "Show everything", and disable/re-enable cleanup.

Run it against an **isolated** Desktop instance, not your daily app:

```bash
# in a hermes-agent checkout
npm ci --workspace apps/desktop --include-workspace-root
cd apps/desktop
npx vite --host 127.0.0.1 --port 5194 --strictPort &
node scripts/bundle-electron-main.mjs --dev

S=$(mktemp -d); mkdir -p $S/home/desktop-plugins $S/ud
cp -r /path/to/hermes-sidebar-tidy $S/home/desktop-plugins/sidebar-tidy
HERMES_HOME=$S/home HERMES_DESKTOP_DEV_SERVER=http://127.0.0.1:5194 HERMES_DESKTOP_CDP_PORT=9333 \
  xvfb-run -a node_modules/electron/dist/electron . --user-data-dir=$S/ud --no-sandbox &   # drop xvfb-run on a desktop

node /path/to/hermes-sidebar-tidy/e2e/run.mjs --port 9333 --match 5194 --out results.json
```

The test needs at least one session in the instance, and checks messaging only if a messaging platform is present. The last recorded run is in [`e2e/results.json`](e2e/results.json): **26/26** on Hermes Desktop 0.22.2 (`d923a5eb48`), Electron 40.10.2, Linux under Xvfb.

## Compatibility

Built and tested against Hermes Desktop **0.22.2**. It needs `SIDEBAR_NAV_PREFS_AREA` and `ctx.registerSettingsPage` in the plugin SDK. On older builds the settings page is skipped; use the ⌘K commands instead.

## License

MIT
