import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

async function setupModule(){
  await fs.writeFile('/config.js', 'export default { overlays: [], canvas: { width: 0, height: 0 } };');
  const window = {
    location: new URL('http://app.test'),
    fetch: () => Promise.resolve(new Response('')),
    XMLHttpRequest: class {},
    WebSocket: class { constructor(){ setTimeout(() => this.onclose && this.onclose(), 0); } close(){} },
    performance: { now: () => 0 },
    console
  };
  global.window = window;
  global.location = window.location;
  global.performance = window.performance;
  class Req extends Request {
    constructor(input, init){
      if (typeof input === 'string' && !/^https?:/i.test(input)) input = new URL(input, window.location.origin).toString();
      super(input, init);
    }
  }
  global.Request = window.Request = Req;
  const rootEl = { style: {}, appendChild(){}, };
  global.document = {
    getElementById(){ return rootEl; },
    createElement(){ return { style: {}, setAttribute(){}, appendChild(){}, prepend(){}, remove(){}, querySelectorAll(){ return []; } }; }
  };
  window.overlayAPI = { register(){}, reload(){}, setVisible(){} };
  return await import('../public/compositor.mjs');
}

test('runScriptsSequentially executes scripts in order and restores state', async () => {
  const { runScriptsSequentially } = await setupModule();
  const calls = [];
  globalThis.calls = calls;
  global.fetch = async () => new Response('calls.push("b");');
  const scripts = [
    { textContent: 'calls.push("a");', remove(){ this.removed = true; } },
    { src: 'http://ext.test/b.js', remove(){ this.removed = true; } },
    { textContent: 'calls.push("c");', remove(){ this.removed = true; } }
  ];
  window.__ovActiveOverlay = 'prev';
  await runScriptsSequentially(scripts, 'ov1');
  assert.deepEqual(calls, ['a','b','c']);
  assert.ok(scripts.every(s => s.removed));
  assert.equal(window.__ovActiveOverlay, 'prev');
  assert.equal(window.__ovLastOverlay.id, 'ov1');
});
