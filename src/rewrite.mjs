import * as cheerio from 'cheerio';
import { toAbs } from './util.mjs';

// Rewrites asset URLs to go through our proxy. Also forces transparent background.
export function rewriteHtml({ html, originUrl, overlayId }){
  const $ = cheerio.load(html, { decodeEntities: false });
  const prox = (u) => `/proxy?overlay=${encodeURIComponent(overlayId)}&url=${encodeURIComponent(toAbs(originUrl, u))}`;

  $('link[href]').each((_, el)=>{
    const href = $(el).attr('href');
    if (href) $(el).attr('href', prox(href));
  });
  $('script[src]').each((_, el)=>{
    const src = $(el).attr('src');
    if (src) $(el).attr('src', prox(src));
  });
  $('[src]').each((_, el)=>{
    const src = $(el).attr('src');
    if (src) $(el).attr('src', prox(src));
  });
  $('[data-src]').each((_, el)=>{
    const src = $(el).attr('data-src');
    if (src) $(el).attr('data-src', prox(src));
  });

  // Force transparency where possible
  $('html,body').attr('style', (i, s)=> `${s||''}; background: transparent !important;`);

  return $.html();
}