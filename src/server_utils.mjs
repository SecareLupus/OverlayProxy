import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchOverlayPage, fetchAsset } from './overlayFetcher.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/default.json'), 'utf8'));

async function discoverOverlayOrigins(){
  const urlRe = /\bhttps?:\/\/[^\s"'<>]+|\bwss?:\/\/[^\s"'<>]+/g;

  const scans = (cfg.overlays || []).map(async ov => {
    const set = new Set(Array.isArray(ov.origins) ? ov.origins : []);

    let baseOrigin;
    try {
      baseOrigin = new URL(ov.url).origin;
      set.add(baseOrigin);
    } catch {
      return;
    }

    try {
      const page = await fetchOverlayPage(ov.url, cfg.cacheSeconds, {}, ov.id, ov.url);
      const html = page.text || '';
      const jsUrls = new Set();
      let m;
      while ((m = urlRe.exec(html)) !== null) {
        try {
          const u = new URL(m[0]);
          set.add(u.origin);
          if (/\.js($|\?)/i.test(u.pathname)) jsUrls.add(u.toString());
        } catch {}
      }

      await Promise.all(Array.from(jsUrls).map(async jsUrl => {
        try {
          const asset = await fetchAsset(jsUrl, cfg.cacheSeconds, {}, ov.id, ov.url);
          const text = asset.buf.toString('utf8');
          let m2;
          while ((m2 = urlRe.exec(text)) !== null) {
            try { set.add(new URL(m2[0]).origin); } catch {}
          }
        } catch {}
      }));
    } catch {}

    set.delete(baseOrigin);
    if (set.size > 0) {
      ov.origins = Array.from(set);
    } else {
      delete ov.origins;
    }
  });

  await Promise.all(scans);
}

await discoverOverlayOrigins();

export function getOverlayById(id){ return (cfg.overlays || []).find(o => o.id === id); }

export function originOf(ov){ try { return new URL(ov.url).origin; } catch { return ''; } }

export function parseBaseFromReferer(req) {
  try {
    const ref = req.headers.referer || '';
    if (!ref) return {};
    const ru = new URL(ref);
    if (ru.pathname === '/proxy') {
      return {
        overlayId: ru.searchParams.get('overlay') || undefined,
        baseUrl: ru.searchParams.get('url') || undefined
      };
    }
    const m = ru.pathname.match(/\/overlay\/([^\/?#]+)/);
    if (m) {
      const overlayId = m[1];
      const ov = getOverlayById(overlayId);
      if (ov) return { overlayId, baseUrl: ov.url };
    }
  } catch {}
  return {};
}

export function guessOverlayFromReferer(req){
  const ref = req.headers.referer || '';
  const m = ref.match(/\/overlay\/([^\/?#]+)/);
  return m ? m[1] : null;
}

export function inferOverlayId(req){
  return (
    req.query.overlay ||
    parseBaseFromReferer(req).overlayId ||
    cfg.defaultOverlay ||
    null
  );
}

export async function readRawBody(req){
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function unwrapProxyUrl(urlStr){
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
