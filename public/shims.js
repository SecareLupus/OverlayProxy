export function installShims(target, getOverlayId, ORIGIN){
  // WebSocket shim
  const OrigWS = target.WebSocket;
  if (OrigWS) {
    function tunneled(url, protocols){
      try {
        const u = new URL(url, ORIGIN);
        if (u.pathname === '/_control') return new OrigWS(url, protocols);
        if (u.origin === ORIGIN) {
          const id = getOverlayId(u.toString());
          if (id) u.searchParams.set('overlay', id);
          return new OrigWS(u.toString(), protocols);
        }
        const id = getOverlayId(u.toString());
        const scheme = target.location.protocol === 'https:' ? 'wss' : 'ws';
        const turl = `${scheme}://${target.location.host}/__ws?target=${encodeURIComponent(u.toString())}` + (id ? `&overlay=${encodeURIComponent(id)}` : '');
        return new OrigWS(turl, protocols);
      } catch {}
      return new OrigWS(url, protocols);
    }
    ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(k => { tunneled[k] = OrigWS[k]; });
    tunneled.prototype = OrigWS.prototype;
    target.WebSocket = tunneled;
  }

  // fetch shim
  const origFetch = target.fetch;
  if (origFetch) {
    target.fetch = function(input, init){
      try {
        const req = (input instanceof target.Request) ? input : new target.Request(input, init);
        const u = new URL(req.url, ORIGIN);
        const id = getOverlayId(u.toString());
        if (u.origin === ORIGIN) {
          if (id) u.searchParams.set('overlay', id);
          const cloned = new target.Request(u.toString(), {
            method: req.method,
            headers: req.headers,
            body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : req.body,
            redirect: req.redirect,
            referrer: req.referrer, referrerPolicy: req.referrerPolicy,
            mode: 'same-origin', credentials: 'include',
            cache: req.cache, integrity: req.integrity,
            keepalive: req.keepalive, signal: req.signal,
          });
          target.console?.debug?.('[shim][fetch][local] ->', u.toString());
          return origFetch(cloned);
        }
        if (u.origin !== ORIGIN) {
          const prox = `/proxy?${id ? `overlay=${encodeURIComponent(id)}&` : ''}url=${encodeURIComponent(u.toString())}`;
          const cloned = new target.Request(prox, {
            method: req.method,
            headers: req.headers,
            body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : req.body,
            redirect: req.redirect,
            referrer: req.referrer, referrerPolicy: req.referrerPolicy,
            mode: 'same-origin', credentials: 'include',
            cache: req.cache, integrity: req.integrity,
            keepalive: req.keepalive, signal: req.signal,
          });
          target.console?.debug?.('[shim][fetch][proxy] ->', prox, '(', u.toString(), ')');
          return origFetch(cloned);
        }
      } catch {}
      return origFetch(input, init);
    };
  }

  // XHR shim
  const Orig = target.XMLHttpRequest;
  if (Orig) {
    function X(){
      const xhr = new Orig();
      const open = xhr.open;
      xhr.open = function(method, url, async, user, pass){
        try {
          const u = new URL(url, ORIGIN);
          const id = getOverlayId(u.toString());
          if (u.origin === ORIGIN) {
            if (id) u.searchParams.set('overlay', id);
            target.console?.debug?.('[shim][xhr][local] ->', u.toString());
            return open.call(xhr, method, u.toString(), async !== false, user, pass);
          }
          if (u.origin !== ORIGIN) {
            const prox = `/proxy?${id ? `overlay=${encodeURIComponent(id)}&` : ''}url=${encodeURIComponent(u.toString())}`;
            return open.call(xhr, method, prox, async !== false, user, pass);
          }
        } catch {}
        return open.call(xhr, method, url, async, user, pass);
      };
      return xhr;
    }
    X.prototype = Orig.prototype;
    target.XMLHttpRequest = X;
  }
}
