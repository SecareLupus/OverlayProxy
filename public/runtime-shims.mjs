export function installRuntimeShims(originToId){
  if (window.__ovShimsInstalled) return;
  window.__ovShimsInstalled = true;

  const ORIGIN = location.origin;
  window.__ovOriginMap = originToId || {};

  function pickOverlayIdFor(url) {
    if (window.__ovActiveOverlay) return window.__ovActiveOverlay;
    const last = window.__ovLastOverlay;
    if (last && performance.now() - last.t < 6000) return last.id;
    try { return window.__ovOriginMap[new URL(url, ORIGIN).origin]; } catch { return undefined; }
  }

  function workerShimGlobal(){
    const ORIGIN = self.location.origin;
    const OVERLAY_ID = self.__ovOverlayId;

    (function(){
      const OrigWS = self.WebSocket;
      function addOverlay(u){
        if (OVERLAY_ID) u.searchParams.set('overlay', OVERLAY_ID);
        return u.toString();
      }
      function tunneled(url, protocols){
        try {
          const u = new URL(url, ORIGIN);
          if (u.host === self.location.host) return new OrigWS(addOverlay(u), protocols);
          if (u.origin !== ORIGIN) {
            const scheme = self.location.protocol === 'https:' ? 'wss' : 'ws';
            const ov = OVERLAY_ID ? '&overlay=' + encodeURIComponent(OVERLAY_ID) : '';
            const turl = scheme + '://' + self.location.host + '/__ws?target=' + encodeURIComponent(u.toString()) + ov;
            return new OrigWS(turl, protocols);
          }
        } catch {}
        return new OrigWS(url, protocols);
      }
      ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(k => { tunneled[k] = OrigWS[k]; });
      tunneled.prototype = OrigWS.prototype;
      self.WebSocket = tunneled;
    })();

    (function(){
      const origFetch = self.fetch;
      self.fetch = function(input, init){
        try {
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
          const prox = '/proxy?' + (OVERLAY_ID ? 'overlay=' + encodeURIComponent(OVERLAY_ID) + '&' : '') + 'url=' + encodeURIComponent(u.toString());
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

    (function(){
      const Orig = self.XMLHttpRequest;
      if (!Orig) return;
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
            const prox = '/proxy?' + (OVERLAY_ID ? 'overlay=' + encodeURIComponent(OVERLAY_ID) + '&' : '') + 'url=' + encodeURIComponent(u.toString());
            return open.call(xhr, method, prox, async !== false, user, pass);
          } catch {}
          return open.call(xhr, method, url, async, user, pass);
        };
        return xhr;
      }
      X.prototype = Orig.prototype;
      self.XMLHttpRequest = X;
    })();
  }

  const WORKER_SHIM = '(' + workerShimGlobal.toString() + ')();';

  // ---- WebSocket shim ----
  (function(){
    const OrigWS = window.WebSocket;
    function addOverlayParam(u) {
      const id = pickOverlayIdFor(u.toString());
      if (!id) return u.toString();
      u.searchParams.set('overlay', id);
      return u.toString();
    }
    function tunneled(url, protocols){
      try {
        const u = new URL(url, ORIGIN);

        // never touch our control bus
        if (u.pathname === '/_control') return new OrigWS(url, protocols);

        // SAME HOST: add overlay=<id> and connect locally
        if (u.host === location.host) {
          const withId = addOverlayParam(u);
          console.debug('[shim][ws][local] ->', withId);
          return new OrigWS(withId, protocols);
        }

        // CROSS ORIGIN: tunnel via /__ws (also pass overlay for cookies/origin spoof)
        if (u.origin !== ORIGIN) {
          const id = pickOverlayIdFor(u.toString());
          const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
          const ov = id ? '&overlay=' + encodeURIComponent(id) : '';
          const turl = `${scheme}://${location.host}/__ws?target=${encodeURIComponent(u.toString())}${ov}`;
          console.debug('[shim][ws][tunnel] ->', turl, '(', u.toString(), ')');
          return new OrigWS(turl, protocols);
        }
      } catch {}
      return new OrigWS(url, protocols);
    }
    ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(k => { tunneled[k] = OrigWS[k]; });
    tunneled.prototype = OrigWS.prototype;
    window.WebSocket = tunneled;
  })();

  // ---- fetch shim ----
  (function(){
    const origFetch = window.fetch;
    window.fetch = function(input, init){
      try{
        const req = (input instanceof Request) ? input : new Request(input, init);
        const u = new URL(req.url, ORIGIN);

        // same-origin -> add overlay=<id>
        if (u.origin === ORIGIN) {
          const id = pickOverlayIdFor(u.toString());
          if (id) {
            u.searchParams.set('overlay', id);
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
            console.debug('[shim][fetch][local] ->', u.toString());
            return origFetch(cloned);
          }
        }

        // cross-origin -> proxy through /proxy
        if (u.origin !== ORIGIN) {
          const id = pickOverlayIdFor(u.toString());
          const prox = `/proxy?${id ? `overlay=${encodeURIComponent(id)}&` : ''}url=${encodeURIComponent(u.toString())}`;
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
          console.debug('[shim][fetch][proxy] ->', prox, '(', u.toString(), ')');
          return origFetch(cloned);
        }
      } catch {}
      return origFetch(input, init);
    };
  })();

  // ---- XHR shim ----
  (function(){
    const Orig = window.XMLHttpRequest;
    function X(){
      const xhr = new Orig();
      const open = xhr.open;
      xhr.open = function(method, url, async, user, pass){
        try {
          const u = new URL(url, ORIGIN);
          if (u.origin === ORIGIN) {
            const id = pickOverlayIdFor(u.toString());
            if (id) {
              u.searchParams.set('overlay', id);
              console.debug('[shim][xhr][local] ->', u.toString());
              return open.call(xhr, method, u.toString(), async !== false, user, pass);
            }
          }
        } catch {}
        return open.call(xhr, method, url, async, user, pass);
      };
      return xhr;
    }
    X.prototype = Orig.prototype;
    window.XMLHttpRequest = X;
  })();

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
          const boot = `self.__ovOverlayId=${id ? JSON.stringify(id) : 'undefined'};\n${WORKER_SHIM}\nimportScripts(${JSON.stringify(prox)});`;
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
        const boot = `self.__ovOverlayId=${id ? JSON.stringify(id) : 'undefined'};\n${WORKER_SHIM}\nimportScripts(${JSON.stringify(prox)});`;
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
