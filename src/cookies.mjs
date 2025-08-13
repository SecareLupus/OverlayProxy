import { CookieJar } from 'tough-cookie';
import setCookie from 'set-cookie-parser';

const jars = new Map(); // overlayId -> CookieJar

function jarFor(id){
  if (!jars.has(id)) jars.set(id, new CookieJar(undefined, { looseMode: true }));
  return jars.get(id);
}

export async function getCookieHeader(overlayId, url){
  const jar = jarFor(overlayId);
  return await new Promise((resolve, reject) =>
    jar.getCookieString(url, {}, (err, str) => err ? reject(err) : resolve(str))
  );
}

export async function storeSetCookies(overlayId, url, res){
  const jar = jarFor(overlayId);
  let cookies = [];
  if (typeof res.headers.getSetCookie === 'function') {
    cookies = res.headers.getSetCookie(); // undici extension when available
  } else {
    const sc = res.headers.get('set-cookie');
    if (sc) cookies = setCookie.splitCookiesString(sc);
  }
  for (const c of cookies) {
    await new Promise((resolve, reject) =>
      jar.setCookie(c, url, { ignoreError: true }, (err) => err ? reject(err) : resolve())
    );
  }
}
