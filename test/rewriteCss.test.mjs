import test from 'node:test';
import { strict as assert } from 'node:assert';
import { rewriteCss } from '../src/rewrite_ext.mjs';

test('rewriteCss rewrites url() forms and preserves data/blob', () => {
  const css = `
    .dq{background:url("https://example.com/dq.png");}
    .sq{background:url('https://example.com/sq.png');}
    .bare{background:url(https://example.com/bare.png);}
    .data{background:url("data:image/png;base64,abc");}
    .blob{background:url(blob:https://example.com/123);}
  `;
  const out = rewriteCss({ css, originUrl: 'https://example.com/style.css', overlayId: 'ov1' });
  assert.ok(out.includes('url("/proxy?overlay=ov1&url=https%3A%2F%2Fexample.com%2Fdq.png")'));
  assert.ok(out.includes("url('/proxy?overlay=ov1&url=https%3A%2F%2Fexample.com%2Fsq.png')"));
  assert.ok(out.includes('url(/proxy?overlay=ov1&url=https%3A%2F%2Fexample.com%2Fbare.png)'));
  assert.ok(out.includes('url("data:image/png;base64,abc")'));
  assert.ok(out.includes('url(blob:https://example.com/123)'));
});
