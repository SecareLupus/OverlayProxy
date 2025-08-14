import config from '/config.js';
import { installRuntimeShims, connectControlBus } from './runtime-shims.mjs';

// Assuming you already imported config as 'config'
window.overlayConfig = config; // if not already set

window.__ovOriginMap = {};
for (const ov of (config.overlays || [])) {
  try { window.__ovOriginMap[new URL(ov.url).origin] = ov.id; } catch {}
  if (Array.isArray(ov.origins)) {
    for (const o of ov.origins) {
      try { window.__ovOriginMap[new URL(o).origin] = ov.id; } catch {}
    }
  }
}
installRuntimeShims(window.__ovOriginMap);

const root = document.getElementById('root');

function px(n){ return `${n|0}px`; }

function makeHost(ov){
  const host = document.createElement('div');
  host.className = 'overlay-host';
  host.setAttribute('data-ov', ov.id);
  host.style.left = px(ov.x);
  host.style.top = px(ov.y);
  host.style.width = px(ov.width);
  host.style.height = px(ov.height);
  host.style.zIndex = String(ov.z ?? 0);
  host.style.opacity = String(ov.opacity ?? 1);
  host.style.transform = `scale(${ov.scale ?? 1})`;
  host.style.pointerEvents = ov.interactive ? 'auto' : 'none';
  host.style.position = 'absolute';
  host.style.background = 'transparent';
  return host;
}

async function executeScriptsSequentially(container, overlayId) {
  const prev = window.__ovActiveOverlay;
  window.__ovActiveOverlay = overlayId;
  try {
    const scripts = Array.from(container.querySelectorAll('script'));
    for (const old of scripts) {
      const s = document.createElement('script');

      // Copy attributes (type, async, defer, crossorigin, etc.)
      for (const attr of old.getAttributeNames()) {
        s.setAttribute(attr, old.getAttribute(attr));
      }

      if (old.src) {
        // External script: load and wait before continuing
        await new Promise((resolve, reject) => {
          s.onload = resolve;
          s.onerror = reject;
          s.src = old.src;     // already rewritten to /proxy
          old.replaceWith(s);
        });
      } else {
        // Inline script: execute immediately, in-order
        s.textContent = old.textContent;
        old.replaceWith(s);
        // no await needed; runs synchronously
      }
    }
  } finally {
    const id = overlayId;
    window.__ovLastOverlay = { id, t: performance.now() };
    window.__ovActiveOverlay = prev;
  }
}

async function executeScriptsSequentiallyInDocument(scripts, overlayId){
  const prev = window.__ovActiveOverlay;
  window.__ovActiveOverlay = overlayId;
  try {
    for (const old of scripts) {
      const s = document.createElement('script');
      for (const attr of old.getAttributeNames()) s.setAttribute(attr, old.getAttribute(attr));
      await new Promise((resolve, reject) => {
        s.onload = resolve;
        s.onerror = reject;
        if (old.src) { s.src = old.src; document.head.appendChild(s); }
        else { s.textContent = old.textContent || ''; document.head.appendChild(s); resolve(); }
      });
    }
  } finally {
    // leave a short “grace” so late async connects still get tagged
    const id = overlayId;
    window.__ovLastOverlay = { id, t: performance.now() };
    window.__ovActiveOverlay = prev;
  }
}

async function mountDomOverlay(ov){
  const host = makeHost(ov);
  const shadow = host.attachShadow({ mode: 'open' });

  let html;
  let res = await fetch(
    `/overlay/${encodeURIComponent(ov.id)}/full?overlay=${encodeURIComponent(ov.id)}`,
    { cache: 'no-store' }
  );
  if (!res.ok) {
    console.warn('full overlay fetch failed, using fragment instead:', ov.id);
    res = await fetch(
      `/overlay/${encodeURIComponent(ov.id)}/fragment?overlay=${encodeURIComponent(ov.id)}`,
      { cache: 'no-store' }
    );
    if (!res.ok) throw new Error(`failed to fetch fragment for ${ov.id}`);
    const frag = await res.text();
    html = `<!doctype html><html><head></head><body>${frag}</body></html>`;
  } else {
    html = await res.text();
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Attach a style to normalize
  const baseStyle = document.createElement('style');
  baseStyle.textContent = `:host{ all: initial; display:block; }
    *,*:before,*:after{ box-sizing: border-box; }
    html,body{ background: transparent !important; }`;
  shadow.append(baseStyle);

  // Hoist required head resources into the shadow root
  for (const sel of ['link[rel="stylesheet"]', 'link[rel="modulepreload"]']) {
    for (const link of doc.head.querySelectorAll(sel)) {
      const clone = document.createElement('link');
      for (const a of link.getAttributeNames()) clone.setAttribute(a, link.getAttribute(a));
      shadow.appendChild(clone);
    }
  }
  for (const st of doc.head.querySelectorAll('style')) {
    const s = document.createElement('style');
    s.textContent = st.textContent || '';
    shadow.appendChild(s);
  }
  const headScripts = [...doc.head.querySelectorAll('script')];

  const container = document.createElement('div');
  for (const node of [...doc.body.childNodes]) container.appendChild(node);
  shadow.append(container);

  // Inject into DOM immediately so one slow script doesn't block others
  root.appendChild(host);
  window.overlayAPI.register(ov, host);

  // Execute head scripts first, then body scripts
  (async () => {
    try {
      await executeScriptsSequentiallyInDocument(headScripts, ov.id);
      await executeScriptsSequentially(container, ov.id);
    } catch (e) {
      console.error('overlay script error', ov.id, e);
    }
  })();
}

function mountIframeOverlay(ov){
  const host = document.createElement('div');
  host.className = 'overlay-host';
  host.style.left = px(ov.x);
  host.style.top = px(ov.y);
  host.style.width = px(ov.width);
  host.style.height = px(ov.height);
  host.style.zIndex = String(ov.z ?? 0);
  host.style.opacity = String(ov.opacity ?? 1);
  host.style.transform = `scale(${ov.scale ?? 1})`;

  const iframe = document.createElement('iframe');
  iframe.className = 'overlay-iframe';
  iframe.src = `/overlay/${encodeURIComponent(ov.id)}`; // full page via proxy
  iframe.allow = 'autoplay; clipboard-read; clipboard-write';
  iframe.sandbox = 'allow-scripts allow-same-origin allow-popups';
  host.appendChild(iframe);
  root.appendChild(host);
  window.overlayAPI.register(ov, host);

}

async function mountLightDomOverlay(ov, root){
  // Server returns full HTML with link hrefs already carrying &scope=[data-ov="ID"],
  // and inline <style> pre-scoped.
  let html;
  const res = await fetch(
    `/overlay/${encodeURIComponent(ov.id)}/full?overlay=${encodeURIComponent(ov.id)}`,
    { cache: 'no-store' }
  );
  if (!res.ok) throw new Error(`failed to fetch full for ${ov.id}`);
  html = await res.text();

  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Hoist stylesheet and modulepreload links (already include &scope=… when isolation=light)
  for (const sel of ['link[rel="stylesheet"]', 'link[rel="modulepreload"]']) {
    for (const link of doc.head.querySelectorAll(sel)) {
      const clone = document.createElement('link');
      for (const a of link.getAttributeNames()) clone.setAttribute(a, link.getAttribute(a));
      document.head.appendChild(clone);
    }
  }

  const host = makeHost(ov);
  for (const node of [...doc.body.childNodes]) host.appendChild(node);
  // Inline <style> were pre-scoped; they’re placed in body by provider—we keep them near content
  for (const st of doc.head.querySelectorAll('style')) {
    const s = document.createElement('style');
    s.textContent = st.textContent || '';
    host.prepend(s);
  }

  root.appendChild(host);
  window.overlayAPI.register(ov, host);

  // Execute scripts in order but don't block other overlays
  const scripts = [...doc.querySelectorAll('head script, body script')];
  injectRuntimeShimsFor(ov.id);
  executeScriptsSequentiallyInDocument(scripts, ov.id)
    .catch(e => console.error('overlay script error', ov.id, e));
}

function injectRuntimeShimsFor(overlayId){
  const s = document.createElement('script');
  s.textContent = `
  (function(){
    const OVERLAY_ID = ${JSON.stringify(overlayId)};
    const ORIGIN = location.origin;

    // WebSocket shim
    (function(){
      const OrigWS = window.WebSocket;
      function tunneled(url, protocols){
        try {
          const u = new URL(url, ORIGIN);
          if (u.origin === ORIGIN) {
            if (OVERLAY_ID) u.searchParams.set('overlay', OVERLAY_ID);
            return new OrigWS(u.toString(), protocols);
          }
          const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
          const target = encodeURIComponent(u.toString());
          const ov = OVERLAY_ID ? ('&overlay='+encodeURIComponent(OVERLAY_ID)) : '';
          const turl = scheme + '://' + location.host + '/__ws?target=' + target + ov;
          return new OrigWS(turl, protocols);
        } catch {}
        return new OrigWS(url, protocols);
      }
      tunneled.prototype = OrigWS.prototype;
      // copy static props
      ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(k => { tunneled[k] = OrigWS[k]; });
      window.WebSocket = tunneled;
    })();

    // fetch shim
    (function(){
      const origFetch = window.fetch;
      window.fetch = function(input, init){
        try{
          const req = (input instanceof Request) ? input : new Request(input, init);
          const u = new URL(req.url, ORIGIN);
          if (u.origin === ORIGIN) {
            if (OVERLAY_ID) u.searchParams.set('overlay', OVERLAY_ID);
            const cloned = new Request(u.toString(), {
              method: req.method,
              headers: req.headers,
              body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : req.body,
              redirect: req.redirect,
              referrer: req.referrer, referrerPolicy: req.referrerPolicy,
              mode: 'same-origin', credentials: 'include',
              cache: req.cache, integrity: req.integrity,
              keepalive: req.keepalive, signal: req.signal,
            });
            return origFetch(cloned);
          }
          const prox = '/proxy?overlay='+encodeURIComponent(OVERLAY_ID)+'&url='+encodeURIComponent(u.toString());
          const cloned = new Request(prox, {
            method: req.method,
            headers: req.headers,
            body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : req.body,
            redirect: req.redirect,
            referrer: req.referrer, referrerPolicy: req.referrerPolicy,
            mode: 'same-origin', credentials: 'include',
            cache: req.cache, integrity: req.integrity,
            keepalive: req.keepalive, signal: req.signal,
          });
          return origFetch(cloned);
        } catch {}
        return origFetch(input, init);
      };
    })();

    // XHR shim
    (function(){
      const Orig = window.XMLHttpRequest;
      function X(){
        const xhr = new Orig();
        const open = xhr.open;
        xhr.open = function(method, url, async, user, pass){
          try {
            const u = new URL(url, ORIGIN);
            if (u.origin === ORIGIN) {
              if (OVERLAY_ID) u.searchParams.set('overlay', OVERLAY_ID);
              return open.call(xhr, method, u.toString(), async !== false, user, pass);
            }
            const prox = '/proxy?overlay='+encodeURIComponent(OVERLAY_ID)+'&url='+encodeURIComponent(u.toString());
            return open.call(xhr, method, prox, async !== false, user, pass);
          } catch {}
          return open.call(xhr, method, url, async, user, pass);
        };
        return xhr;
      }
      X.prototype = Orig.prototype;
      window.XMLHttpRequest = X;
    })();
  })();`;
  document.head.appendChild(s);
}

async function main(){
  root.style.width = px(config.canvas.width);
  root.style.height = px(config.canvas.height);

  for (const ov of config.overlays) {
    try {
      if (ov.mode === 'iframe') {
        mountIframeOverlay(ov);
      } else if (ov.isolation === 'light') {
        await mountLightDomOverlay(ov, root);
      } else { 
        await mountDomOverlay(ov);
      }
    } catch (e) {
      console.error('Overlay failed, falling back to iframe:', ov.id, e);
      mountIframeOverlay(ov);
    }
  }
}

connectControlBus();

// Global-ish registry so control messages can reach overlays
window.overlayAPI = (function(){
  const hosts = new Map();   // id -> { hostEl, mode, isolation }

  function register(ov, hostEl) { hosts.set(ov.id, { hostEl, mode: ov.mode, isolation: ov.isolation }); }
  function get(id) { return hosts.get(id); }

  async function reload(id){
    if (!id) { location.reload(); return; }
    const h = get(id);
    if (!h) return;
    // Simple reload: replace subtree for DOM modes; reset iframe src for iframe mode
    if (h.mode === 'iframe') {
      const iframe = h.hostEl.querySelector('iframe');
      if (iframe) iframe.src = iframe.src;
    } else {
      // Remove and remount: you likely have mountDomOverlay/mountLightDomOverlay & config available in scope
      const ov = (window.overlayConfig?.overlays || []).find(o => o.id === id);
      if (!ov) return;
      const parent = h.hostEl.parentNode;
      if (!parent) return;
      parent.removeChild(h.hostEl);
      if (ov.isolation === 'light') {
        await mountLightDomOverlay(ov, document.getElementById('root'));
      } else {
        await mountDomOverlay(ov); // your existing shadow-DOM path
      }
    }
  }

  function setVisible(id, visible){
    const h = get(id);
    if (!h) return;
    h.hostEl.style.display = visible ? '' : 'none';
  }

  return { register, reload, setVisible };
})();

main();