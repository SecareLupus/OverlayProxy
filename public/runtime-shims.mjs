import { installShims } from './shims.js';

export function installRuntimeShims(originToId){
  if (window.__ovShimsInstalled) return;
  window.__ovShimsInstalled = true;

  const ORIGIN = location.origin;
  window.__ovOriginMap = originToId || {};

  function pickOverlayIdFor(url){
    if (window.__ovActiveOverlay) return window.__ovActiveOverlay;
    const last = window.__ovLastOverlay;
    if (last && performance.now() - last.t < 6000) return last.id;
    try { return window.__ovOriginMap[new URL(url, ORIGIN).origin]; } catch { return undefined; }
  }

  installShims(window, pickOverlayIdFor, ORIGIN);
  const SHIM_SRC = installShims.toString();

  // ---- Worker shim ----
  (function(){
    function wrap(Orig){
      function W(url, opts){
        try {
          const u = new URL(url, ORIGIN);
          const id = pickOverlayIdFor(u.toString());
          let prox;
          if (u.origin === ORIGIN) {
            if (id) u.searchParams.set('overlay', id);
            prox = u.toString();
          } else {
            const ov = id ? 'overlay=' + encodeURIComponent(id) + '&' : '';
            prox = '/proxy?' + ov + 'url=' + encodeURIComponent(u.toString());
          }
          const boot = `self.__ovOverlayId=${id ? JSON.stringify(id) : 'undefined'};\n(${SHIM_SRC})(self, () => self.__ovOverlayId, self.location.origin);\nimportScripts(${JSON.stringify(prox)});`;
          const blob = new Blob([boot], { type: 'application/javascript' });
          const obj = URL.createObjectURL(blob);
          const w = new Orig(obj, opts);
          setTimeout(() => URL.revokeObjectURL(obj), 0);
          return w;
        } catch {}
        return new Orig(url, opts);
      }
      W.prototype = Orig.prototype;
      return W;
    }
    if (window.Worker) window.Worker = wrap(window.Worker);
    if (window.SharedWorker) window.SharedWorker = wrap(window.SharedWorker);
  })();

  // ---- ServiceWorker register shim ----
  (function(){
    const sw = navigator.serviceWorker;
    if (!sw || !sw.register) return;
    const orig = sw.register.bind(sw);
    sw.register = function(url, opts){
      try {
        const u = new URL(url, ORIGIN);
        const id = pickOverlayIdFor(u.toString());
        let prox;
        if (u.origin === ORIGIN) {
          if (id) u.searchParams.set('overlay', id);
          prox = u.toString();
        } else {
          const ov = id ? 'overlay=' + encodeURIComponent(id) + '&' : '';
          prox = '/proxy?' + ov + 'url=' + encodeURIComponent(u.toString());
        }
        const boot = `self.__ovOverlayId=${id ? JSON.stringify(id) : 'undefined'};\n(${SHIM_SRC})(self, () => self.__ovOverlayId, self.location.origin);\nimportScripts(${JSON.stringify(prox)});`;
        const blob = new Blob([boot], { type: 'application/javascript' });
        const obj = URL.createObjectURL(blob);
        const p = orig(obj, opts);
        p.then(() => URL.revokeObjectURL(obj), () => URL.revokeObjectURL(obj));
        return p;
      } catch {}
      return orig(url, opts);
    };
  })();
}

export function connectControlBus(){
  try {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    let stopped = false;
    let socket;

    function connect(){
      socket = new WebSocket(`${scheme}://${location.host}/_control`);

      socket.onmessage = async (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'reload') await window.overlayAPI.reload(msg.id);
          if (msg.type === 'visibility' && msg.id) window.overlayAPI.setVisible(msg.id, !!msg.visible);
        } catch (e) { console.error('control message error', e); }
      };

      socket.onclose = () => { if (!stopped) setTimeout(connect, 2000); };
    }

    connect();
    return () => { stopped = true; try { socket.close(); } catch {} };
  } catch {}
}
