import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';

import { cfg, discoverOverlayOrigins } from './server_utils.mjs';
import absPrefixProxy from './routes/absPrefixProxy.mjs';
import socketioProxy from './routes/socketioProxy.mjs';
import genericProxy from './routes/genericProxy.mjs';
import overlayRoutes from './routes/overlay.mjs';
import { installControlRoutes, requireControlAuth } from './controlBus.mjs';
import setupWsUpgrade from './wsUpgrade.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

try {
  await discoverOverlayOrigins();
} catch (err) {
  console.warn('[overlay-proxy] origin discovery failed', err);
}

const app = express();
app.disable('x-powered-by');
app.use(morgan('dev'));
app.use(compression());
app.use(cors({ origin: process.env.ORIGIN_ALLOW || '*' }));
app.use(express.json({ limit: '128kb' }));

if (!cfg.useCache) console.log('[overlay-proxy] cache disabled');

app.get('/config.json', (_req, res) => res.json(cfg));
app.get('/config.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`export default ${JSON.stringify(cfg)};`);
});

absPrefixProxy(app);
socketioProxy(app);
genericProxy(app);
overlayRoutes(app);
installControlRoutes(app);

app.post('/api/discover', requireControlAuth, async (_req, res) => {
  try {
    await discoverOverlayOrigins();
    res.json({ ok: true });
  } catch (err) {
    console.error('[overlay-proxy] origin discovery failed', err);
    res.status(500).json({ error: 'failed' });
  }
});

app.use(express.static(path.join(__dirname, '../public')));

app.use((_, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

const PORT = process.env.PORT || 4321;
const server = app.listen(PORT, () => console.log(`[overlay-proxy] http://localhost:${PORT}`));

setupWsUpgrade(server);
