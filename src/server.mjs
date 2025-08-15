import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import etag from 'etag';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fetchOverlayPage, fetchAsset } from './overlayFetcher.mjs';
import { rewriteHtml, rewriteCss } from './rewrite_ext.mjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetch } from 'undici';
import httpProxy from 'http-proxy';
import { WebSocketServer } from 'ws';
import { getCookieHeader } from './cookies.mjs';
import crypto from 'crypto';
import { cfg, getOverlayById, originOf, parseBaseFromReferer, guessOverlayFromReferer, inferOverlayId } from './server_utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');
app.use(morgan('dev'));
app.use(compression());
app.use(cors({ origin: process.env.ORIGIN_ALLOW || '*'}));

function unwrapProxyUrl(urlStr){
  try {
    let cur = new URL(urlStr);
    for (let i = 0; i < 4; i++) {
      const inner = cur.searchParams.get('url');
      if (!inner) break;
      cur = new URL(inner, cur);
    }
    return cur.toString();
  } catch { return urlStr; }
}


// Read raw request body as Buffer (for POST/PUT/PATCH)
async function readRawBody(req){
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function coercePage(upstream) {
  if (typeof upstream === 'string') return { ok: true, status: 200, text: upstream };
  return upstream || { ok: false, status: 502, text: '' };
}

// Absolute-path prefixes we’ll proxy (expand as needed)
const ABS_PREFIXES = ['/cdn-cgi/', '/assets/', '/static/', '/build/', '/s/', '/dist/'];

for (const pfx of ABS_PREFIXES) {
  app.all(pfx + '*', async (req, res) => {
    try {
      // Try the overlay referenced by the page first, then fall back to others
      const ordered = [];
      const fromRef = guessOverlayFromReferer(req);
      if (fromRef) { const ov = getOverlayById(fromRef); if (ov) ordered.push(ov); }
      for (const ov of (cfg.overlays || [])) if (!ordered.includes(ov)) ordered.push(ov);

      const pathWithQuery = req.originalUrl; // e.g. /cdn-cgi/challenge-platform/...
      let lastErr;

      for (const ov of ordered) {
        try {
          const upstreamUrl = originOf(ov) + pathWithQuery;

          // Build headers for upstream; spoof expected Origin/Referer; force identity encoding
          const headers = { ...req.headers };
          delete headers['host'];
          delete headers['cookie']; // cookie via jar internally if you wired it; otherwise pass through
          headers['accept-encoding'] = 'identity';
          headers['origin'] = originOf(ov);
          headers['referer'] = ov.url;

          // Body only for non-GET/HEAD
          let body = undefined;
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            body = await readRawBody(req);
          }

          const up = await fetch(upstreamUrl, {
            method: req.method,
            headers,
            body
          });

          // If upstream clearly not found, try next overlay
          if (up.status === 404) { lastErr = 404; continue; }

          // Pass status/headers/body through
          const buf = Buffer.from(await up.arrayBuffer());
          const type = up.headers.get('content-type') || 'application/octet-stream';
          const cc   = up.headers.get('cache-control') || `public, max-age=${cfg.cacheSeconds}`;
          const et   = up.headers.get('etag');

          res.status(up.status);
          res.setHeader('Content-Type', type);
          res.setHeader('Cache-Control', cc);
          if (et) res.setHeader('ETag', et);
          res.setHeader('X-Resolved-Url', upstreamUrl);
          res.setHeader('X-Overlay', ov.id);
          return res.send(buf);
        } catch (e) {
          lastErr = e;
          // try next overlay
        }
      }

      // If we get here, nothing matched
      res.status(404).send('Not found on any overlay origin');
    } catch (e) {
      res.status(502).send(String(e));
    }
  });
}

app.all('/socket.io/*', async (req, res) => {
  try {
    const ovParam = req.query.overlay; // thanks to shim
    const ordered = [];
    if (ovParam) { const ov = getOverlayById(ovParam); if (ov) ordered.push(ov); }
    for (const ov of (cfg.overlays || [])) if (!ordered.includes(ov)) ordered.push(ov);

    for (const ov of ordered) {
      const upstreamUrl = originOf(ov) + req.originalUrl.replace(/([?&])overlay=[^&]+&?/, '$1').replace(/[?&]$/, '');
      const headers = { ...req.headers, origin: originOf(ov), referer: ov.url, 'accept-encoding': 'identity' };
      delete headers.host; // we’re proxying
      // include cookie from jar
      const cookie = await getCookieHeader(ov.id, upstreamUrl);
      if (cookie) headers.cookie = cookie;

      const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : await readRawBody(req);
      const up = await fetch(upstreamUrl, { method: req.method, headers, body });

      // pass through
      const buf = Buffer.from(await up.arrayBuffer());
      res.status(up.status);
      res.set('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
      res.set('Cache-Control', up.headers.get('cache-control') || 'no-store');
      res.set('X-Resolved-Url', upstreamUrl);
      res.set('X-Overlay', ov.id);
      return res.send(buf);
    }
    res.status(404).send('socket.io: no overlay matched');
  } catch (e) {
    res.status(502).set('X-Proxy-Error', 'socketio').send(String(e?.message || e));
  }
});

// Static
app.use(express.static(path.join(__dirname, '../public')));
app.get('/config.json', (_req, res)=> res.json(cfg));

app.get('/config.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  // Prevent stale caching while you’re iterating:
  res.setHeader('Cache-Control', 'no-store');
  res.send(`export default ${JSON.stringify(cfg)};`);
});

// Proxy an arbitrary asset (rewritten URLs route here)
app.get('/proxy', async (req, res) => {
  try {
    const raw = req.query.url;
    if (!raw) return res.status(400).send('Missing url');

    const overlayId = inferOverlayId(req);
    if (!overlayId) {
      console.warn('proxy: no overlay', raw, req.headers.referer || '');
      return res.status(400).set('X-Proxy-Error', 'overlay-missing').send('Overlay not resolved');
    }
    const ov = getOverlayById(overlayId);
    if (!ov) return res.status(404).send('Overlay not found');

    const resolvedUrl = unwrapProxyUrl(raw);
    const headers = { ...req.headers, origin: originOf(ov), referer: ov.url };
    delete headers.host;

    const upstream = await fetchAsset(resolvedUrl, cfg.cacheSeconds, headers, overlayId, ov.url);

    let outBuf = upstream.buf;
    let outType = upstream.type;

    if (upstream.type && /^text\/css/i.test(upstream.type)) {
      try {
        const css = upstream.buf.toString('utf8');
        const { rewriteCss } = await import('./rewrite_ext.mjs');
        let rewritten = rewriteCss({ css, originUrl: upstream.url, overlayId });
        const scope = req.query.scope; // e.g. [data-ov="alerts"], URL-decoded by Express
        if (scope) {
          const { scopeCss } = await import('./css_scope.mjs');
          rewritten = await scopeCss(rewritten, scope);
        }
        outBuf = Buffer.from(rewritten, 'utf8');
        outType = 'text/css; charset=utf-8';
      } catch (e) {
        // If scoping fails, return unscoped CSS with a header so we can see it in DevTools
        res.set('X-Proxy-Warn', `css-scope-failed: ${e?.message || e}`);
        outBuf = upstream.buf;
        outType = upstream.type;
      }
    }

    res
      .status(upstream.status)
      .set('Content-Type', outType)
      .set('Cache-Control', upstream.cacheControl || `public, max-age=${cfg.cacheSeconds}`)
      .set('X-Resolved-Url', resolvedUrl)
      .set('X-Upstream-Status', String(upstream.status))
      .set('X-Overlay', overlayId);

    if (upstream.etag) res.set('ETag', upstream.etag);
    return res.send(outBuf);
  } catch (e) {
    res.status(502).set('X-Proxy-Error', 'proxy-route').send(String(e?.message || e));
  }
});

// Generic same-origin proxy: infer overlay when possible
app.all('*', async (req, res, next) => {
  if (req.path.startsWith('/overlay/')) return next();
  if (/^\/[^\/?#]+\.(?:js|mjs|css|map|json|png|jpg|jpeg|gif|webp|svg|woff2?|woff|ttf)$/i.test(req.path)) return next();

  const overlayId = inferOverlayId(req);
  if (!overlayId) {
    console.warn('generic: no overlay', req.method, req.originalUrl, req.headers.referer || '');
    return res.status(400).set('X-Proxy-Error', 'overlay-missing').send('Overlay not resolved');
  }

  const ov = getOverlayById(overlayId);
  if (!ov) return res.status(404).send('Overlay not found');

  try {
    const upstreamUrl = originOf(ov) + req.originalUrl.replace(/([?&])overlay=[^&]+&?/, '$1').replace(/[?&]$/, '');
    const headers = { ...req.headers, origin: originOf(ov), referer: ov.url, 'accept-encoding': 'identity' };
    delete headers.host;
    delete headers.cookie;
    const cookie = await getCookieHeader(ov.id, upstreamUrl);
    if (cookie) headers.cookie = cookie;
    const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : await readRawBody(req);
    const up = await fetch(upstreamUrl, { method: req.method, headers, body });
    const buf = Buffer.from(await up.arrayBuffer());
    res.status(up.status);
    res.set('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
    res.set('Cache-Control', up.headers.get('cache-control') || 'no-store');
    res.set('X-Resolved-Url', upstreamUrl);
    res.set('X-Upstream-Status', String(up.status));
    res.set('X-Overlay', ov.id);
    return res.send(buf);
  } catch (e) {
    res.status(502).set('X-Proxy-Error', 'generic').send(String(e?.message || e));
  }
});

// One-segment filenames at our root like /foo.js, /bar.css, /socket.io.js.map
app.all(/^\/[^\/?#]+\.(?:js|mjs|css|map|json|png|jpg|jpeg|gif|webp|svg|woff2?|woff|ttf)$/i, async (req, res) => {
  try {
    const { overlayId, baseUrl } = parseBaseFromReferer(req);
    const filePath = req.path.replace(/^\//, ''); // e.g. 'socket.io.js.map'

    // Build an ordered list of candidate bases to resolve against
    const candidates = [];
    if (baseUrl) candidates.push({ overlayId, baseUrl });
    if (overlayId && !baseUrl) {
      const ov = getOverlayById(overlayId);
      if (ov) candidates.push({ overlayId, baseUrl: ov.url });
    }
    // Fallback: try all overlays' origins
    for (const ov of (cfg.overlays || [])) {
      if (!candidates.find(c => c.baseUrl === ov.url)) {
        candidates.push({ overlayId: ov.id, baseUrl: ov.url });
      }
    }

    // Try candidates until one returns non-404
    for (const cand of candidates) {
      try {
        const upstreamUrl = new URL(filePath, cand.baseUrl).toString(); // resolves relative to the referer’s base DIR
        const up = await fetchAsset(
          upstreamUrl,
          cfg.cacheSeconds,
          req.headers,
          cand.overlayId,
          cand.baseUrl
        );

        // If upstream is 404, try next candidate
        if (up.status === 404) continue;

        // Success or other status — pass through
        res
          .status(up.status)
          .set('Content-Type', up.type || 'application/octet-stream')
          .set('Cache-Control', up.cacheControl || `public, max-age=${cfg.cacheSeconds}`)
          .set('X-Resolved-Url', upstreamUrl)
          .set('X-Overlay', cand.overlayId || '');

        if (up.etag) res.set('ETag', up.etag);
        return res.send(up.buf);
      } catch {
        // try next candidate
      }
    }

    // Nothing matched
    res.status(404).send('Not found on any overlay base');
  } catch (e) {
    res.status(502).set('X-Proxy-Error', 'bare-file-resolver').send(String(e?.message || e));
  }
});

// /overlay/:id (full page for iframe) and /overlay/:id/fragment (DOM merge)
app.get('/overlay/:id', async (req, res) => {
  const ov = getOverlayById(req.params.id);
  if (!ov) return res.status(404).send('Overlay not found');
  try {
    const upstream = coercePage(await fetchOverlayPage(ov.url, cfg.cacheSeconds, req.headers, ov.id, ov.url));
    const { rewriteHtml } = await import('./rewrite_ext.mjs');
    const out = await rewriteHtml({ html: upstream.text || '', originUrl: ov.url, overlayId: ov.id });
    res.status(upstream.status).set('Content-Type', 'text/html; charset=utf-8').send(out);
  } catch (e) {
    res.status(502).set('X-Proxy-Error', 'overlay-full').send(String(e?.message || e));
  }
});

// /overlay/:id/fragment
app.get('/overlay/:id/fragment', async (req, res) => {
  const ov = getOverlayById(req.params.id);
  if (!ov) return res.status(404).send('Overlay not found');
  try {
    const upstream = coercePage(await fetchOverlayPage(ov.url, cfg.cacheSeconds, req.headers, ov.id, ov.url));
    const { rewriteHtml } = await import('./rewrite_ext.mjs');
    let html = await rewriteHtml({ html: upstream.text || '', originUrl: ov.url, overlayId: ov.id });
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const fragment = bodyMatch ? bodyMatch[1] : html;
    res.status(upstream.status).set('Content-Type', 'text/html; charset=utf-8').send(fragment);
  } catch (e) {
    res.status(502).set('X-Proxy-Error', 'overlay-fragment').send(String(e?.message || e));
  }
});

app.get('/overlay/:id/full', async (req, res)=>{
  const ov = (cfg.overlays || []).find(o => o.id === req.params.id);
  if (!ov) return res.status(404).send('Overlay not found');

  try {
    const upstream = coercePage(await fetchOverlayPage(ov.url, cfg.cacheSeconds, req.headers, ov.id, ov.url));
    const scopeSelector = ov.isolation === 'light' ? `[data-ov="${ov.id}"]` : undefined;

    const { rewriteHtml } = await import('./rewrite_ext.mjs');
    const html = await rewriteHtml({
      html: upstream.text || '',
      originUrl: ov.url,
      overlayId: ov.id,
      scopeSelector
    });

    res
      .status(upstream.status)
      .set('Content-Type', 'text/html; charset=utf-8')
      .set('X-Upstream-Status', String(upstream.status))
      .send(html);
  } catch (e) {
    // Final safety net: return unmodified upstream text so you never see a 502
    res
      .status(200)
      .set('Content-Type', 'text/html; charset=utf-8')
      .set('X-Proxy-Error', `overlay-full:${e?.message || e}`)
      .send('<!doctype html><meta charset="utf-8"><body style="color:#f55;background:#111;font:14px/1.4 monospace;padding:12px">Overlay rewrite failed. Check console/network headers.<br>' +
            String(e?.message || e) + '</body>');
  }
});

// WebSocket proxy (for upstream overlay sockets)
const wsProxy = httpProxy.createProxyServer({
  changeOrigin: true,
  ws: true,
  secure: true,
  ignorePath: true, // we'll compute full upstream URL ourselves
});

wsProxy.on('error', (err, _req, socket) => {
  console.warn('ws proxy error', err);
  if (socket) try { socket.destroy(); } catch {}
});

// Simple control bus for your compositor clients
const controlWss = new WebSocketServer({ noServer: true });
const controlClients = new Set();
controlWss.on('connection', (ws) => {
  controlClients.add(ws);
  ws.on('close', () => controlClients.delete(ws));
  ws.on('message', (data) => {
    // optional: echo pings or act on messages from clients
    // const msg = JSON.parse(data.toString());
  });
});
function broadcast(msg) {
  const body = JSON.stringify(msg);
  for (const ws of controlClients) if (ws.readyState === ws.OPEN) ws.send(body);
}

const CONTROL_TOKEN = process.env.CONTROL_TOKEN || crypto.randomBytes(8).toString('hex');
console.log(`[overlay-proxy] CONTROL_TOKEN: ${CONTROL_TOKEN}`);

app.use(express.json({ limit: '128kb' }));

function requireControlAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || token !== CONTROL_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Fire a control message to all connected compositor clients
app.post('/api/control', requireControlAuth, (req, res) => {
  const msg = req.body || {};
  // Minimal validation
  if (!msg.type) return res.status(400).json({ error: 'missing type' });
  broadcast(msg);  // <-- from the WSS code you already added
  res.json({ ok: true });
});

// Optional: quick health/state endpoint (no auth)
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, clients: controlClients.size });
});

// OBS-friendly headers
app.use((_, res, next)=>{
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

const PORT = process.env.PORT || 4321;
const server = app.listen(PORT, () => console.log(`[overlay-proxy] http://localhost:${PORT}`));

// Which WS paths should we proxy to overlay origins?
const WS_PREFIXES = ['/socket.io', '/ws', '/realtime', '/live', '/cable']; // add new WS paths here

server.on('upgrade', async (req, socket, head) => {
  // Avoid crashing on client socket errors (e.g. ECONNRESET)
  socket.on('error', err => console.warn('ws client error', err));

  try {
    const url = new URL(req.url, 'http://localhost'); // parse only
    const path = url.pathname;

    // control bus
    if (path === '/_control') {
      return controlWss.handleUpgrade(req, socket, head, ws => {
        controlWss.emit('connection', ws, req);
      });
    }

    // socket.io & friends on our origin (matches any prefix in WS_PREFIXES)
    if (WS_PREFIXES.some(pfx => path.startsWith(pfx))) {
      const overlayId = url.searchParams.get('overlay');
      let candidates = [];
      if (overlayId) {
        const ov = getOverlayById(overlayId);
        if (ov) candidates.push(ov);
      }
      for (const ov of (cfg.overlays || [])) if (!candidates.includes(ov)) candidates.push(ov);

      for (const ov of candidates) {
        try {
          const baseHttp = originOf(ov); if (!baseHttp) continue;
          const baseWs = baseHttp.replace(/^http/, 'ws');
          // reconstruct upstream url WITHOUT our overlay param
          url.searchParams.delete('overlay');
          const upstream = baseWs + url.pathname + (url.search ? url.search : '');
          const cookie = await getCookieHeader(ov.id, upstream.replace(/^ws/, 'http'));
          const headers = { origin: baseHttp, referer: ov.url };
          if (cookie) headers.cookie = cookie;
          return wsProxy.ws(req, socket, head, { target: upstream, headers });
        } catch { /* try next */ }
      }
      socket.destroy();
      return;
    }

    // generic tunnel: /__ws?target=wss%3A%2F%2Fexample.com%2Fpath&overlay=<id?>
    if (path === '/__ws') {
      const target = url.searchParams.get('target');
      const overlayId = url.searchParams.get('overlay') || undefined;
      if (!target) return socket.destroy();

      const ov = overlayId ? getOverlayById(overlayId) : null;
      const baseHttp = ov ? originOf(ov) : new URL(target).origin.replace(/^ws/, 'http');

      const headers = {
        origin: baseHttp,
        referer: ov?.url || baseHttp + '/',
      };
      if (ov) {
        const cookie = await getCookieHeader(ov.id, target.replace(/^ws/, 'http'));
        if (cookie) headers.cookie = cookie;
      }
      return wsProxy.ws(req, socket, head, { target, headers });
    }

    // anything else: close
    socket.destroy();
  } catch {
    socket.destroy();
  }
});
