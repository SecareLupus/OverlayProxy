import { test } from 'node:test';
import assert from 'node:assert';
import { WebSocketServer, WebSocket } from 'ws';
import { connectControlBus } from '../public/runtime-shims.mjs';

test('control bus reconnects after socket close', async () => {
  const port = 12345;
  let connections = 0;
  const wss = new WebSocketServer({ port, path: '/_control' });
  wss.on('connection', ws => {
    connections++;
    if (connections === 1) ws.close();
  });

  const window = {
    location: new URL(`http://localhost:${port}`),
    WebSocket,
    overlayAPI: { reload: () => {}, setVisible: () => {} },
  };

  const originalSetTimeout = global.setTimeout;
  const immediate = (fn) => { originalSetTimeout(fn, 0); return 0; };
  global.setTimeout = immediate;
  global.window = window;
  global.location = window.location;

  const stop = connectControlBus();
  await new Promise(r => originalSetTimeout(r, 50));

  assert.ok(connections >= 2);

  stop();
  wss.close();
  global.setTimeout = originalSetTimeout;
});
