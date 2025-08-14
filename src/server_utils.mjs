import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/default.json'), 'utf8'));

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
