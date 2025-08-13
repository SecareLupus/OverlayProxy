import { fetch } from 'undici';
import NodeCache from 'node-cache';
import { getCookieHeader, storeSetCookies } from './cookies.mjs';

const cache = new NodeCache();

// Optional: small helper to set a plausible Referer
function refererFor(assetUrl, overlayPageUrl) {
  try {
    // Prefer the overlay page URL; fall back to the asset’s origin
    return overlayPageUrl || new URL(assetUrl).origin + '/';
  } catch {
    return overlayPageUrl || '';
  }
}

export async function fetchOverlayPage(url, cacheSeconds = 60, headers = {}, overlayId, overlayPageUrl = '') {
  const key = `page:${url}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const merged = {
    ...headers,
    'accept-encoding': 'identity',
    'accept-language': headers['accept-language'] || 'en-US,en;q=0.9',
    'user-agent': headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'
  };
  delete merged['cookie']; // we'll manage cookies

  const cookie = await getCookieHeader(overlayId, url);
  if (cookie) merged['cookie'] = cookie;

  const res = await fetch(url, { headers: merged });
  await storeSetCookies(overlayId, url, res);

  const text = await res.text(); // safe: identity encoded
  // Cache only successful pages to avoid pinning errors
  if (res.ok) cache.set(key, text, cacheSeconds);

  return { ok: res.ok, status: res.status, text, headers: Object.fromEntries(res.headers) };
}

export async function fetchAsset(url, cacheSeconds = 60, headers = {}, overlayId, overlayPageUrl = '') {
  const key = `asset:${url}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const merged = {
    ...headers,
    'accept-encoding': 'identity',
    'accept-language': headers['accept-language'] || 'en-US,en;q=0.9',
    'user-agent': headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'
  };
  delete merged['cookie'];

  const cookie = await getCookieHeader(overlayId, url);
  if (cookie) merged['cookie'] = cookie;

  const res = await fetch(url, { headers: merged });
  await storeSetCookies(overlayId, url, res);

  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || 'application/octet-stream';
  const etag = res.headers.get('etag') || undefined;
  const cacheControl = res.headers.get('cache-control') || `public, max-age=${cacheSeconds}`;

  const out = { buf, type, etag, cacheControl, status: res.status, ok: res.ok, url };
  // Cache only successful assets
  if (res.ok) cache.set(key, out, cacheSeconds);
  return out;
}
