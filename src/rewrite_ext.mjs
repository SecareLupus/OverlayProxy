import * as cheerio from 'cheerio';
import { toAbs } from './util.mjs';
import { scopeCss } from './css_scope.mjs';

// Peel vendor proxy layers like .../proxy?url=ENCODED
function unwrapProxy(u, base){
  try {
    let cur = new URL(u, base);
    for (let i = 0; i < 4; i++) {
      const inner = cur.searchParams.get('url');
      if (!inner) break;
      cur = new URL(inner, cur);
    }
    return cur.toString();
  } catch { return u; }
}

// Match url("..."), url('...'), or url(bare)
const URL_RE = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^"')]+))\s*\)/g;

export function rewriteCss({ css, originUrl, overlayId }){
  const normalize = (u) => unwrapProxy(toAbs(originUrl, u), originUrl);
  const prox = (u) => `/proxy?overlay=${encodeURIComponent(overlayId)}&url=${encodeURIComponent(normalize(u))}`;
  return css.replace(URL_RE, (m, dq, sq, bare) => {
    const u = dq || sq || bare;
    if (!u || u.startsWith('data:') || u.startsWith('blob:')) return m;
    const nu = prox(u);
    if (dq) return `url("${nu}")`;
    if (sq) return `url('${nu}')`;
    return `url(${nu})`;
  });
}

function rewriteSrcsetValue(val, originUrl, overlayId){
  if (!val) return val;
  const normalize = (u) => unwrapProxy(toAbs(originUrl, u), originUrl);
  const prox = (u) => `/proxy?overlay=${encodeURIComponent(overlayId)}&url=${encodeURIComponent(normalize(u))}`;
  return val.split(',')
    .map(s => s.trim()).filter(Boolean)
    .map(part => {
      const bits = part.split(/\s+/, 2);
      const url = bits[0]; const descriptor = bits[1];
      if (!url || url.startsWith('data:') || url.startsWith('blob:')) return part;
      const nu = prox(url);
      return descriptor ? `${nu} ${descriptor}` : nu;
    })
    .join(', ');
}

export async function rewriteHtml({ html, originUrl, overlayId, scopeSelector }) {
  if (typeof html !== 'string') html = String(html ?? '');
  const $ = cheerio.load(html, { decodeEntities: false });
  const normalize = (u) => unwrapProxy(toAbs(originUrl, u), originUrl);
  const prox = (u, extra = {}) => {
    const sp = new URLSearchParams({ overlay: overlayId, url: normalize(u), ...extra });
    return `/proxy?${sp.toString()}`;
  };

  // Rewrites for link/script/src/srcset (same as before)...
  $('link[href]').each((_, el)=> {
    const href = $(el).attr('href');
    if (!href) return;
    const isCss = (/stylesheet/i).test($(el).attr('rel') || '') || /\.css(\?|$)/i.test(href);
    // If this is a stylesheet and a scope is requested, pass scope param to /proxy
    $(el).attr('href', prox(href, isCss && scopeSelector ? { scope: scopeSelector } : {}));
  });

  $('script[src]').each((_, el)=> {
    const src = $(el).attr('src');
    if (src) $(el).attr('src', prox(src));
  });

  $('[src]').each((_, el)=> {
    const src = $(el).attr('src');
    if (src) $(el).attr('src', prox(src));
  });

  $('[data-src]').each((_, el)=> {
    const src = $(el).attr('data-src');
    if (src) $(el).attr('data-src', prox(src));
  });

  $('img[srcset], source[srcset], link[imagesrcset]').each((_, el) => {
    const attr = el.name === 'link' ? 'imagesrcset' : 'srcset';
    const val = $(el).attr(attr);
    if (val) $(el).attr(attr, rewriteSrcsetValue(val, originUrl, overlayId));
  });

  // Inline <style> blocks: rewrite urls and optionally scope
  const styleNodes = [];
  $('style').each((_, el) => styleNodes.push(el));

  for (const el of styleNodes) {
    const raw = $(el).html() || '';
    const rewrittenUrls = rewriteCss({ css: raw, originUrl, overlayId });

    if (scopeSelector) {
      try {
        const scoped = await scopeCss(rewrittenUrls, scopeSelector);
        $(el).text(scoped);
      } catch (err) {
        // Fail open: keep functioning CSS and annotate so you can spot it in View Source
        $(el).text(
          rewrittenUrls + `\n/* overlay-proxy: scope failed (${(err && err.message) || err}) */`
        );
      }
    } else {
      $(el).text(rewrittenUrls);
    }
  }

  $('html,body').attr('style', (i, s)=> `${s||''}; background: transparent !important;`);
  // Strip meta CSP if scoping (trusted overlays) to reduce friction
  if (scopeSelector) $('meta[http-equiv="Content-Security-Policy"]').remove();

  return $.html();
}
