#!/usr/bin/env node
/*
 * Static server for the simulator (useful to open it on a phone on the same
 * Wi-Fi). The simulator also works by opening simulator/index.html directly.
 *   node tools/serve_simulator.js [port] [--lan]
 * Without --lan it listens on 127.0.0.1 only.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'simulator');
const port = Number(process.argv.find(a => /^\d+$/.test(a)) || 8080);
const host = process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.normalize(path.join(root, url === '/' ? 'index.html' : url));
  if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('nao encontrado'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}).listen(port, host, () => console.log(`simulador em http://${host === '0.0.0.0' ? '<ip-do-computador>' : host}:${port}/`));
