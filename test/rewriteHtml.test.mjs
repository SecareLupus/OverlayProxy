import test from 'node:test';
import { strict as assert } from 'node:assert';
import * as cheerio from 'cheerio';
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

test('rewriteHtml rewrites srcset and data-src', async () => {
  const html = `<!doctype html><html><body>
    <img srcset="https://example.com/a1.png 1x, https://example.com/a2.png 2x" />
    <picture><source srcset="https://example.com/pic1.webp 1x, https://example.com/pic2.webp 2x" /></picture>
    <div data-src="https://example.com/lazy.png"></div>
  </body></html>`;
  const out = await rewriteHtml({ html, originUrl: 'https://example.com/page', overlayId: 'ov1' });
  const $ = cheerio.load(out);
  const prox = (u) => `/proxy?overlay=ov1&url=${encodeURIComponent(u)}`;
  assert.equal(
    $('img').attr('srcset'),
    `${prox('https://example.com/a1.png')} 1x, ${prox('https://example.com/a2.png')} 2x`
  );
  assert.equal(
    $('source').attr('srcset'),
    `${prox('https://example.com/pic1.webp')} 1x, ${prox('https://example.com/pic2.webp')} 2x`
  );
  assert.equal($('[data-src]').attr('data-src'), prox('https://example.com/lazy.png'));
});

test('rewriteHtml scopes CSS and strips CSP meta', async () => {
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="https://example.com/app.css">
    <style>h1{color:red}</style>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'">
  </head><body></body></html>`;
  const out = await rewriteHtml({
    html,
    originUrl: 'https://example.com/page',
    overlayId: 'ov1',
    scopeSelector: '[data-ov="ov1"]'
  });
  const $ = cheerio.load(out);
  assert.ok($('link[rel="stylesheet"]').attr('href').includes('scope='));
  assert.ok($('style').text().includes('[data-ov="ov1"]'));
  assert.equal($('meta[http-equiv="Content-Security-Policy"]').length, 0);
});
test('rewriteHtml unwraps nested ?url= layers', async () => {
  const wrap = (u, depth = 1) => {
    let cur = u;
    for (let i = 0; i < depth; i++) {
      cur = `https://proxy${i}.com/proxy?url=${encodeURIComponent(cur)}`;
    }
    return cur;
  };
  const html = `<!doctype html><html><head>
    <script src="${wrap('https://example.com/app.js', 2)}"></script>
    <link rel="stylesheet" href="${wrap('https://example.com/app.css', 3)}" />
  </head><body>
    <img src="${wrap('https://example.com/img.png', 2)}" />
    <img srcset="${wrap('https://example.com/a1.png', 2)} 1x, ${wrap('https://example.com/a2.png', 2)} 2x" />
  </body></html>`;
  const out = await rewriteHtml({ html, originUrl: 'https://example.com/page', overlayId: 'ov1' });
  assert.match(out, /script src="\/proxy\?overlay=ov1&amp;url=https%3A%2F%2Fexample.com%2Fapp.js"/);
  assert.match(out, /link rel="stylesheet" href="\/proxy\?overlay=ov1&amp;url=https%3A%2F%2Fexample.com%2Fapp.css"/);
  assert.match(out, /img src="\/proxy\?overlay=ov1&amp;url=https%3A%2F%2Fexample.com%2Fimg.png"/);
  const $ = cheerio.load(out);
  const prox = (u) => `/proxy?overlay=ov1&url=${encodeURIComponent(u)}`;
  assert.equal(
    $('img[srcset]').attr('srcset'),
    `${prox('https://example.com/a1.png')} 1x, ${prox('https://example.com/a2.png')} 2x`
  );
});
