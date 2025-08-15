import { WebSocketServer } from 'ws';
import crypto from 'crypto';

export const controlWss = new WebSocketServer({ noServer: true });
const controlClients = new Set();

controlWss.on('connection', (ws) => {
  controlClients.add(ws);
  ws.on('close', () => controlClients.delete(ws));
  ws.on('message', (data) => {
    // placeholder for future messages
  });
});

export const CONTROL_TOKEN = process.env.CONTROL_TOKEN || crypto.randomBytes(8).toString('hex');
console.log(`[overlay-proxy] CONTROL_TOKEN: ${CONTROL_TOKEN}`);

export function broadcast(msg) {
  const body = JSON.stringify(msg);
  for (const ws of controlClients) if (ws.readyState === ws.OPEN) ws.send(body);
}

export function requireControlAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || token !== CONTROL_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

export function installControlRoutes(app) {
  app.post('/api/control', requireControlAuth, (req, res) => {
    const msg = req.body || {};
    if (!msg.type) return res.status(400).json({ error: 'missing type' });
    broadcast(msg);
    res.json({ ok: true });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, clients: controlClients.size });
  });
}
