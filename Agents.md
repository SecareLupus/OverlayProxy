Mission & Scope

Goal: Load multiple third-party streaming overlays into one OBS Browser Source to reduce RAM/CPU while preserving overlay functionality (including Socket.IO / WebSockets, Cloudflare beacons, YouTube widgets, etc.).

You (Codex) should prioritize: correctness of network proxying, DOM isolation/scoping, and stability over micro-optimizations.

Out of scope: shipping provider credentials or secrets; modifying third-party overlay logic beyond compatibility shims.

Project Map
/config/
  default.json            # overlay list & layout; cacheSeconds; per-overlay options
/public/
  index.html
  compositor.mjs          # client boot; compositor; global runtime shims; control socket
/src/
  server.mjs              # Express app, HTTP routes, WS upgrade router, control API
  overlayFetcher.mjs      # fetchOverlayPage(), fetchAsset() with cookie jar & identity encoding
  rewrite_ext.mjs         # HTML/CSS rewriter; URL unwrapping; inline-style scoping
  css_scope.mjs           # PostCSS selector prefixer (namespacing via :where([data-ov="ID"]))
  cookies.mjs             # tough-cookie integration + helpers

Runtime “agents” (key responsibilities)

Compositor (client): mounts overlays in one page

Modes: dom+shadow (default), dom+light (needs CSS scoping), iframe (fallback).

Installs global shims for WebSocket, fetch, and XMLHttpRequest.

Tracks active overlay during script execution (__ovActiveOverlay / __ovLastOverlay) so same-origin /socket.io calls are tagged with ?overlay=<id>.

HTTP Proxy (server):

/overlay/:id and /overlay/:id/full fetch+rewrite overlay HTML (never 502; fail-open with headers).

/proxy?overlay=<id>&url=<abs> fetches assets and rewrites CSS url()/srcset, scopes CSS when &scope=[data-ov="ID"].

Absolute-path passthrough for /cdn-cgi/*, /socket.io/*, /assets/*, etc. (all methods, not just GET).

Bare-filename resolver (e.g., /json-*.js, socket.io.js.map) using Referer → overlay base URL.

WS Gateway (server):

Upgrades /socket.io/* using ?overlay=<id> (added by shims) → routes to the correct provider origin with spoofed Origin/Referer and cookies.

Generic tunnel /__ws?target=wss://…&overlay=<id> for absolute WS endpoints.

Control Bus:

WSS /_control + HTTP bridge POST /api/control (Bearer token) → {type:'reload'|'visibility', id?:string, visible?:bool}.

How to Run (local)
# prerequisites: Node.js >= 18.17 (ESM + fetch in Node) and npm

npm i
npm run dev           # or: node src/server.mjs
# visit http://localhost:4321/ in a clean Chrome/Chromium profile (no adblockers).


Environment variables

PORT (default 4321)

CONTROL_TOKEN (Bearer for /api/control); set in a local .env or shell env.

Control examples

# Health
curl http://localhost:4321/api/health

# Broadcast a page reload
curl -X POST http://localhost:4321/api/control \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"reload"}'

# Reload a single overlay
curl -X POST http://localhost:4321/api/control \
  -H "Authorization: Bearer $CONTROL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"reload","id":"alerts"}'

Coding Conventions

Language: TypeScript not used; ESM JavaScript ("type": "module"). Keep ESM imports.

Style: Prefer small pure helpers, top-level async route handlers, and explicit try/catch with diagnostic headers (never mask upstream status).

Headers: Always set:

X-Resolved-Url (final upstream URL),

X-Upstream-Status (status from upstream),

X-Overlay (overlay id) where applicable,

X-Proxy-Warn / X-Proxy-Error for non-fatal/fatal diagnostics.

Critical Invariants (do not break)

Identity encoding for text assets.
When fetching HTML/CSS/JS, set Accept-Encoding: identity to avoid double-compression and binary “soup”. Keep upstream Content-Type sane.

Never tunnel our own control channel.
The WS shim must not rewrite /_control or same-host non-overlay sockets.

Deterministic overlay routing for Socket.IO.

Client shims must append overlay=<id> to same-origin /socket.io polling and websocket URLs.

Server must remove our overlay param before forwarding upstream, but use it to choose the overlay origin.

Absolute-path passthrough is all-methods.
Cloudflare beacon POSTs under /cdn-cgi/* must be forwarded; don’t 404.

Light-DOM overlays must be CSS-scoped.
Use :where([data-ov="<ID>"]) so specificity doesn’t inflate; rewrite :root/html/body to the scope container.

Fail-open on CSS scoping (inline or external).
If PostCSS/selector parsing fails, return unscoped (but rewritten) CSS and emit X-Proxy-Warn.

Cookie jar per overlay.
Attach cookies to upstream requests (HTTP and WS), and store Set-Cookie from upstream. Never log cookie values.

URL unwrapping.
If an upstream URL itself contains ?url=… (nested proxy), unwrap to the real absolute URL prior to fetching.

Typical Tasks (what you can change / add)
Add a new overlay provider

Add an entry in config/default.json:

{
  "id": "newprov",
  "url": "https://example.com/overlay",
  "x": 0, "y": 0, "width": 1920, "height": 1080, "z": 10,
  "mode": "dom",
  "isolation": "shadow"         // try shadow first; if it needs globals, use "light"
}


If it requires global DOM: switch to "isolation": "light". The server will scope CSS; client will hoist styles and run scripts sequentially.

If it still fails due to CSP or tight globals: try "mode": "iframe" as a last resort.

Support a new absolute WS path

Add the prefix to the WS upgrade check in server.mjs (e.g., /realtime, /live).

The generic __ws tunnel already covers absolute wss://… endpoints.

Fix a 404 on bare runtime files

Ensure the bare-filename resolver route is present (resolves /<file>.js against the overlay base from the Referer).

Verify X-Resolved-Url points to the intended upstream file.

Debug Playbook

Only one WS (/_control) visible

Confirm the shims installed before mounting overlays (look for [shim] logs in console).

Verify you see polling requests: /socket.io/?transport=polling&…&overlay=<id> in Network → XHR.

If missing, the shim isn’t tagging or the overlay never attempted—check mounting order and __ovActiveOverlay.

Polling returns non-200/204

Inspect response headers: X-Upstream-Status, X-Resolved-Url, X-Overlay.

If 403/404, confirm server forwarded Origin (overlay origin), Referer (overlay page), and cookies (from jar).

WS upgrades close immediately

Click the WS request; confirm it’s either __ws?target=…&overlay=<id> or /socket.io/?…&overlay=<id>.

If upstream denies: adjust Origin/Referer or include protocol headers (Sec-WebSocket-Protocol) if provider requires.

Cloudflare challenge noise

Ensure /cdn-cgi/* proxy handles POST beacon endpoints (not just GET).

It’s normal to see background beacons; they should be forwarded, not blocked.

CSS bleed or broken layout

For light-DOM overlays, confirm stylesheet URLs include &scope=[data-ov="ID"] and inline styles were scoped.

If an overlay injects new <style> at runtime, consider adding a MutationObserver that re-scopes dynamically (optional).

Security

Treat third-party overlays as trusted to execute script, but never log cookies, tokens, or full URLs with credentials.

CONTROL_TOKEN must protect /api/control. Keep it in .env or shell, not committed.

Don’t strip CSP unless necessary (and only for overlays explicitly marked for light-DOM).