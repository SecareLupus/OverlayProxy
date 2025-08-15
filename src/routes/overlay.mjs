import { cfg, getOverlayById } from '../server_utils.mjs';
import { fetchOverlayPage } from '../overlayFetcher.mjs';

function coercePage(upstream) {
  if (typeof upstream === 'string') return { ok: true, status: 200, text: upstream };
  return upstream || { ok: false, status: 502, text: '' };
}

export default function overlayRoutes(app){
  app.get('/overlay/:id', async (req, res) => {
    const ov = getOverlayById(req.params.id);
    if (!ov) return res.status(404).send('Overlay not found');
    try {
      const upstream = coercePage(
        await fetchOverlayPage(
          ov.url,
          cfg.cacheSeconds,
          req.headers,
          ov.id,
          ov.url,
          cfg.useCache
        )
      );
      const { rewriteHtml } = await import('../rewrite_ext.mjs');
      const out = await rewriteHtml({ html: upstream.text || '', originUrl: ov.url, overlayId: ov.id });
      res.status(upstream.status).set('Content-Type', 'text/html; charset=utf-8').send(out);
    } catch (e) {
      res.status(502).set('X-Proxy-Error', 'overlay-full').send(String(e?.message || e));
    }
  });

  app.get('/overlay/:id/fragment', async (req, res) => {
    const ov = getOverlayById(req.params.id);
    if (!ov) return res.status(404).send('Overlay not found');
    try {
      const upstream = coercePage(
        await fetchOverlayPage(
          ov.url,
          cfg.cacheSeconds,
          req.headers,
          ov.id,
          ov.url,
          cfg.useCache
        )
      );
      const { rewriteHtml } = await import('../rewrite_ext.mjs');
      let html = await rewriteHtml({ html: upstream.text || '', originUrl: ov.url, overlayId: ov.id });
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const fragment = bodyMatch ? bodyMatch[1] : html;
      res.status(upstream.status).set('Content-Type', 'text/html; charset=utf-8').send(fragment);
    } catch (e) {
      res.status(502).set('X-Proxy-Error', 'overlay-fragment').send(String(e?.message || e));
    }
  });

  app.get('/overlay/:id/full', async (req, res) => {
    const ov = (cfg.overlays || []).find(o => o.id === req.params.id);
    if (!ov) return res.status(404).send('Overlay not found');

    try {
      const upstream = coercePage(
        await fetchOverlayPage(
          ov.url,
          cfg.cacheSeconds,
          req.headers,
          ov.id,
          ov.url,
          cfg.useCache
        )
      );
      const scopeSelector = ov.isolation === 'light' ? `[data-ov="${ov.id}"]` : undefined;
      const { rewriteHtml } = await import('../rewrite_ext.mjs');
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
      res
        .status(200)
        .set('Content-Type', 'text/html; charset=utf-8')
        .set('X-Proxy-Error', `overlay-full:${e?.message || e}`)
        .send('<!doctype html><meta charset="utf-8"><body style="color:#f55;background:#111;font:14px/1.4 monospace;padding:12px">Overlay rewrite failed. Check console/network headers.<br>' + String(e?.message || e) + '</body>');
    }
  });
}
