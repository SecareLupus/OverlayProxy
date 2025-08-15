import httpProxy from 'http-proxy';
import { controlWss } from './controlBus.mjs';
import { getCookieHeader } from './cookies.mjs';
import { cfg, getOverlayById, originOf } from './server_utils.mjs';

const wsProxy = httpProxy.createProxyServer({
  changeOrigin: true,
  ws: true,
  secure: true,
  ignorePath: true,
});

wsProxy.on('error', (err, _req, socket) => {
  console.warn('ws proxy error', err);
  if (socket) try { socket.destroy(); } catch {}
});

export default function setupWsUpgrade(server) {
  const WS_PREFIXES = ['/socket.io', '/ws', '/realtime', '/live', '/cable'];

  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', err => console.warn('ws client error', err));

    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;

      if (path === '/_control') {
        return controlWss.handleUpgrade(req, socket, head, ws => {
          controlWss.emit('connection', ws, req);
        });
      }

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
            url.searchParams.delete('overlay');
            const upstream = baseWs + url.pathname + (url.search ? url.search : '');
            const cookie = await getCookieHeader(ov.id, upstream.replace(/^ws/, 'http'));
            const headers = { origin: baseHttp, referer: ov.url };
            if (cookie) headers.cookie = cookie;
            return wsProxy.ws(req, socket, head, { target: upstream, headers });
          } catch { }
        }
        socket.destroy();
        return;
      }

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

      socket.destroy();
    } catch {
      socket.destroy();
    }
  });
}
