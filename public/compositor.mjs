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

export async function runScriptsSequentially(nodes, overlayId){
  const prev = window.__ovActiveOverlay;
  window.__ovActiveOverlay = overlayId;
  try {
    let code = '';
    for (const old of nodes) {
      if (old.src) {
        try {
          const res = await fetch(old.src);
          code += await res.text() + '\n';
        } catch (e) {
          console.error('failed to fetch script', old.src, e);
        }
      } else {
        code += (old.textContent || '') + '\n';
      }
      old.remove?.();
    }
    if (code.trim()) {
      const base64 = typeof btoa === 'function'
        ? btoa(code)
        : Buffer.from(code, 'utf-8').toString('base64');
      const url = `data:text/javascript;base64,${base64}`;
      await import(/* @vite-ignore */ url);
    }
  } finally {
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
      await runScriptsSequentially(headScripts, ov.id);
      await runScriptsSequentially(container.querySelectorAll('script'), ov.id);
    } catch (e) {
      console.error('overlay script error', ov.id, e);
    }
  })();
}

function mountIframeOverlay(ov){
  const host = makeHost(ov);

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
  runScriptsSequentially(scripts, ov.id)
    .catch(e => console.error('overlay script error', ov.id, e));
}

function injectRuntimeShimsFor(overlayId){
  const s = document.createElement('script');
  s.type = 'module';
  s.textContent = `import { installShims } from './shims.js';
installShims(window, () => ${JSON.stringify(overlayId)}, location.origin);`;
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