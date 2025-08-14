import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher, Agent } from 'undici';
import { fetchOverlayPage, fetchAsset, clearCache } from '../src/overlayFetcher.mjs';

async function withMock(fn) {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  try {
    await fn(mockAgent);
  } finally {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
    clearCache();
  }
}

test('caches pages per overlay id', async () => {
  await withMock(async (mockAgent) => {
    const origin = 'https://example.com';
    const url = origin + '/page';
    const client = mockAgent.get(origin);
    let calls = 0;
    client
      .intercept({ path: '/page', method: 'GET' })
      .reply(200, () => {
        calls++;
        return `p${calls}`;
      })
      .persist();

    const a1 = await fetchOverlayPage(url, 60, {}, 'a');
    assert.equal(typeof a1, 'object');
    assert.equal(a1.text, 'p1');

    const b1 = await fetchOverlayPage(url, 60, {}, 'b');
    assert.equal(b1.text, 'p2');

    const a2 = await fetchOverlayPage(url, 60, {}, 'a');
    const textA2 = typeof a2 === 'string' ? a2 : a2.text;
    assert.equal(textA2, 'p1');

    assert.equal(calls, 2);
  });
});

test('does not cache failed pages', async () => {
  await withMock(async (mockAgent) => {
    const origin = 'https://example.com';
    const url = origin + '/page';
    const client = mockAgent.get(origin);
    let calls = 0;
    client
      .intercept({ path: '/page', method: 'GET' })
      .reply(500, () => {
        calls++;
        return 'err';
      });
    client
      .intercept({ path: '/page', method: 'GET' })
      .reply(200, () => {
        calls++;
        return 'ok';
      });

    const first = await fetchOverlayPage(url, 60, {}, 'a');
    assert.equal(first.ok, false);
    assert.equal(first.status, 500);

    const second = await fetchOverlayPage(url, 60, {}, 'a');
    assert.equal(second.ok, true);
    assert.equal(second.text, 'ok');

    assert.equal(calls, 2);
  });
});

test('caches assets per overlay id', async () => {
  await withMock(async (mockAgent) => {
    const origin = 'https://example.com';
    const url = origin + '/asset.js';
    const client = mockAgent.get(origin);
    let calls = 0;
    client
      .intercept({ path: '/asset.js', method: 'GET' })
      .reply(200, () => {
        calls++;
        return `a${calls}`;
      }, { headers: { 'content-type': 'text/plain' } })
      .persist();

    const a1 = await fetchAsset(url, 60, {}, 'a');
    assert.equal(a1.buf.toString(), 'a1');

    const b1 = await fetchAsset(url, 60, {}, 'b');
    assert.equal(b1.buf.toString(), 'a2');

    const a2 = await fetchAsset(url, 60, {}, 'a');
    assert.equal(a2.buf.toString(), 'a1');

    assert.equal(calls, 2);
  });
});

test('sends stored cookies and isolates per overlay id', async () => {
  await withMock(async (mockAgent) => {
    const origin = 'https://example.com';
    const client = mockAgent.get(origin);

    client
      .intercept({ path: '/a', method: 'GET' })
      .reply(200, 'ok', { headers: { 'set-cookie': 'sess=A' } });
    client
      .intercept({ path: '/b', method: 'GET' })
      .reply(200, 'ok', { headers: { 'set-cookie': 'sess=B' } });

    const seen = [];
    client
      .intercept({ path: '/asset.js', method: 'GET' })
      .reply(200, (opts) => {
        seen.push(opts.headers.cookie || '');
        return 'asset';
      }, { headers: { 'content-type': 'text/plain' } })
      .persist();

    await fetchOverlayPage(origin + '/a', 60, {}, 'a');
    await fetchOverlayPage(origin + '/b', 60, {}, 'b');
    await fetchAsset(origin + '/asset.js', 60, {}, 'a');
    await fetchAsset(origin + '/asset.js', 60, {}, 'b');

    assert.deepEqual(seen, ['sess=A', 'sess=B']);
  });
});

    
test('does not cache failed assets', async () => {
  await withMock(async (mockAgent) => {
    const origin = 'https://example.com';
    const url = origin + '/asset.js';
    const client = mockAgent.get(origin);
    let calls = 0;
    client
      .intercept({ path: '/asset.js', method: 'GET' })
      .reply(500, () => {
        calls++;
        return 'err';
      }, { headers: { 'content-type': 'text/plain' } });
    client
      .intercept({ path: '/asset.js', method: 'GET' })
      .reply(200, () => {
        calls++;
        return 'ok';
      }, { headers: { 'content-type': 'text/plain' } });

    const first = await fetchAsset(url, 60, {}, 'a');
    assert.equal(first.ok, false);
    assert.equal(first.status, 500);

    const second = await fetchAsset(url, 60, {}, 'a');
    assert.equal(second.ok, true);
    assert.equal(second.buf.toString(), 'ok');

    assert.equal(calls, 2);
  });
});
