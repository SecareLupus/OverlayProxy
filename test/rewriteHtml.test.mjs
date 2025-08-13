import test from 'node:test';
import { strict as assert } from 'node:assert';
import { rewriteHtml } from '../src/rewrite_ext.mjs';

test('rewriteHtml proxies assets and strips integrity', async () => {
  const html = `<!doctype html><html><head>
    <script src="https://example.com/app.js" integrity="sha256-abc"></script>
    <link rel="stylesheet" href="https://example.com/app.css" integrity="sha256-def" />
  </head><body><img src="https://example.com/img.png" /></body></html>`;
  const out = await rewriteHtml({ html, originUrl: 'https://example.com/page', overlayId: 'ov1' });
  assert.match(out, /script src="\/proxy\?overlay=ov1&amp;url=https%3A%2F%2Fexample.com%2Fapp.js"/);
  assert.match(out, /link rel="stylesheet" href="\/proxy\?overlay=ov1&amp;url=https%3A%2F%2Fexample.com%2Fapp.css"/);
  assert.match(out, /img src="\/proxy\?overlay=ov1&amp;url=https%3A%2F%2Fexample.com%2Fimg.png"/);
  assert.doesNotMatch(out, /integrity=/);
});
