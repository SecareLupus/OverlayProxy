import test from 'node:test';
import { strict as assert } from 'node:assert';
import { parseBaseFromReferer, inferOverlayId, cfg } from '../src/server_utils.mjs';

test('parseBaseFromReferer handles /proxy?overlay=id&url=...', () => {
  const req = {
    headers: {
      referer: 'http://localhost/proxy?overlay=blerps&url=' + encodeURIComponent('https://example.com/page')
    }
  };
  const out = parseBaseFromReferer(req);
  assert.equal(out.overlayId, 'blerps');
  assert.equal(out.baseUrl, 'https://example.com/page');
});

test('parseBaseFromReferer handles /overlay/:id', () => {
  const req = {
    headers: {
      referer: 'http://localhost/overlay/Twitchat'
    }
  };
  const out = parseBaseFromReferer(req);
  assert.equal(out.overlayId, 'Twitchat');
  const expected = cfg.overlays.find(o => o.id === 'Twitchat').url;
  assert.equal(out.baseUrl, expected);
});

test('inferOverlayId prioritizes query, then referer, then default', () => {
  const defaultOverlay = cfg.defaultOverlay;

  // query param wins
  assert.equal(
    inferOverlayId({
      query: { overlay: 'streamelements' },
      headers: { referer: 'http://localhost/overlay/blerps' }
    }),
    'streamelements'
  );

  // referer if query missing
  assert.equal(
    inferOverlayId({
      query: {},
      headers: { referer: 'http://localhost/overlay/blerps' }
    }),
    'blerps'
  );

  // default if neither
  assert.equal(
    inferOverlayId({ query: {}, headers: {} }),
    defaultOverlay
  );
});
