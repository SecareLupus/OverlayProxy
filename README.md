# Overlay Proxy

## Quick start
```bash
npm i
npm run dev
# In OBS Browser Source: http://localhost:4321/

Sessions (minimal cookie jar)

The proxy stores per-overlay cookies in memory and automatically attaches them on future requests. Good for overlays that require login/session or use cookies for feature flags. HttpOnly cookies never leave the server.

To persist across restarts, serialize the jar to disk later.

CSS url() + srcset rewriting

Backgrounds, sprites, fonts, and responsive images are now proxied (even when using relative paths), which reduces CORS/CSP friction and avoids broken assets.