# Hermes Desktop plugin assessment

> **Proposal for review, not implemented, not approved.** No plugin has been
> written, installed, enabled, or published. No Canvas code was changed. The
> Canvas service was not started, bound, or exposed. This document verifies
> what a Hermes Desktop plugin can and cannot do against Workflow Canvas as it
> is built today, so a later build starts from facts rather than hope.

## Goal

A *thin* Hermes Desktop plugin that lets a Hermes Desktop user open and
interact with their own Workflow Canvas instance. "Thin" means: no copy of the
editor, no second data store, no new authority over Canvas. Canvas stays the
standalone, self-hosted core; the plugin is only a convenience surface.

The task specifically asked us to verify the real plugin interfaces rather than
assume embedding or remote connectivity works. It does not. The evidence is
below.

## What a Hermes Desktop plugin actually is (verified)

Source: the Hermes desktop-plugin SDK reference (`developer-guide/
desktop-plugin-sdk`). Confirm against the installed Hermes version before
building; these surfaces change between releases.

- A plugin is a single plain-JavaScript ESM file (`plugin.js`), loaded by the
  Electron desktop app at runtime. No build step, hot-reloaded on save.
- The **only** import surface is `@hermes/plugin-sdk` plus `react` /
  `react/jsx-runtime` (the app's own React; write `jsx()` calls, not JSX
  syntax). Any other import specifier fails to resolve. There is **no webview,
  iframe, or arbitrary-URL embedding API** in that surface.
- Contribution areas: `statusBar.left/right` chips, `panes` (layout zones),
  `PALETTE_AREA` (Cmd+K commands), `KEYBINDS_AREA`, `ROUTES_AREA` (a full page
  in the main pane), `SIDEBAR_NAV_AREA` (a nav row), `THEMES_AREA`,
  `TRANSCRIPT_DIRECTIVE_AREA`.
- Doors to the OS, curated and attributed to the plugin: `ctx.os.openExternal(url)`,
  `ctx.os.revealPath`, `ctx.os.writeClipboard`, `ctx.os.notify(...)`. Each
  resolves `false` (never throws) when unavailable.
- Gateway data: `host.request(method, params)` (Hermes gateway JSON-RPC) and
  `host.onEvent(type, fn)`. These reach **Hermes**, not Canvas.
- Optional Python backend: if the plugin ships a `plugin_api.py` under
  `~/.hermes/plugins/<id>/dashboard/`, the plugin reaches it with
  `ctx.rest('/path', ...)` and `ctx.socket('/events', ...)`, scoped to
  `/api/plugins/<id>`. `ctx.socket` is a no-op on OAuth remotes, so a backend
  design must keep a polling fallback.

## The three candidate designs and their verdicts

### 1. Open-in-browser launcher — SUPPORTED (recommended thin plugin)

The plugin registers a status-bar chip, a Cmd+K command, and a sidebar nav row,
each calling:

```js
ctx.os.openExternal('http://127.0.0.1:8787')
```

Canvas opens in the user's default browser, which is already the only
environment Canvas supports (plain-HTTP loopback, `crypto.getRandomValues`
fallback for IDs on non-secure origins). The plugin stores the configured URL
with `ctx.storage`. This needs **zero Canvas changes** and touches none of
Canvas's security posture.

This is the whole "open" half of the goal, cleanly.

### 2. In-app status readout — SUPPORTED ONLY via a plugin Python backend

A small "Canvas" status chip/pane (up / down, last-seen) is possible, but **not**
by fetching Canvas from the renderer. Two independent walls block that:

- **No CORS on Canvas.** `src/http/server.ts` emits no
  `Access-Control-Allow-*` headers. A browser cross-origin fetch from the
  desktop app's renderer to `http://127.0.0.1:8787/api/health` is refused by
  the browser's same-origin policy.
- **Origin allowlist.** Even ignoring that, `originAllowed()`
  (`src/http/server.ts:157`) only accepts origins listed in
  `WORKFLOW_CANVAS_ALLOWED_ORIGINS`, which is empty by default. The desktop
  app's origin is not and should not be on it.

The supported path is a **server-side** fetch: ship a `plugin_api.py` that does
a loopback `GET /api/health` from the Hermes process (no browser origin, no CORS
involved) and returns an allowlisted, boolean-ish status. The plugin renders it
with `ctx.rest('/status')` and a `StatusDot`, polling every few seconds, with a
poll fallback where `ctx.socket` is a no-op.

This is the only verified "interact" path, and it is read-only status — it does
not drive the editor.

### 3. In-app embedding of the editor — NOT POSSIBLE as built

Embedding the Canvas editor inside a Hermes pane or route is the obvious wish
and it does not work:

- **Canvas forbids being framed.** `src/http/server.ts:66` sets
  `frame-ancestors 'self'` in the CSP. Any other origin's `<iframe>` or
  `<webview>` pointed at Canvas is refused by the browser. The Hermes desktop
  app is a different origin.
- **No embedding API exists in the plugin SDK.** The import surface is
  `@hermes/plugin-sdk` + React only. A plugin cannot smuggle in a webview.

Making this work would require a Canvas CSP change to add the desktop app's
origin to `frame-ancestors`, and it would mean embedding an
**unauthenticated** loopback service inside the app frame. That is a Canvas
code change plus a security regression, not a plugin capability, and it is
rejected for the thin plugin. If an embedded editor is ever wanted, the correct
prerequisite is the single-user authentication slice (self-hosting plan Slice 6),
and even then embedding is a deliberate, separately-reviewed decision.

## Remote connectivity — do not conflate the two directions

The plugin runs beside Hermes and can call the **Hermes** gateway
(`host.request`). It has no privileged channel to **Canvas**; Canvas is a
separate loopback service with its own (absent) auth. The plugin cannot "connect
Canvas to Hermes."

The existing read-only Hermes job-evidence flow runs the other way:
Canvas pulls an allowlisted observation from a harness-side exporter over SSH
(`harness/hermes/`, `docs/HERMES-INTEGRATION.md`). That is Canvas → Hermes-host,
not plugin-mediated, and it stays that way. The plugin does not replace,
proxy, or extend it.

## Packaging the plugin (which "door")

- **Launcher-only (design 1):** a standalone desktop plugin at
  `$HERMES_HOME/desktop-plugins/workflow-canvas/plugin.js`. Loads enabled by
  default.
- **Launcher + status backend (designs 1+2):** the unified package door —
  `$HERMES_HOME/plugins/workflow-canvas/` carrying `plugin.yaml` +
  `dashboard/plugin_api.py` + `desktop/plugin.js`. The desktop half is opt-in
  (inventories in Capabilities → Plugins, off until the user toggles it), and
  the Python half needs `plugins.enabled` in `config.yaml`. Tell the user to
  flip both on; a "plugin not appearing" report is usually that toggle.

**Publishing a plugin** (shipping this folder, or submitting a catalog entry) is
a distinct release action from publishing Canvas source or releasing the Canvas
package — see `docs/DISTRIBUTION.md`. It needs its own approval and its own
sanitization pass (a plugin that hardcodes a URL, token, or path leaks it).

## Recommendation

Ship design 1 first (open-in-browser launcher) as the thin plugin — it is fully
supported, changes nothing in Canvas, and delivers the "open and interact"
intent for a self-hosted user. Add design 2 (status backend) only if a user
actually asks for an in-app health pill. Do not pursue design 3.

## Open questions

1. Should the plugin's Canvas URL be a plugin setting (`ctx.storage`) with a
   first-run prompt, or read from a shared config? Default: plugin setting.
2. Is the status pane (design 2) wanted at all for the first plugin, or is the
   launcher enough? Default: launcher only.
3. Where does the plugin live for distribution — in this repo under a
   `plugin/` directory, or in a separate repo? Default: a `plugin/` directory
   here, so it versions with the schema it targets.

## Acceptance checks (when a plugin is built, under approval)

1. The launcher chip/command/nav-row appears after **Reload desktop plugins**
   with no error toast, and opens the configured URL in the system browser.
2. With Canvas stopped, the launcher still loads and opens the browser (which
   then shows a connection error) — the plugin does not crash on a dead URL.
3. (design 2 only) With Canvas up, the status backend returns `ok` and the pane
   shows up; with Canvas down, it shows down within one poll interval; the
   renderer makes **no** direct cross-origin request to Canvas (verified in the
   network panel).
4. No hardcoded URL, token, path, or lab identifier anywhere in the plugin
   files (same sanitization scan as the repo).
