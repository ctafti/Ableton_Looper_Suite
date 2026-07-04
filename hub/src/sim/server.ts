/**
 * SIMULATOR SERVER — one process: serves the tablet skeleton over HTTP and
 * speaks Contract 3 over a WebSocket on the same port.
 *
 *   npm run sim                       # http://localhost:8420
 *   FAIL_RATE=0.2 npm run sim         # 20% of echoes "get lost" -> watch the
 *                                     # tablet's failed->revert path work
 *   TEMPO=92 QUANT=4 npm run sim
 *
 * Open the URL on your actual tablet (same LAN: http://<this-machine-ip>:8420)
 * — the skeleton is the real Phase-2 tablet shell, built against the frozen
 * protocol, so when the real hub exists the tablet just changes its URL.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { FakeLive } from './fake-live.ts';
import { WS_PROTOCOL_VERSION, type ControlMessage } from '../../../contracts/types/ws.ts';

const PORT = Number(process.env.PORT ?? 8420);
const TABLET_DIR = new URL('../../../tablet/', import.meta.url).pathname;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const http = createServer((req, res) => {
  const path = req.url === '/' || req.url === undefined ? '/index.html' : req.url.split('?')[0];
  const file = TABLET_DIR + path.replace(/^\//, '');
  if (!existsSync(file) || path.includes('..')) {
    res.writeHead(404).end('not found');
    return;
  }
  const ext = path.slice(path.lastIndexOf('.'));
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

const wss = new WebSocketServer({ server: http });

wss.on('connection', (ws) => {
  console.log('[sim] tablet connected');
  const sim = new FakeLive((msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }, {
    failRate: Number(process.env.FAIL_RATE ?? 0),
    tempoBpm: Number(process.env.TEMPO ?? 120),
    quantIndex: Number(process.env.QUANT ?? 4),
  });
  sim.start();

  ws.on('message', (raw) => {
    let msg: ControlMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.channel !== 'control') return;
    switch (msg.type) {
      case 'hello':
        if (msg.payload.protocol !== WS_PROTOCOL_VERSION) {
          console.log(`[sim] protocol mismatch: tablet=${msg.payload.protocol} sim=${WS_PROTOCOL_VERSION}`);
        }
        sim.sendSnapshot(); // Contract 3: reconnect => fresh snapshot
        return;
      case 'resync_request':
        console.log(`[sim] resync requested (tablet at rev ${msg.payload.haveRev})`);
        sim.sendSnapshot();
        return;
      case 'command':
        sim.handleCommand(msg.payload);
        return;
      default:
        return; // rtc_* signalling is Phase 8; relay is a no-op in the sim
    }
  });

  ws.on('close', () => {
    sim.stop();
    console.log('[sim] tablet disconnected');
  });
});

http.listen(PORT, () => {
  console.log(`[sim] fake Live up — open http://localhost:${PORT}  (tablet on the LAN: http://<this-ip>:${PORT})`);
  console.log(`[sim] FAIL_RATE=${process.env.FAIL_RATE ?? 0} TEMPO=${process.env.TEMPO ?? 120} QUANT=${process.env.QUANT ?? 4}`);
});
