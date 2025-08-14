import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeSetCookies, getCookieHeader } from '../src/cookies.mjs';

const url = 'https://example.com/';

// Test storing and retrieving cookies per overlay id

test('stores and isolates cookies per overlay id', async () => {
  // store distinct cookies for two overlays
  await storeSetCookies('overlay1', url, { headers: new Headers([['set-cookie', 'sess=OV1']]) });
  await storeSetCookies('overlay2', url, { headers: new Headers([['set-cookie', 'sess=OV2']]) });

  const c1 = await getCookieHeader('overlay1', url);
  const c2 = await getCookieHeader('overlay2', url);

  assert.equal(c1, 'sess=OV1');
  assert.equal(c2, 'sess=OV2');
});
