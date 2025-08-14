import { test } from 'node:test';
import assert from 'node:assert';
import { installRuntimeShims } from '../public/runtime-shims.mjs';

test('fetch and XHR shims tag same-origin and proxy cross-origin requests', async () => {
  const calls = [];
  const ORIGIN = 'http://app.test';

  const window = {
    location: new URL(ORIGIN),
    fetch: (input, init) => {
      const url = input instanceof Request ? input.url : new URL(String(input), ORIGIN).toString();
      calls.push(url);
      return Promise.resolve(new Response('ok'));
    },
    XMLHttpRequest: class {
      open(method, url){ calls.push(url); }
    },
    WebSocket: class {},
    __ovActiveOverlay: 'ov1',
    performance: { now: () => 0 },
  };

  global.window = window;
  global.location = window.location;
  global.performance = window.performance;
  class Req extends Request {
    constructor(input, init){
      if (typeof input === 'string' && !/^https?:/i.test(input)) input = new URL(input, ORIGIN).toString();
      super(input, init);
    }
  }
  global.Request = window.Request = Req;

  installRuntimeShims({});

  await window.fetch('http://app.test/socket.io/');
  await window.fetch('https://ext.test/data');

  const xhr = new window.XMLHttpRequest();
  xhr.open('GET', '/socket.io/data');

  assert.strictEqual(calls[0], 'http://app.test/socket.io/?overlay=ov1');
  assert.strictEqual(calls[1], 'http://app.test/proxy?overlay=ov1&url=https%3A%2F%2Fext.test%2Fdata');
  assert.strictEqual(calls[2], 'http://app.test/socket.io/data?overlay=ov1');
});
