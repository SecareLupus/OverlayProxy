import { cfg, getOverlayById, originOf, guessOverlayFromReferer, readRawBody } from '../server_utils.mjs';
import { fetch } from 'undici';

const ABS_PREFIXES = ['/cdn-cgi/', '/assets/', '/static/', '/build/', '/s/', '/dist/'];

export default function absPrefixProxy(app){
  for (const pfx of ABS_PREFIXES) {
    app.all(pfx + '*', async (req, res) => {
      try {
        const ordered = [];
        const fromRef = guessOverlayFromReferer(req);
        if (fromRef) { const ov = getOverlayById(fromRef); if (ov) ordered.push(ov); }
        for (const ov of (cfg.overlays || [])) if (!ordered.includes(ov)) ordered.push(ov);

        const pathWithQuery = req.originalUrl;
        let lastErr;

        for (const ov of ordered) {
          try {
            const upstreamUrl = originOf(ov) + pathWithQuery;
            const headers = { ...req.headers };
            delete headers['host'];
            delete headers['cookie'];
            headers['accept-encoding'] = 'identity';
            headers['origin'] = originOf(ov);
            headers['referer'] = ov.url;

            let body = undefined;
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              body = await readRawBody(req);
            }

            const up = await fetch(upstreamUrl, {
              method: req.method,
              headers,
              body
            });

            if (up.status === 404) { lastErr = 404; continue; }

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
          }
        }

        res.status(404).send('Not found on any overlay origin');
      } catch (e) {
        res.status(502).send(String(e));
      }
    });
  }
}
