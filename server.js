'use strict';
/**
 * FurqanCloud Speed Test server  (zero dependencies, Node 18+)
 *
 *   GET  /__down?bytes=N   streams N bytes of incompressible data (N=0 -> latency probe)
 *   POST /__up             reads and discards the body, returns { bytes }
 *   GET  /__ping           tiny "pong" reply
 *   GET  /meta             { clientIp, ipVersion, server, time }
 *   GET  /health           liveness check
 *   GET  /*                static files from ./public
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = process.env;
const CFG = {
  port: +env.PORT || 3000,
  host: env.HOST || '0.0.0.0',
  name: env.SERVER_NAME || 'FurqanCloud · Main',
  location: env.SERVER_LOCATION || '',
  origin: env.ALLOWED_ORIGIN || '*',                 // e.g. https://speed.furqancloud.com
  trustProxy: env.TRUST_PROXY === '1',               // set to 1 behind nginx / a load balancer
  maxDown: +env.MAX_DOWN_BYTES || 250e6,             // per request
  maxUp: +env.MAX_UP_BYTES || 100e6,                 // per request
  maxPerIp: +env.MAX_CONN_PER_IP || 12,              // concurrent transfers per client IP
  publicDir: path.join(__dirname, 'public')
};

// One random 1 MiB block, re-sent as many times as needed (random data defeats compression).
const BLOCK = crypto.randomBytes(1 << 20);
const active = new Map();                            // ip -> concurrent transfers

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain' };

function clientIp(req) {
  if (CFG.trustProxy) {
    const f = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (f) return f;
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CFG.origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Timing-Allow-Origin', '*');
}
function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Content-Encoding', 'identity');     // never compress test traffic
}
function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}

function take(ip) { const n = active.get(ip) || 0; if (n >= CFG.maxPerIp) return false; active.set(ip, n + 1); return true; }
function give(ip) { const n = (active.get(ip) || 1) - 1; n ? active.set(ip, n) : active.delete(ip); }

function download(req, res, url, ip) {
  let bytes = parseInt(url.searchParams.get('bytes'), 10);
  if (!Number.isFinite(bytes) || bytes < 0) bytes = 0;
  bytes = Math.min(bytes, CFG.maxDown);
  noStore(res);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes });
  if (!bytes || req.method === 'HEAD') return res.end();
  if (!take(ip)) { res.destroy(); return; }
  let left = bytes, done = false;
  const finish = () => { if (!done) { done = true; give(ip); } };
  res.on('close', finish);
  (function pump() {
    while (left > 0) {
      const n = Math.min(left, BLOCK.length);
      left -= n;
      if (!res.write(n === BLOCK.length ? BLOCK : BLOCK.subarray(0, n))) return res.once('drain', pump);
    }
    res.end(finish);
  })();
}

function upload(req, res, ip) {
  noStore(res);
  if (!take(ip)) { res.writeHead(429); return res.end(); }
  let got = 0, done = false;
  const finish = () => { if (!done) { done = true; give(ip); } };
  req.on('data', c => {
    got += c.length;
    if (got > CFG.maxUp) { res.writeHead(413); res.end(); req.destroy(); finish(); }
  });
  req.on('end', () => { finish(); if (!res.writableEnded) json(res, 200, { bytes: got }); });
  req.on('error', finish); req.on('close', finish);
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(CFG.publicDir, rel));
  if (!file.startsWith(CFG.publicDir + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x'), ip = clientIp(req);
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    switch (url.pathname) {
      case '/__down': return download(req, res, url, ip);
      case '/__up':   return req.method === 'POST' ? upload(req, res, ip) : (res.writeHead(405), res.end());
      case '/__ping':
      case '/ping':   noStore(res); res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 4 }); return res.end('pong');
      case '/meta':   noStore(res); return json(res, 200, { clientIp: ip, ipVersion: ip.includes(':') ? 6 : 4,
                        server: { name: CFG.name, location: CFG.location }, time: Date.now() });
      case '/health': return json(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    res.writeHead(405); res.end();
  } catch (e) { if (!res.headersSent) res.writeHead(400); res.end(); }
});

server.keepAliveTimeout = 65e3;
server.requestTimeout = 0;                           // uploads can run for many seconds
server.listen(CFG.port, CFG.host, () => console.log(`${CFG.name} listening on http://${CFG.host}:${CFG.port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
