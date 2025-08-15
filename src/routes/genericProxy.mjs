import { cfg, getOverlayById, originOf, parseBaseFromReferer, inferOverlayId, readRawBody, unwrapProxyUrl } from '../server_utils.mjs';
import { fetchAsset } from '../overlayFetcher.mjs';
import { getCookieHeader } from '../cookies.mjs';
import { fetch } from 'undici';

export default function genericProxy(app){
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
          const { rewriteCss } = await import('../rewrite_ext.mjs');
          let rewritten = rewriteCss({ css, originUrl: upstream.url, overlayId });
          const scope = req.query.scope;
          if (scope) {
            const { scopeCss } = await import('../css_scope.mjs');
            rewritten = await scopeCss(rewritten, scope);
          }
          outBuf = Buffer.from(rewritten, 'utf8');
          outType = 'text/css; charset=utf-8';
        } catch (e) {
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

  app.all(/^\/[^\/?#]+\.(?:js|mjs|css|map|json|png|jpg|jpeg|gif|webp|svg|woff2?|woff|ttf)$/i, async (req, res) => {
    try {
      const { overlayId, baseUrl } = parseBaseFromReferer(req);
      const filePath = req.path.replace(/^\//, '');

      const candidates = [];
      if (baseUrl) candidates.push({ overlayId, baseUrl });
      if (overlayId && !baseUrl) {
        const ov = getOverlayById(overlayId);
        if (ov) candidates.push({ overlayId, baseUrl: ov.url });
      }
      for (const ov of (cfg.overlays || [])) {
        if (!candidates.find(c => c.baseUrl === ov.url)) {
          candidates.push({ overlayId: ov.id, baseUrl: ov.url });
        }
      }

      for (const cand of candidates) {
        try {
          const upstreamUrl = new URL(filePath, cand.baseUrl).toString();
          const up = await fetchAsset(
            upstreamUrl,
            cfg.cacheSeconds,
            req.headers,
            cand.overlayId,
            cand.baseUrl
          );

          if (up.status === 404) continue;

          res
            .status(up.status)
            .set('Content-Type', up.type || 'application/octet-stream')
            .set('Cache-Control', up.cacheControl || `public, max-age=${cfg.cacheSeconds}`)
            .set('X-Resolved-Url', upstreamUrl)
            .set('X-Overlay', cand.overlayId || '');

          if (up.etag) res.set('ETag', up.etag);
          return res.send(up.buf);
        } catch {
        }
      }

      res.status(404).send('Not found on any overlay base');
    } catch (e) {
      res.status(502).set('X-Proxy-Error', 'bare-file-resolver').send(String(e?.message || e));
    }
  });
}
