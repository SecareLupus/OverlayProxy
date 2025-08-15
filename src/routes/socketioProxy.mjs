import { cfg, originOf, orderedOverlays, readRawBody } from '../server_utils.mjs';
import { fetch } from 'undici';
import { getCookieHeader } from '../cookies.mjs';

export default function socketioProxy(app){
  app.all('/socket.io/*', async (req, res) => {
    try {
      const ordered = orderedOverlays(req, req.query.overlay);

      for (const ov of ordered) {
        const upstreamUrl = originOf(ov) + req.originalUrl.replace(/([?&])overlay=[^&]+&?/, '$1').replace(/[?&]$/, '');
        const headers = { ...req.headers, origin: originOf(ov), referer: ov.url, 'accept-encoding': 'identity' };
        delete headers.host;
        const cookie = await getCookieHeader(ov.id, upstreamUrl);
        if (cookie) headers.cookie = cookie;

        const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : await readRawBody(req);
        const up = await fetch(upstreamUrl, { method: req.method, headers, body });

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
}
